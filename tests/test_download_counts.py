import io
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.core.management import call_command
from django.db import connections
from django.http import HttpResponseRedirect
from django.test import RequestFactory, SimpleTestCase, TestCase, TransactionTestCase, override_settings, skipUnlessDBFeature
from django.utils import timezone
from rest_framework.test import APIClient

from hub.download_counts import count_download
from hub.models import APIKey, ContentType, DownloadIP, DownloadUser, Item, Release


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, TRUST_PROXY=True, TRUSTED_PROXY_CIDRS=["10.89.0.0/24"])
class DownloadCountTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("count-author")
        cls.reader = get_user_model().objects.create_user("count-reader")
        cls.item = Item.objects.create(author=cls.author, content_type=ContentType.objects.get(slug="blueprints"), title="Download test")
        cls.release = Release.objects.create(item=cls.item, version="1", file="releases/test.json", original_filename="test.json", size=2)

    def setUp(self):
        self.api = APIClient()
        delivery = patch("hub.api.file_response", side_effect=lambda *args, **kwargs: HttpResponseRedirect("https://storage.example/file"))
        self.delivery = delivery.start()
        self.addCleanup(delivery.stop)

    def download(self, address="198.51.100.1", *, release=None, method="get", **headers):
        release = release or self.release
        return getattr(self.api, method)(
            f"/api/v1/items/{release.item_id}/releases/{release.pk}/download/", REMOTE_ADDR=address, **headers,
        )

    def assert_counts(self, item_count, release_count=None):
        self.item.refresh_from_db()
        self.release.refresh_from_db()
        self.assertEqual(self.item.downloads, item_count)
        self.assertEqual(self.release.downloads, item_count if release_count is None else release_count)

    def test_repeats_and_spoofed_headers_do_not_inflate_counts(self):
        for forged in ["203.0.113.1", "203.0.113.2", "203.0.113.3"]:
            self.assertEqual(self.download(HTTP_X_REAL_IP=forged, HTTP_CF_CONNECTING_IP=forged,
                                           HTTP_X_FORWARDED_FOR=forged).status_code, 302)
        self.assert_counts(1)
        self.download("198.51.100.2")
        self.assert_counts(2)

    def test_ipv6_uses_32_subnets_and_mapped_ipv4_uses_exact_address(self):
        for address in ["2001:db8:1234::1", "2001:0db8:ffff:ffff::abcd", "2001:db9::1"]:
            self.download("10.89.0.7", HTTP_X_REAL_IP=address)
        self.assert_counts(2)
        self.assertEqual(set(DownloadIP.objects.values_list("network", flat=True)), {"2001:db8::/32", "2001:db9::/32"})
        self.download("::ffff:198.51.100.1")
        self.download("198.51.100.1")
        self.download("198.51.100.2")
        self.assert_counts(4)

    def test_account_and_ip_each_suppress_and_remember_other_identity(self):
        self.download()  # Anonymous first, then sign in on the same address.
        self.api.force_login(self.reader)
        self.download()
        self.download("198.51.100.2")  # Account survives a change of address.
        self.api.logout()
        self.download("198.51.100.2")  # Signing out does not create a count.
        self.api.force_login(self.author)
        self.download("198.51.100.2")  # Nor does switching accounts on the same IP.
        self.download("198.51.100.3")
        self.assert_counts(1)
        self.assertEqual(DownloadUser.objects.count(), 4)

    def test_api_keys_share_the_accounts_browser_identity(self):
        self.api.force_login(self.reader)
        self.download()
        self.api.logout()
        for index in range(2):
            _, raw = APIKey.issue(user=self.reader, name=f"Manager {index}", scopes=["read"])
            self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + raw)
            self.download(f"198.51.100.{index + 2}")
        self.assert_counts(1)

    def test_new_versions_count_separately_without_recounting_the_creation(self):
        second = Release.objects.create(item=self.item, version="2", file="releases/second.json", size=2)
        self.api.force_login(self.reader)
        self.download()
        self.download(release=second)
        self.download("198.51.100.2", release=second)
        self.assert_counts(1)
        second.refresh_from_db()
        self.assertEqual(second.downloads, 1)
        other = Item.objects.create(author=self.author, content_type=self.item.content_type, title="Another creation")
        third = Release.objects.create(item=other, version="1", file="releases/third.json", size=2)
        self.download(release=third)
        other.refresh_from_db()
        self.assertEqual(other.downloads, 1)

    def test_ip_expiry_is_exact_and_account_markers_survive(self):
        start = timezone.now()
        with patch("hub.download_counts.timezone.now", return_value=start):
            self.download()
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=14)):
            self.download()
        self.assert_counts(2)
        # Simulated dates go beyond a browser session's own expiration.
        self.api.force_authenticate(self.reader)
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=15)):
            self.download()
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=30)):
            self.download("198.51.100.99")
        self.assert_counts(2)

    def test_repeats_extend_retention_and_cleanup_deletes_expired_ips_only(self):
        start = timezone.now()
        self.api.force_login(self.reader)
        with patch("hub.download_counts.timezone.now", return_value=start):
            self.download()
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=1)):
            self.download()
        self.assertEqual(set(DownloadIP.objects.values_list("expires_at", flat=True)), {start + timedelta(days=15)})
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=14)):
            call_command("cleanup_deleted_files", stdout=io.StringIO())
        self.assertEqual(DownloadIP.objects.count(), 2)
        with patch("hub.download_counts.timezone.now", return_value=start + timedelta(days=15)):
            call_command("cleanup_deleted_files", stdout=io.StringIO())
        self.assertFalse(DownloadIP.objects.exists())
        self.assertEqual(DownloadUser.objects.count(), 2)
        self.assert_counts(1)

    def test_head_denied_and_failed_downloads_leave_no_markers(self):
        from hub.file_delivery import StorageUnavailable
        self.assertEqual(self.download(method="head").status_code, 302)
        self.delivery.side_effect = StorageUnavailable()
        self.assertEqual(self.download().status_code, 503)
        self.item.status = Item.Status.DRAFT
        self.item.save(update_fields=["status"])
        self.assertEqual(self.download().status_code, 404)
        self.assert_counts(0)
        self.assertFalse(DownloadIP.objects.exists())
        self.assertFalse(DownloadUser.objects.exists())

    def test_unknown_proxy_ip_cannot_count_anonymous_downloads(self):
        for address in ["", "invalid", "198.51.100.1, 198.51.100.2"]:
            self.assertEqual(self.download("10.89.0.7", HTTP_X_REAL_IP=address).status_code, 302)
        self.assert_counts(0)
        self.api.force_login(self.reader)
        self.download("10.89.0.7", HTTP_X_REAL_IP="invalid")
        self.assert_counts(1)
        self.assertFalse(DownloadIP.objects.exists())

    def test_account_and_creation_deletions_remove_their_markers(self):
        self.api.force_login(self.reader)
        self.download()
        self.reader.delete()
        self.assertFalse(DownloadUser.objects.exists())
        self.assert_counts(1)
        self.item.delete()
        self.assertFalse(DownloadIP.objects.exists())


