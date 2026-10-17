import io
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from unittest.mock import patch

from botocore.exceptions import ClientError
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management import call_command
from django.db import connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings, skipUnlessDBFeature
from django.utils import timezone
from oauth2_provider.models import AccessToken, Application
from rest_framework.test import APIClient

from hub.models import APIKey, ContentType, Item, Release, UploadEvent
from hub.services import _save_release, add_release, record_revision
from hub.upload_limits import UploadLimitExceeded
from tests.test_hub import package, screenshot


LOCAL_STORAGE = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}


@override_settings(ASYNC_UPLOAD_VALIDATION=False, DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES=LOCAL_STORAGE)
class UploadLimitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("limited-uploader")
        cls.category = ContentType.objects.get(slug="blueprints")
        cls.item = Item.objects.create(author=cls.author, content_type=cls.category, title="Upload limit", status="draft")

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        media = override_settings(MEDIA_ROOT=directory.name)
        media.enable()
        self.addCleanup(directory.cleanup)
        self.addCleanup(media.disable)
        self.api = APIClient()
        self.api.force_login(self.author)
        self.client.force_login(self.author)

    def fill_quota(self, count=16, *, user=None, when=None):
        UploadEvent.objects.bulk_create([
            UploadEvent(user=user or self.author, created_at=when or timezone.now()) for _ in range(count)
        ])

    def release(self, version="1", *, item=None):
        return self.api.post(f"/api/v1/items/{(item or self.item).pk}/releases/", {"file": package(), "version": version}, format="multipart")

    def creation(self):
        return self.client.post("/upload/", {
            "title": "A new lot", "content_type": self.category.pk, "summary": "A small lot", "description": "A small parking lot.",
            "status": "published", "version": "1", "file": package(), "screenshots": [screenshot()],
        })

    def test_sixteenth_upload_succeeds_and_seventeenth_shares_limit_across_keys(self):
        self.fill_quota(15)
        self.assertEqual(self.release().status_code, 201)
        self.assertEqual(UploadEvent.objects.filter(user=self.author).count(), 16)
        self.api.logout()
        for index in range(2):
            _, raw = APIKey.issue(user=self.author, name=f"Uploader {index}", scopes=["write"])
            self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + raw)
            response = self.release(str(index + 2))
            self.assertEqual(response.status_code, 429)
            self.assertGreater(int(response["Retry-After"]), 3500)
            self.assertContains(response, "16 uploads per hour", status_code=429)
        self.assertEqual(self.item.releases.count(), 1)
        app = Application.objects.create(user=self.author, name="Upload manager", client_type="public", authorization_grant_type="authorization-code")
        token = AccessToken.objects.create(user=self.author, application=app, token="upload-limit-test-token", scope="write", expires=timezone.now() + timedelta(minutes=5))
        self.api.credentials(HTTP_AUTHORIZATION="Bearer " + token.token)
        self.assertEqual(self.release("oauth-upload").status_code, 429)

    def test_accounts_have_independent_allowances(self):
        self.fill_quota()
        other = get_user_model().objects.create_user("another-uploader")
        item = Item.objects.create(author=other, content_type=self.category, title="Other lot", status="draft")
        self.api.force_login(other)
        self.assertEqual(self.release(item=item).status_code, 201)
        self.assertEqual(other.upload_events.count(), 1)

    def test_web_creation_uses_one_slot_including_its_screenshot(self):
        self.fill_quota(15)
        self.assertEqual(self.creation().status_code, 302)
        self.assertEqual(self.author.upload_events.count(), 16)
        self.assertEqual(Item.objects.get(title="A new lot").screenshots.count(), 1)
        with patch("django.core.files.storage.FileSystemStorage.save") as save:
            response = self.creation()
        self.assertContains(response, "16 uploads per hour", status_code=429)
        self.assertIn("Retry-After", response)
        save.assert_not_called()
        self.assertEqual(Item.objects.filter(title="A new lot").count(), 1)

    def test_web_release_is_limited_but_metadata_and_screenshots_are_not(self):
        self.fill_quota()
        response = self.client.post(f"/items/{self.item.pk}/edit/", {"action": "release", "file": package(), "version": "1"})
        self.assertContains(response, "16 uploads per hour", status_code=429)
        self.assertIn("Retry-After", response)
        base = f"/api/v1/items/{self.item.pk}/"
        self.assertEqual(self.api.patch(base, {"title": "Edited lot"}, format="json").status_code, 200)
        self.assertEqual(self.api.post(base + "screenshots/", {"image": screenshot()}, format="multipart").status_code, 201)
        self.assertEqual(self.author.upload_events.count(), 16)

    def test_invalid_duplicate_and_failed_storage_uploads_do_not_use_slots(self):
        self.assertEqual(self.api.post(f"/api/v1/items/{self.item.pk}/releases/", {
            "file": package(data=b""), "version": "empty-file",
        }, format="multipart").status_code, 400)
        self.assertFalse(UploadEvent.objects.exists())
        self.assertEqual(self.release().status_code, 201)
        self.assertEqual(self.release().status_code, 400)
        failure = ClientError({"Error": {"Code": "AccessDenied", "Message": "Storage failure"}}, "PutObject")
        with patch("django.core.files.storage.FileSystemStorage.save", side_effect=failure):
            self.assertEqual(self.release("2").status_code, 503)
        self.assertEqual(self.author.upload_events.count(), 1)
        self.assertEqual(self.item.releases.count(), 1)

    def test_rolling_hour_boundary_retry_after_and_cleanup(self):
        now = timezone.now()
        self.fill_quota(when=now - timedelta(hours=1) + timedelta(seconds=1))
        with patch("hub.upload_limits.timezone.now", return_value=now):
            response = self.release()
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response["Retry-After"], "1")
        with patch("hub.upload_limits.timezone.now", return_value=now + timedelta(seconds=1)):
            self.assertEqual(self.release().status_code, 201)
            call_command("cleanup_deleted_files", stdout=io.StringIO())
        self.assertEqual(self.author.upload_events.count(), 1)

    def test_deleting_a_creation_does_not_reset_quota(self):
        self.fill_quota(15)
        self.assertEqual(self.release().status_code, 201)
        self.item.delete()
        item = Item.objects.create(author=self.author, content_type=self.category, title="Replacement", status="draft")
        self.assertEqual(self.release(item=item).status_code, 429)

    def test_all_staff_roles_are_exempt_with_sessions_and_api_keys(self):
        for role in ["Admin", "Moderator", "Reviewer"]:
            with self.subTest(role=role):
                staff = get_user_model().objects.create_user(f"staff-{role}")
                staff.groups.add(Group.objects.get(name=role))
                self.fill_quota(user=staff)
                item = Item.objects.create(author=staff, content_type=self.category, title=role, status="draft")
                self.api.credentials()
                self.api.force_login(staff)
                self.assertEqual(self.release(item=item).status_code, 201)
                self.api.logout()
                _, raw = APIKey.issue(user=staff, name="Staff manager", scopes=["write"])
                self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + raw)
                self.assertEqual(self.release("2", item=item).status_code, 201)
                self.assertEqual(staff.upload_events.count(), 16)


