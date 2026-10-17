import tempfile

from allauth.core.internal.httpkit import get_client_ip
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient
from rest_framework.throttling import BaseThrottle

from hub.activity import record_activity
from hub.client_ip import TrustedProxyMiddleware
from hub.models import APIKey, AccountActivity, ContentType
from hub.moderation_services import delete_user
from tests.test_hub import package, screenshot


@override_settings(ASYNC_UPLOAD_VALIDATION=False, TRUST_PROXY=True, TRUSTED_PROXY_CIDRS=["10.89.0.0/24", "2001:db8:1::/64"])
class ClientIPTests(SimpleTestCase):
    def request(self, peer, forwarded, **headers):
        request = RequestFactory().get("/", REMOTE_ADDR=peer, HTTP_X_REAL_IP=forwarded, **headers)
        TrustedProxyMiddleware(lambda request: HttpResponse())(request)
        return request

    def test_untrusted_peers_cannot_spoof_address_or_https(self):
        for peer in ["203.0.113.20", "2001:db8:2::20"]:
            request = self.request(peer, "198.51.100.1", HTTP_X_FORWARDED_FOR="198.51.100.2",
                                   HTTP_CF_CONNECTING_IP="198.51.100.3", HTTP_X_FORWARDED_PROTO="https")
            self.assertEqual(request.client_ip, peer)
            self.assertEqual(request.client_ip_source, "direct")
            self.assertEqual(get_client_ip(request), peer)
            self.assertEqual(BaseThrottle().get_ident(request), peer)
            self.assertNotIn("HTTP_X_FORWARDED_PROTO", request.META)

    def test_trusted_proxy_supplies_one_canonical_address(self):
        for peer, supplied, expected in [("10.89.0.7", "203.0.113.10", "203.0.113.10"),
                                         ("2001:db8:1::7", "2001:db8:abcd::1", "2001:db8:abcd::1"),
                                         ("::ffff:10.89.0.7", "::ffff:203.0.113.10", "203.0.113.10")]:
            request = self.request(peer, supplied, HTTP_X_FORWARDED_FOR="198.51.100.2", HTTP_X_FORWARDED_PROTO="https")
            self.assertEqual(request.client_ip, expected)
            self.assertEqual(request.client_ip_source, "proxy")
            self.assertEqual(request.META["REMOTE_ADDR"], expected)
            self.assertEqual(get_client_ip(request), expected)
            self.assertEqual(BaseThrottle().get_ident(request), expected)
            self.assertEqual(request.META["HTTP_X_FORWARDED_PROTO"], "https")

    def test_invalid_or_missing_proxy_ip_is_not_recorded_as_a_visitor(self):
        for value in ["", "not-an-ip", "203.0.113.1, 198.51.100.2", "fe80::1%eth0", "203.0.113.1:123"]:
            request = self.request("10.89.0.7", value)
            self.assertIsNone(request.client_ip)
            self.assertEqual(request.client_ip_source, "unknown")

    @override_settings(ASYNC_UPLOAD_VALIDATION=False, TRUST_PROXY=False)
    def test_proxy_trust_is_off_by_default(self):
        request = self.request("10.89.0.7", "203.0.113.10")
        self.assertEqual(request.client_ip, "10.89.0.7")
        self.assertFalse(request.trusted_proxy)


