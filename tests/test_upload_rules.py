import tempfile
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import BotoCoreError
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from hub.models import ContentType, Item, Release, Screenshot, UploadEvent
from tests.test_hub import package, screenshot


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class UploadRulesTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.media = override_settings(MEDIA_ROOT=self.directory.name)
        self.media.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.media.disable)
        self.author = get_user_model().objects.create_user("uploader")
        self.client.force_login(self.author)
        self.api = APIClient()
        self.api.force_login(self.author)
        self.blueprints = ContentType.objects.get(slug="blueprints")
        self.metadata = {"title": "A new blueprint", "summary": "Parking layout", "description": "Test creation", "content_type": self.blueprints.pk, "status": "published"}

    def web_upload(self, images, **changes):
        return self.client.post("/upload/", {**self.metadata, "version": "1", "file": package(), "screenshots": images, **changes})

    def draft(self):
        response = self.api.post("/api/v1/items/", {**self.metadata, "content_type": "blueprints"}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["status"], "draft")
        return Item.objects.get(pk=response.data["id"]), f'/api/v1/items/{response.data["id"]}/'

    def test_web_upload_requires_one_to_eight_valid_screenshots(self):
        for count in [0, 9]:
            with self.subTest(count=count):
                response = self.web_upload([screenshot(f"{index}.png") for index in range(count)])
                self.assertContains(response, "Choose 1–8 screenshots.")
                self.assertEqual(Item.objects.count(), 0)
                self.assertFalse(any(Path(self.directory.name).rglob("*.*")))
        response = self.web_upload([screenshot(), package("bad.png", b"not an image")])
        self.assertContains(response, "This image could not be read safely.")
        self.assertFalse(Item.objects.exists())
        self.assertFalse(Release.objects.exists())
        self.assertFalse(Screenshot.objects.exists())
        self.assertFalse(any(Path(self.directory.name).rglob("*.*")))
        response = self.web_upload([screenshot()])
        self.assertEqual(response.status_code, 302)
        item = Item.objects.get()
        self.assertEqual(item.status, "published")
        self.assertEqual(item.screenshots.count(), 1)
        self.assertEqual(item.releases.count(), 1)

    def test_api_publish_requires_release_and_one_screenshot(self):
        item, url = self.draft()
        self.assertEqual(self.api.patch(url, {"status": "published"}).status_code, 400)
        self.assertEqual(self.api.post(url + "releases/", {"version": "1", "file": package()}, format="multipart").status_code, 201)
        response = self.api.patch(url, {"status": "published"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Add at least 1 screenshot", str(response.data))
        self.assertEqual(self.api.post(url + "screenshots/", {"image": screenshot()}, format="multipart").status_code, 201)
        self.assertEqual(self.api.patch(url, {"status": "published"}).status_code, 200)
        item.refresh_from_db()
        self.assertEqual(item.status, "published")

    def test_web_can_publish_api_draft_with_one_screenshot_but_not_zero(self):
        item, url = self.draft()
        self.api.post(url + "releases/", {"version": "1", "file": package()}, format="multipart")
        target = f"/items/{item.pk}/edit/"
        response = self.client.post(target, {**self.metadata, "action": "metadata"})
        self.assertContains(response, "Add at least 1 screenshot before publishing.")
        item.refresh_from_db()
        self.assertEqual(item.status, "draft")
        self.api.post(url + "screenshots/", {"image": screenshot()}, format="multipart")
        self.assertEqual(self.client.post(target, {**self.metadata, "action": "metadata"}).status_code, 302)
        item.refresh_from_db()
        self.assertEqual(item.status, "published")

    def test_published_screenshot_minimum_on_api_and_web_deletes(self):
        self.web_upload([screenshot()])
        item = Item.objects.get()
        shot = item.screenshots.first()
        url = f"/api/v1/items/{item.pk}/"
        edit_url = f"/items/{item.pk}/edit/"
        self.assertEqual(self.api.delete(url + f"screenshots/{shot.pk}/").status_code, 400)
        response = self.client.post(edit_url, {"action": "remove-screenshot", "screenshot_id": shot.pk}, follow=True)
        self.assertContains(response, "Published creations need at least 1 screenshot.")
        self.assertEqual(item.screenshots.count(), 1)
        self.assertTrue(Path(shot.image.path).exists())
        self.api.post(url + "screenshots/", {"image": screenshot("replacement.png")}, format="multipart")
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.api.delete(url + f"screenshots/{shot.pk}/").status_code, 204)
        self.assertEqual(item.screenshots.count(), 1)
        self.assertFalse(Path(shot.image.path).exists())
        self.api.patch(url, {"status": "draft"})
        other = item.screenshots.first()
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(edit_url, {"action": "remove-screenshot", "screenshot_id": other.pk}).status_code, 302)
        self.assertEqual(item.screenshots.count(), 0)

    def test_disabled_mod_types_rejected_by_web_api_and_release_uploads(self):
        mods = ContentType.objects.get(slug="mods")
        self.assertFalse(mods.uploads_enabled)
        self.assertSetEqual(set(ContentType.objects.filter(uploads_enabled=True).values_list("slug", flat=True)), {"blueprints", "blueprint-packs", "scenarios"})
        discovered = self.api.get("/api/v1/types/").json()
        self.assertSetEqual({value["slug"] for value in discovered}, {"blueprints", "blueprint-packs", "scenarios"})
        self.assertNotContains(self.client.get("/upload/"), ">Other mods</option>")
        self.assertEqual(self.api.post("/api/v1/items/", {**self.metadata, "content_type": "mods"}, format="json").status_code, 400)
        self.assertEqual(self.web_upload([screenshot(), screenshot()], content_type=mods.pk).status_code, 200)
        self.assertFalse(Item.objects.exists())
        item, url = self.draft()
        self.assertEqual(self.api.patch(url, {"content_type": "mods"}).status_code, 400)
        Item.objects.filter(pk=item.pk).update(content_type=mods)
        response = self.api.post(url + "releases/", {"version": "1", "file": package()}, format="multipart")
        self.assertEqual(response.status_code, 400)
        response = self.client.post(f"/items/{item.pk}/edit/", {"action": "release", "version": "1", "file": package()})
        self.assertContains(response, "Uploads for this file type are disabled.")
        self.assertFalse(item.releases.exists())
        future = ContentType.objects.create(name="Future", slug="future", allowed_extensions=[".zip"])
        self.assertFalse(future.uploads_enabled)

    def test_published_legacy_item_needs_screenshots_for_new_release(self):
        item = Item.objects.create(author=self.author, content_type=self.blueprints, title="Legacy", summary="Legacy", description="Legacy")
        response = self.api.post(f"/api/v1/items/{item.pk}/releases/", {"version": "2", "file": package()}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(item.releases.exists())

    def test_failed_first_release_removes_new_screenshots(self):
        save = default_storage.save

        def fail_release(name, content, **kwargs):
            if name.startswith("releases/"):
                raise BotoCoreError()
            return save(name, content, **kwargs)

        with patch.object(default_storage, "save", side_effect=fail_release):
            response = self.web_upload([screenshot(), screenshot("second.png")])
        self.assertContains(response, "File storage is temporarily unavailable.")
        self.assertFalse(Item.objects.exists())
        self.assertFalse(Screenshot.objects.exists())
        self.assertFalse(UploadEvent.objects.exists())
        self.assertFalse(any(Path(self.directory.name).rglob("*.*")))