class DownloadLogTests(SimpleTestCase):
    def test_download_access_logs_omit_client_ips(self):
        from gunicorn.config import Config
        from hub.access_logging import DownloadPrivacyLogger
        logger = DownloadPrivacyLogger(Config())
        response = SimpleNamespace(status="302 Found", sent=0, headers=[])
        for path, expected in [
            ("/items/item/releases/release/download/", "-"),
            ("/api/v1/items/item/releases/release/download/", "-"),
            ("/upload/", "198.51.100.1"),
        ]:
            with self.subTest(path=path):
                environ = {"REMOTE_ADDR": "198.51.100.1", "REQUEST_METHOD": "GET", "PATH_INFO": path, "RAW_URI": path, "SERVER_PROTOCOL": "HTTP/1.1"}
                atoms = logger.atoms(response, [], environ, timedelta(seconds=1))
                self.assertEqual(atoms["h"], expected)


class ConcurrentDownloadTests(TransactionTestCase):
    @skipUnlessDBFeature("has_select_for_update")
    def test_simultaneous_downloads_cannot_overcount(self):
        reader = get_user_model().objects.create_user("concurrent-reader")
        category = ContentType.objects.create(name="Concurrent blueprint", slug="concurrent-blueprint")
        for signed_in in (False, True):
            with self.subTest(signed_in=signed_in):
                item = Item.objects.create(author=reader, content_type=category, title="Concurrent download")
                release = Release.objects.create(item=item, version="1", file="releases/concurrent.json", size=2)
                gate = Barrier(6)

                def download(index):
                    try:
                        request = RequestFactory().get("/", REMOTE_ADDR=f"198.51.100.{index + 1}" if signed_in else "198.51.100.1")
                        request.user = reader if signed_in else AnonymousUser()
                        gate.wait(timeout=10)
                        count_download(request, release)
                    finally:
                        connections.close_all()

                with ThreadPoolExecutor(max_workers=6) as pool:
                    list(pool.map(download, range(6)))
                item.refresh_from_db()
                release.refresh_from_db()
                self.assertEqual((item.downloads, release.downloads), (1, 1))
