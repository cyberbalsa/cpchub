import tempfile

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from hub.models import APIKey, ContentType, Item, ItemReview, ModerationLog, Release, Screenshot
from hub.moderation_services import delete_user, moderate_item, shadow_ban_user
from hub.reviews import mark_seen
from hub.services import record_revision
from tests.test_hub import package, screenshot


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class ReviewTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        media = override_settings(MEDIA_ROOT=directory.name)
        media.enable()
        self.addCleanup(directory.cleanup)
        self.addCleanup(media.disable)
        User = get_user_model()
        self.admin = User.objects.create_superuser("admin", password=None)
        self.moderator = User.objects.create_user("moderator")
        self.reviewer = User.objects.create_user("reviewer")
        self.moderator.groups.add(Group.objects.get(name="Moderator"))
        self.reviewer.groups.add(Group.objects.get(name="Reviewer"))
        self.author = User.objects.create_user("creator")
        self.item = Item.objects.create(author=self.author, content_type=ContentType.objects.get(slug="blueprints"), title="Review this lot", summary="Parking", description="A lot.")
        self.release = Release.objects.create(item=self.item, version="1", file="releases/test.json", original_filename="test.json", sha256="a" * 64, size=2)
        self.shots = [Screenshot.objects.create(item=self.item, image=f"screenshots/test-{i}.webp") for i in range(3)]
        record_revision(self.item, self.author)
        self.queue = reverse("moderation-review-queue")
        self.tools = reverse("moderation-item", args=[self.item.pk])
        self.editor = reverse("item-edit", args=[self.item.pk])
        self.api_url = reverse("api-item-detail", args=[self.item.pk])
        self.api = APIClient()

    def seen(self, actor=None, note="Private review note"):
        self.item.refresh_from_db()
        return mark_seen(actor or self.reviewer, self.item, content_revision=self.item.content_revision, note=note)

    def assert_pending(self):
        self.item.refresh_from_db()
        self.assertTrue(self.item.needs_review)
        browser = Client()
        browser.force_login(self.reviewer)
        self.assertContains(browser.get(self.queue), self.item.title)

    def metadata(self, **extra):
        self.item.refresh_from_db()
        return {"title": self.item.title, "summary": self.item.summary, "description": self.item.description,
                "tags": self.item.tags, "content_type": self.item.content_type_id, "status": "published", **extra}

    def test_staff_only_queue_and_marking_seen(self):
        self.assertEqual(self.client.get(self.queue).status_code, 302)
        self.client.force_login(self.author)
        self.assertEqual(self.client.get(self.queue).status_code, 403)
        self.assertEqual(self.client.post(self.tools, {"action": "mark-seen", "content_revision": self.item.content_revision}).status_code, 403)
        with self.assertRaises(PermissionDenied):
            self.seen(self.author)
        for user in [self.admin, self.moderator, self.reviewer]:
            self.client.force_login(user)
            self.assertContains(self.client.get(self.queue), self.item.title)
            self.assertFalse(ItemReview.objects.exists())
        response = self.client.post(self.tools, {"action": "mark-seen", "content_revision": self.item.content_revision, "note": "Checked screenshots."})
        self.assertRedirects(response, self.queue)
        review = ItemReview.objects.get()
        self.assertEqual(review.reviewer, self.reviewer)
        self.assertEqual(review.note, "Checked screenshots.")
        self.assertEqual(ModerationLog.objects.get(action="marked seen").actor, self.reviewer)
        self.assertNotContains(self.client.get(self.queue), self.item.title)
        self.assertContains(self.client.get(self.queue + "?state=seen"), self.item.title)
        self.assertContains(self.client.get(self.tools), "Checked screenshots.")

    def test_all_staff_can_mark_seen_and_get_does_not_mark(self):
        for index, user in enumerate([self.admin, self.moderator, self.reviewer]):
            self.client.force_login(user)
            self.client.get(self.tools)
            self.assertEqual(ItemReview.objects.count(), index)
            self.assertTrue(self.seen(user))
            self.client.force_login(self.author)
            self.client.post(self.editor, self.metadata(title=f"New title {index}"))
        self.assertEqual(ItemReview.objects.count(), 3)
        self.assert_pending()

    def test_csrf_and_api_keys_cannot_mark_seen(self):
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.admin)
        self.assertEqual(browser.post(self.tools, {"action": "mark-seen", "content_revision": self.item.content_revision}).status_code, 403)
        _, key = APIKey.issue(user=self.admin, name="Manager", scopes=["read", "write"])
        self.assertEqual(self.client.post(self.tools, {"action": "mark-seen"}, HTTP_AUTHORIZATION=f"ApiKey {key}").status_code, 302)
        self.assertFalse(ItemReview.objects.exists())

    def test_stale_or_missing_revision_cannot_clear_new_edits(self):
        old_revision = self.item.content_revision
        self.client.force_login(self.author)
        self.client.post(self.editor, self.metadata(description="Changed after review page opened"))
        self.client.force_login(self.reviewer)
        response = self.client.post(self.tools, {"action": "mark-seen", "content_revision": old_revision})
        self.assertContains(response, "changed while this page was open", status_code=409)
        self.assertEqual(self.client.post(self.tools, {"action": "mark-seen"}).status_code, 200)
        self.assertFalse(ItemReview.objects.exists())
        self.assert_pending()
        self.item.refresh_from_db()
        self.assertEqual(self.client.post(self.tools, {"action": "mark-seen", "content_revision": self.item.content_revision}).status_code, 302)

    def test_duplicate_reviews_keep_first_reviewer_and_note(self):
        self.assertTrue(self.seen(self.moderator, note="First note"))
        self.assertFalse(self.seen(self.admin, note="Replacement note"))
        self.assertEqual(ItemReview.objects.count(), 1)
        self.assertEqual(ItemReview.objects.get().reviewer, self.moderator)
        self.assertEqual(ItemReview.objects.get().note, "First note")
        self.assertEqual(ModerationLog.objects.filter(action="marked seen").count(), 1)

    def test_metadata_edits_from_web_and_api_requeue_with_history(self):
        self.seen()
        self.client.force_login(self.author)
        self.assertEqual(self.client.post(self.editor, self.metadata(title="New lot title")).status_code, 302)
        self.assert_pending()
        self.seen(self.moderator)
        self.api.force_login(self.author)
        self.assertEqual(self.api.patch(self.api_url, {"description": "API edit"}).status_code, 200)
        self.assert_pending()
        self.assertEqual(ItemReview.objects.count(), 2)
        self.client.force_login(self.reviewer)
        self.assertContains(self.client.get(self.queue), "Edited since review")
        self.assertContains(self.client.get(self.tools), "Private review note", count=4)

    def test_release_and_screenshot_uploads_requeue_from_web_and_api(self):
        self.client.force_login(self.author)
        self.api.force_login(self.author)
        operations = [
            lambda: self.client.post(self.editor, {"action": "release", "version": "2", "file": package()}),
            lambda: self.api.post(self.api_url + "releases/", {"version": "3", "file": package()}, format="multipart"),
            lambda: self.client.post(self.editor, {"action": "screenshot", "image": screenshot()}),
            lambda: self.api.post(self.api_url + "screenshots/", {"image": screenshot()}, format="multipart"),
        ]
        for operation, status in zip(operations, [302, 201, 302, 201]):
            self.seen()
            self.assertEqual(operation().status_code, status)
            self.assert_pending()
        self.assertEqual(ItemReview.objects.count(), 4)

    def test_owner_screenshot_removal_requeues_from_web_and_api(self):
        Screenshot.objects.create(item=self.item, image="screenshots/fourth.webp")
        self.client.force_login(self.author)
        self.api.force_login(self.author)
        self.seen()
        self.assertEqual(self.client.post(self.editor, {"action": "remove-screenshot", "screenshot_id": self.shots[0].pk}).status_code, 302)
        self.assert_pending()
        self.seen()
        self.assertEqual(self.api.delete(self.api_url + f"screenshots/{self.shots[1].pk}/").status_code, 204)
        self.assert_pending()

    def test_staff_file_edits_and_deletions_requeue(self):
        self.client.force_login(self.admin)
        operations = [
            ("moderation-release-edit", self.release.pk, {"version": "1", "game_version": "2", "changelog": "Fixed"}),
            ("moderation-screenshot-edit", self.shots[0].pk, {"caption": "Entrance"}),
            ("moderation-screenshot-delete", self.shots[0].pk, {"confirmation": str(self.shots[0].pk), "reason": "Duplicate"}),
            ("moderation-release-delete", self.release.pk, {"confirmation": "test.json", "reason": "Bad file"}),
        ]
        for name, file_id, data in operations:
            self.seen()
            self.assertEqual(self.client.post(reverse(name, args=[self.item.pk, file_id]), data).status_code, 302)
            self.item.refresh_from_db()
            self.assertTrue(self.item.needs_review)
        self.assertEqual(self.item.status, Item.Status.DRAFT)
        self.assertNotContains(self.client.get(self.queue), self.item.title)

    def test_failed_uploads_noop_edits_and_moderation_do_not_requeue(self):
        self.seen()
        self.client.force_login(self.author)
        self.api.force_login(self.author)
        self.assertEqual(self.client.post(self.editor, self.metadata()).status_code, 302)
        self.assertEqual(self.api.post(self.api_url + "releases/", {"version": "2", "file": package(data=b"bad json")}, format="multipart").status_code, 400)
        self.assertEqual(self.api.post(self.api_url + "screenshots/", {"image": package()}, format="multipart").status_code, 400)
        self.client.post(reverse("bookmark", args=[self.item.pk]))
        moderate_item(self.reviewer, self.item, action="highlight")
        moderate_item(self.reviewer, self.item, action="hide", reason="Check this")
        self.item.refresh_from_db()
        self.assertFalse(self.item.needs_review)
        self.assertEqual(ItemReview.objects.count(), 1)

    def test_queue_includes_hidden_and_shadow_banned_but_not_drafts_or_deleted(self):
        for fields in [{"status": "draft"}, {"deleted_at": timezone.now()}, {"is_demo": True}]:
            Item.objects.create(author=self.author, content_type=self.item.content_type, title="Excluded", **fields)
        moderate_item(self.reviewer, self.item, action="hide", reason="Check")
        shadow_ban_user(self.moderator, self.author, action="shadow-ban", reason="Private")
        self.client.force_login(self.reviewer)
        response = self.client.get(self.queue)
        self.assertContains(response, self.item.title)
        self.assertNotContains(response, "Excluded")
        self.assertEqual(response.context["pending_count"], 1)

    def test_private_notes_stay_private_and_are_escaped(self):
        note = '<script>alert("private-note")</script>'
        self.seen(note=note)
        self.client.force_login(self.author)
        self.api.force_login(self.author)
        for url in ["/", self.item.get_absolute_url(), self.editor, "/account/profile/"]:
            self.assertNotContains(self.client.get(url), "private-note")
        for url in [self.api_url, self.api_url + "history/"]:
            self.assertNotIn("private-note", self.api.get(url).content.decode())
        self.client.force_login(self.reviewer)
        self.assertContains(self.client.get(self.tools), "&lt;script&gt;")
        self.assertNotContains(self.client.get(self.tools), note)

    def test_unpublish_and_republish_returns_to_queue(self):
        self.seen()
        self.client.force_login(self.author)
        self.client.post(reverse("item-unpublish", args=[self.item.pk]))
        staff = Client()
        staff.force_login(self.reviewer)
        self.assertNotContains(staff.get(self.queue), self.item.title)
        self.client.post(self.editor, self.metadata(status="published"))
        self.assert_pending()

    def test_review_and_queue_changes_roll_back_together(self):
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                self.seen()
                raise RuntimeError("Rollback")
        self.assertFalse(ItemReview.objects.exists())
        self.assertFalse(ModerationLog.objects.filter(action="marked seen").exists())
        self.assert_pending()

    def test_purging_reviewer_removes_notes_and_requeues_their_current_reviews(self):
        self.seen()
        delete_user(self.admin, self.reviewer, reason="Remove this account")
        self.assertFalse(ItemReview.objects.exists())
        self.item.refresh_from_db()
        self.assertTrue(self.item.needs_review)
