import tempfile
import time
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from hub.download_warning import COOKIE_MAX_AGE, COOKIE_NAME, WARNING_VERSION
from hub.models import ContentType, Item, Release, UserPreferences


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class DownloadWarningTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.media = override_settings(MEDIA_ROOT=self.directory.name)
        self.media.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.media.disable)
        self.author = get_user_model().objects.create_user("creator")
        self.reader = get_user_model().objects.create_user("reader")
        self.item = Item.objects.create(author=self.author, content_type=ContentType.objects.get(slug="blueprints"),
                                        title="Community blueprint", summary="A parking layout", description="Fan creation")
        self.release = Release.objects.create(item=self.item, version="1", file=ContentFile(b"{}", name="blueprint.json"),
                                               original_filename="blueprint.json", size=2, sha256="a" * 64)
        self.url = reverse("item-download", args=[self.item.pk, self.release.pk])
        self.api_url = reverse("api-item-download", kwargs={"pk": self.item.pk, "release_id": self.release.pk})
        self.reset_url = reverse("download-warning-reset")

    def test_website_links_show_warning_before_issuing_download(self):
        detail = self.client.get(self.item.get_absolute_url())
        self.assertContains(detail, f'href="{self.url}"', count=2)
        self.assertContains(detail, 'id="download-warning"')
        self.assertNotContains(detail, f'href="{self.api_url}"')
        response = self.client.get(self.url)
        self.assertContains(response, "user-generated content (UGC) made by fans")
        self.assertContains(response, "not affiliated with or endorsed by")
        self.assertContains(response, "Don’t show this again.")
        self.assertIn("no-store", response["Cache-Control"])
        self.item.refresh_from_db()
        self.release.refresh_from_db()
        self.assertEqual(self.item.downloads, 0)
        self.assertEqual(self.release.downloads, 0)

    def test_continue_without_remembering_downloads_once_and_warns_again(self):
        self.client.force_login(self.reader)
        response = self.client.post(self.url, {})
        self.assertRedirects(response, self.api_url, fetch_redirect_response=False)
        self.assertNotIn(COOKIE_NAME, response.cookies)
        self.assertFalse(UserPreferences.objects.exists())
        download = self.client.get(response["Location"])
        self.assertEqual(download.status_code, 200)
        self.assertEqual(b"".join(download.streaming_content), b"{}")
        self.item.refresh_from_db()
        self.assertEqual(self.item.downloads, 1)
        self.assertEqual(self.client.get(self.url).status_code, 200)

    @override_settings(SESSION_COOKIE_SECURE=True)
    def test_guest_checkbox_saves_signed_cookie_and_json_download_target(self):
        response = self.client.post(self.url, {"remember": "on"}, HTTP_ACCEPT="application/json", secure=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"download_url": self.api_url, "remembered": True})
        cookie = response.cookies[COOKIE_NAME]
        self.assertTrue(cookie["secure"])
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertEqual(cookie["max-age"], COOKIE_MAX_AGE)
        self.assertNotEqual(cookie.value, str(WARNING_VERSION))
        self.assertFalse(UserPreferences.objects.exists())
        self.assertRedirects(self.client.get(self.url, secure=True), self.api_url, fetch_redirect_response=False)
        self.assertNotContains(self.client.get(self.item.get_absolute_url(), secure=True), 'id="download-warning"')

    def test_profile_remembers_choice_on_another_device(self):
        self.client.force_login(self.reader)
        self.client.post(self.url, {"remember": "on"})
        preferences = UserPreferences.objects.get(user=self.reader)
        self.assertEqual(preferences.ugc_warning_version, WARNING_VERSION)
        self.assertIsNotNone(preferences.ugc_warning_acknowledged_at)
        fresh = Client()
        fresh.force_login(self.reader)
        response = fresh.get(self.url)
        self.assertRedirects(response, self.api_url, fetch_redirect_response=False)
        self.assertIn(COOKIE_NAME, response.cookies)
        self.assertContains(fresh.get(reverse("profile")), "Show the warning again")
        stranger = Client()
        stranger.force_login(self.author)
        self.assertEqual(stranger.get(self.url).status_code, 200)

    def test_guest_choice_is_carried_into_profile_after_sign_in(self):
        self.client.post(self.url, {"remember": "on"})
        self.client.force_login(self.reader)
        self.assertRedirects(self.client.get(self.url), self.api_url, fetch_redirect_response=False)
        self.assertEqual(UserPreferences.objects.get(user=self.reader).ugc_warning_version, WARNING_VERSION)

    def test_profile_reset_overrides_old_cookies_on_other_devices(self):
        self.client.force_login(self.reader)
        accepted = self.client.post(self.url, {"remember": "on"})
        other = Client()
        other.force_login(self.reader)
        other.cookies[COOKIE_NAME] = accepted.cookies[COOKIE_NAME].value
        self.assertEqual(self.client.get(self.reset_url).status_code, 405)
        response = self.client.post(self.reset_url)
        self.assertRedirects(response, reverse("profile"))
        self.assertEqual(response.cookies[COOKIE_NAME]["max-age"], 0)
        self.assertEqual(UserPreferences.objects.get(user=self.reader).ugc_warning_version, 0)
        self.assertEqual(other.get(self.url).status_code, 200)

    def test_invalid_expired_and_older_version_choices_do_not_skip_warning(self):
        self.client.cookies[COOKIE_NAME] = "forged-choice"
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self.client.post(self.url, {"remember": "on"})
        with patch("django.core.signing.time.time", return_value=time.time() + COOKIE_MAX_AGE + 10):
            self.assertEqual(self.client.get(self.url).status_code, 200)
        self.client.force_login(self.reader)
        self.client.post(self.url, {"remember": "on"})
        with patch("hub.download_warning.WARNING_VERSION", WARNING_VERSION + 1):
            self.assertEqual(self.client.get(self.url).status_code, 200)

    def test_drafts_and_mismatched_releases_remain_private(self):
        self.item.status = Item.Status.DRAFT
        self.item.save(update_fields=["status"])
        for method in [self.client.get, self.client.post]:
            self.assertEqual(method(self.url, {"remember": "on"}).status_code, 404)
        self.assertNotIn(COOKIE_NAME, self.client.cookies)
        self.client.force_login(self.reader)
        self.assertEqual(self.client.post(self.url, {"remember": "on"}).status_code, 404)
        self.assertFalse(UserPreferences.objects.exists())
        self.client.force_login(self.author)
        self.assertEqual(self.client.get(self.url).status_code, 200)
        unrelated = Item.objects.create(author=self.author, content_type=self.item.content_type, title="Other", summary="Other", description="Other")
        wrong = reverse("item-download", args=[unrelated.pk, self.release.pk])
        self.assertEqual(self.client.post(wrong, {"remember": "on"}).status_code, 404)

    def test_confirmation_and_profile_reset_require_csrf(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.reader)
        client.get(self.url)
        self.assertEqual(client.post(self.url, {"remember": "on"}, HTTP_ACCEPT="application/json").status_code, 403)
        self.assertFalse(UserPreferences.objects.exists())
        token = client.cookies["csrftoken"].value
        self.assertEqual(client.post(self.url, {"remember": "on"}, HTTP_X_CSRFTOKEN=token, HTTP_ACCEPT="application/json").status_code, 200)
        self.assertEqual(client.post(self.reset_url).status_code, 403)
        self.assertEqual(UserPreferences.objects.get(user=self.reader).ugc_warning_version, WARNING_VERSION)

    def test_api_download_contract_does_not_return_html_to_mod_managers(self):
        response = self.client.get(self.api_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/octet-stream")
        self.assertEqual(b"".join(response.streaming_content), b"{}")