@override_settings(ASYNC_UPLOAD_VALIDATION=False, STORAGES=LOCAL_STORAGE)
class ConcurrentUploadTests(TransactionTestCase):
    @skipUnlessDBFeature("has_select_for_no_key_update")
    def test_simultaneous_edit_and_upload_do_not_deadlock(self):
        user = get_user_model().objects.create_user("editing-uploader")
        category = ContentType.objects.create(name="Editing", slug="editing-concurrency", uploads_enabled=True, allowed_extensions=[".cpbp"])
        item = Item.objects.create(author=user, content_type=category, title="Before", status="draft")
        item_locked, upload_reserved = Event(), Event()

        def edit():
            try:
                with transaction.atomic():
                    edited = Item.objects.select_for_update().get(pk=item.pk)
                    item_locked.set()
                    self.assertTrue(upload_reserved.wait(timeout=10))
                    edited.title = "After"
                    edited.save(update_fields=["title"])
                    record_revision(edited, user)
            finally:
                connections.close_all()

        def save_release(*args, **kwargs):
            upload_reserved.set()
            self.assertTrue(item_locked.wait(timeout=10))
            return _save_release(*args, **kwargs)

        def upload():
            try:
                add_release(item, file=package(), version="1")
            finally:
                connections.close_all()

        with tempfile.TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=directory), patch("hub.services._save_release", side_effect=save_release), ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(edit), pool.submit(upload)]
            for job in jobs:
                job.result(timeout=20)
        item.refresh_from_db()
        self.assertEqual(item.title, "After")
        self.assertEqual(item.releases.count(), 1)
        self.assertEqual(user.upload_events.count(), 1)

    @skipUnlessDBFeature("has_select_for_update")
    def test_parallel_uploads_share_the_last_account_slot(self):
        user = get_user_model().objects.create_user("concurrent-uploader")
        category = ContentType.objects.create(name="Concurrency", slug="upload-concurrency", uploads_enabled=True, allowed_extensions=[".cpbp"])
        items = [Item.objects.create(author=user, content_type=category, title=f"Upload {index}", status="draft") for index in range(4)]
        UploadEvent.objects.bulk_create([UploadEvent(user=user) for _ in range(15)])
        gate = Barrier(4)

        def upload(item):
            try:
                gate.wait(timeout=10)
                add_release(item, file=package(), version="1")
                return True
            except UploadLimitExceeded:
                return False
            finally:
                connections.close_all()

        with tempfile.TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=directory), ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(upload, items))
        self.assertEqual(results.count(True), 1)
        self.assertEqual(Release.objects.filter(item__in=items).count(), 1)
        self.assertEqual(user.upload_events.count(), 16)