@override_settings(ASYNC_UPLOAD_VALIDATION=False, DEBUG=True, SECURE_SSL_REDIRECT=False, TRUST_PROXY=True, TRUSTED_PROXY_CIDRS=["10.89.0.0/24"],
                   STORAGES={"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
                             "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}})
class ActivityTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        media = override_settings(MEDIA_ROOT=self.directory.name)
        media.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(media.disable)
        self.author = get_user_model().objects.create_user("Uploader")
        self.admin = get_user_model().objects.create_superuser("Admin", password=None)
        self.category = ContentType.objects.get(slug="blueprints")
        self.api = APIClient()
        self.headers = {"REMOTE_ADDR": "10.89.0.7", "HTTP_X_REAL_IP": "203.0.113.10",
                        "HTTP_USER_AGENT": "TestBrowser/1.0 (TestOS)", "HTTP_ACCEPT_LANGUAGE": "en-US,en;q=0.9",
                        "HTTP_CF_RAY": "0123456789abcdef-IAD"}

    def test_web_upload_records_success_only_and_does_not_copy_secrets(self):
        self.client.force_login(self.author)
        metadata = {"title": "Recorded lot", "summary": "A lot", "description": "A parking blueprint",
                    "content_type": self.category.pk, "status": "published", "version": "1"}
        self.assertEqual(self.client.post("/upload/", metadata, **self.headers).status_code, 200)
        self.assertFalse(AccountActivity.objects.exists())
        response = self.client.post("/upload/?code=never-store-this", {
            **metadata, "file": package(), "screenshots": [screenshot(), screenshot("second.png")],
        }, HTTP_AUTHORIZATION="never-store-this", **self.headers)
        self.assertEqual(response.status_code, 302)
        event = AccountActivity.objects.get()
        self.assertEqual((event.action, event.user, event.item.title), ("create", self.author, "Recorded lot"))
        self.assertEqual(event.ip_address, "203.0.113.10")
        self.assertEqual(event.ip_source, "proxy")
        self.assertEqual(event.user_agent, self.headers["HTTP_USER_AGENT"])
        self.assertEqual(event.accept_language, self.headers["HTTP_ACCEPT_LANGUAGE"])
        self.assertEqual(event.cf_ray, self.headers["HTTP_CF_RAY"])
        self.assertEqual(event.request_path, "/upload/")
        self.assertNotIn("never-store-this", str(event.__dict__))

    def test_api_key_creation_files_and_publication_record_actor(self):
        key, raw = APIKey.issue(user=self.author, name="Manager", scopes=["read", "write"])
        self.api.credentials(HTTP_AUTHORIZATION=f"ApiKey {raw}")
        response = self.api.post("/api/v1/items/", {"title": "API lot", "summary": "Lot", "description": "Lot", "content_type": "blueprints"}, format="json", **self.headers)
        self.assertEqual(response.status_code, 201, response.data)
        url = f'/api/v1/items/{response.data["id"]}/'
        self.assertEqual(self.api.post(url + "releases/", {"version": "1", "file": package()}, format="multipart", **self.headers).status_code, 201)
        for index in range(2):
            self.assertEqual(self.api.post(url + "screenshots/", {"image": screenshot(f"{index}.png")}, format="multipart", **self.headers).status_code, 201)
        self.assertEqual(self.api.patch(url, {"status": "published"}, format="json", **self.headers).status_code, 200)
        self.assertEqual(list(AccountActivity.objects.order_by("pk").values_list("action", flat=True)), ["create", "release", "screenshot", "screenshot", "publish"])
        self.assertEqual(AccountActivity.objects.filter(user=self.author, auth_method="api_key", ip_address="203.0.113.10").count(), 5)
        self.assertNotIn(raw, str(list(AccountActivity.objects.values())))
        public = self.client.get(url)
        self.assertNotContains(public, "203.0.113.10")
        self.assertNotContains(public, "TestBrowser")

    def test_admin_only_history_filters_and_account_purge(self):
        request = RequestFactory().get("/upload/", **self.headers)
        request.user = self.author
        TrustedProxyMiddleware(lambda request: HttpResponse())(request)
        record_activity(request, AccountActivity.Action.CREATE)
        url = "/moderation/activity/"
        self.assertEqual(self.client.get(url).status_code, 302)
        for role in ["", "Reviewer", "Moderator", "Admin"]:
            viewer = get_user_model().objects.create_user(f"Viewer{role}")
            if role:
                viewer.groups.add(Group.objects.get(name=role))
            self.client.force_login(viewer)
            self.assertEqual(self.client.get(url).status_code, 200 if role == "Admin" else 403)
        self.client.force_login(self.admin)
        response = self.client.get(url, {"ip": "::ffff:203.0.113.10", "username": "Uploader"})
        self.assertContains(response, "TestBrowser")
        self.assertEqual(response.context["page_obj"].paginator.count, 1)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(self.client.get(url, {"ip": "invalid"}).context["page_obj"].paginator.count, 0)
        self.assertEqual(self.client.get(url, {"user": self.admin.pk}).context["page_obj"].paginator.count, 0)
        delete_user(self.admin, self.author, reason="Remove test account")
        self.assertFalse(AccountActivity.objects.exists())

    def test_untrusted_headers_are_not_promoted_and_browser_text_is_bounded(self):
        request = RequestFactory().get("/upload/", REMOTE_ADDR="198.51.100.20", HTTP_X_REAL_IP="203.0.113.10",
                                       HTTP_CF_RAY="0123456789abcdef-IAD", HTTP_USER_AGENT="x" * 2000 + "\x00")
        request.user = self.author
        TrustedProxyMiddleware(lambda request: HttpResponse())(request)
        event = record_activity(request, AccountActivity.Action.CREATE)
        self.assertEqual(event.ip_address, "198.51.100.20")
        self.assertEqual(event.cf_ray, "")
        self.assertEqual(len(event.user_agent), 1024)
