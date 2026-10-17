import tempfile
from datetime import timedelta
from unittest.mock import patch

from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.contrib.sessions.models import Session
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from oauth2_provider.models import AccessToken, Application, RefreshToken
from rest_framework.test import APIClient

from hub.models import APIKey, Bookmark, ContentType, FileDeletion, Item, ModerationLog, Release, Revision, Screenshot, UserModeration
from hub.moderation_services import moderate_item, self_delete_item, shadow_ban_user
from tests.test_hub import package, screenshot


@override_settings(ASYNC_UPLOAD_VALIDATION=False, DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class ModerationTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.media = override_settings(MEDIA_ROOT=self.directory.name)
        self.media.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.media.disable)
        User = get_user_model()
        self.admin = User.objects.create_superuser("admin", password=None)
        self.moderator = User.objects.create_user("moderator")
        self.reviewer = User.objects.create_user("reviewer")
        self.moderator.groups.add(Group.objects.get(name="Moderator"))
        self.reviewer.groups.add(Group.objects.get(name="Reviewer"))
        self.author = User.objects.create_user("creator")
        self.stranger = User.objects.create_user("visitor")
        self.item = Item.objects.create(author=self.author, content_type=ContentType.objects.get(slug="blueprints"), title="Sunset parking", summary="A community lot", description="Community file.")
        self.release = Release.objects.create(item=self.item, version="1", file=ContentFile(b"{}", name="lot.json"), original_filename="lot.json", sha256="a" * 64, size=2)
        self.shots = [Screenshot.objects.create(item=self.item, image=ContentFile(b"image", name=f"shot-{i}.webp")) for i in range(3)]
        self.api = APIClient()
        self.url = reverse("api-item-detail", args=[self.item.pk])
        self.tools = reverse("moderation-item", args=[self.item.pk])
        self.editor = reverse("item-edit", args=[self.item.pk])
        self.user_url = reverse("moderation-user", args=[self.author.pk])
        self.download = reverse("api-item-download", kwargs={"pk": self.item.pk, "release_id": self.release.pk})
        self.gate = reverse("item-download", args=[self.item.pk, self.release.pk])
        self.image_url = reverse("api-item-screenshot-image", kwargs={"pk": self.item.pk, "screenshot_id": self.shots[0].pk})

    def login(self, user):
        self.client.force_login(user)
        self.api.force_login(user)

    def metadata(self, **extra):
        return {"action": "metadata", "title": self.item.title, "summary": self.item.summary,
                "description": self.item.description, "content_type": self.item.content_type_id,
                "tags": "", "status": "published", **extra}

    def test_staff_role_boundaries_and_admin_panel(self):
        self.assertEqual(self.client.get("/moderation/").status_code, 302)
        for user, staff, manage, admin in [(self.author, False, False, False), (self.reviewer, True, False, False), (self.moderator, True, True, False), (self.admin, True, True, True)]:
            self.login(user)
            with self.subTest(user=user.username):
                self.assertEqual(self.client.get("/moderation/").status_code, 200 if staff else 403)
                self.assertEqual(self.client.get(self.tools).status_code, 200 if staff else 403)
                self.assertEqual(self.client.get("/moderation/users/").status_code, 200 if manage else 403)
                self.assertEqual(self.client.get(self.user_url).status_code, 200 if manage else 403)
                self.assertEqual(self.client.get(reverse("moderation-delete", args=[self.item.pk])).status_code, 200 if admin else 403)
                if not admin:
                    self.assertEqual(self.client.get("/admin/login/").status_code, 403)
        self.login(self.admin)
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        self.assertRedirects(self.client.get(f"/admin/auth/user/{self.author.pk}/change/"), self.user_url)

    def test_hide_requires_reason_and_records_actor(self):
        self.login(self.reviewer)
        for reason in ["", "   ", "x" * 2001]:
            self.assertEqual(self.client.post(self.tools, {"action": "hide", "reason": reason}).status_code, 200)
            self.item.refresh_from_db()
            self.assertFalse(self.item.is_hidden)
        self.client.post(self.tools, {"action": "hide", "reason": "Please replace the incorrect screenshots."})
        self.item.refresh_from_db()
        self.assertTrue(self.item.is_hidden)
        self.assertEqual(self.item.hidden_by, self.reviewer)
        self.assertEqual(ModerationLog.objects.get(action="hide").actor, self.reviewer)

    def test_hidden_creation_has_public_error_but_issues_no_file_urls(self):
        reason = "Replace <script>alert(1)</script> in the description."
        moderate_item(self.moderator, self.item, "hide", reason)
        for path in [self.item.get_absolute_url(), self.gate]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 403)
            self.assertContains(response, "&lt;script&gt;", status_code=403)
            self.assertNotContains(response, "<script>alert", status_code=403)
        with patch("hub.api.file_response") as storage:
            for path in [self.url, self.download, self.image_url]:
                response = self.api.get(path)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["errors"]["reason"], reason)
                self.assertIn("no-store", response["Cache-Control"])
            storage.assert_not_called()
        self.assertNotContains(self.client.get("/"), self.item.title)
        self.assertEqual(self.api.get("/api/v1/items/").json()["count"], 0)
        self.assertContains(self.client.get("/"), "0 uploads")

    def test_owner_receives_reason_and_cannot_remove_moderation_restriction(self):
        moderate_item(self.moderator, self.item, "hide", "Screenshots do not match the file.")
        self.login(self.author)
        for path in ["/account/profile/", "/?view=mine", self.editor]:
            self.assertContains(self.client.get(path), "Screenshots do not match the file.")
        self.assertEqual(self.client.post(self.editor, self.metadata(is_hidden="", hidden_reason="")).status_code, 302)
        self.assertEqual(self.api.patch(self.url, {"status": "published", "is_hidden": False, "hidden_reason": "", "featured_at": "2026-01-01T00:00:00Z"}).status_code, 200)
        self.item.refresh_from_db()
        self.assertTrue(self.item.is_hidden)
        self.assertIsNone(self.item.featured_at)
        self.assertEqual(self.client.post(self.tools, {"action": "restore"}).status_code, 403)

    def test_moderator_edits_and_adds_content_but_cannot_delete_other_content(self):
        self.login(self.moderator)
        self.assertEqual(self.client.post(self.editor, self.metadata(title="Corrected title")).status_code, 302)
        self.assertEqual(Revision.objects.get(item=self.item).editor, self.moderator)
        self.assertEqual(self.api.patch(self.url, {"summary": "Corrected summary"}).status_code, 200)
        self.assertEqual(self.api.post(self.url + "releases/", {"version": "2", "file": package()}, format="multipart").status_code, 201)
        self.assertEqual(self.api.post(self.url + "screenshots/", {"image": screenshot()}, format="multipart").status_code, 201)
        target = self.url + f"screenshots/{self.shots[0].pk}/"
        self.assertEqual(self.api.delete(target).status_code, 403)
        self.assertEqual(self.client.post(self.editor, {"action": "remove-screenshot", "screenshot_id": self.shots[0].pk}).status_code, 403)
        self.assertEqual(self.api.delete(self.url).status_code, 403)
        self.assertEqual(self.client.post(reverse("moderation-delete", args=[self.item.pk]), {"confirmation": self.item.title, "reason": "Test"}).status_code, 403)

    def test_reviewer_cannot_edit_add_restore_or_manage_users(self):
        self.login(self.reviewer)
        self.assertEqual(self.client.get(self.editor).status_code, 404)
        self.assertEqual(self.api.patch(self.url, {"title": "No"}).status_code, 403)
        self.assertEqual(self.api.post(self.url + "releases/", {"version": "2", "file": package()}, format="multipart").status_code, 403)
        self.client.post(self.tools, {"action": "hide", "reason": "Needs review"})
        self.assertEqual(self.client.post(self.tools, {"action": "restore"}).status_code, 403)
        self.assertEqual(self.client.post(self.user_url, {"action": "shadow-ban", "reason": "No"}).status_code, 403)
        self.assertEqual(self.client.get(reverse("moderation-release-edit", args=[self.item.pk, self.release.pk])).status_code, 403)

    def test_all_staff_can_highlight_and_hiding_removes_frontpage_highlight(self):
        for user in [self.admin, self.moderator, self.reviewer]:
            self.login(user)
            self.assertEqual(self.client.post(self.tools, {"action": "highlight"}).status_code, 302)
            page = Client().get("/")
            self.assertContains(page, "Highlighted creations")
            self.assertIn(self.item, page.context["featured_items"])
            self.assertEqual(self.client.post(self.tools, {"action": "unhighlight"}).status_code, 302)
        self.client.post(self.tools, {"action": "highlight"})
        self.client.post(self.tools, {"action": "hide", "reason": "Needs review"})
        self.item.refresh_from_db()
        self.assertIsNone(self.item.featured_at)
        self.assertNotContains(Client().get("/"), "Highlighted creations")
        self.assertEqual(self.client.post(self.tools, {"action": "highlight"}).status_code, 200)
        self.login(self.moderator)
        self.assertEqual(self.client.post(self.tools, {"action": "restore"}).status_code, 302)
        self.item.refresh_from_db()
        self.assertFalse(self.item.is_hidden)
        self.assertIsNone(self.item.featured_at)

    def test_api_keys_do_not_inherit_staff_powers(self):
        _, key = APIKey.issue(user=self.admin, name="Manager", scopes=["read", "write"])
        self.api.credentials(HTTP_AUTHORIZATION=f"ApiKey {key}")
        self.assertEqual(self.api.patch(self.url, {"title": "No staff delegation"}).status_code, 403)
        self.assertEqual(self.api.delete(self.url).status_code, 403)
        self.item.status = Item.Status.DRAFT
        self.item.save()
        self.assertEqual(self.api.get(self.url).status_code, 404)

    def test_role_assignment_is_admin_only_and_takes_effect(self):
        self.login(self.moderator)
        self.assertEqual(self.client.post(self.user_url, {"action": "save", "username": "creator", "role": "Admin", "is_active": "on"}).status_code, 403)
        self.login(self.admin)
        for role in ["Reviewer", "Moderator", "Admin", ""]:
            response = self.client.post(self.user_url, {"username": "creator", "role": role, "is_active": "on"})
            self.assertEqual(response.status_code, 302)
            self.author.refresh_from_db()
            self.assertEqual(self.author.is_superuser, role == "Admin")
            self.assertEqual(self.author.is_staff, role == "Admin")
            self.assertEqual(list(self.author.groups.values_list("name", flat=True)), [role] if role else [])
            browser = Client()
            browser.force_login(self.author)
            self.assertEqual(browser.get("/moderation/").status_code, 200 if role else 403)

    def test_last_admin_cannot_be_demoted_suspended_or_purged(self):
        self.login(self.admin)
        url = reverse("moderation-user", args=[self.admin.pk])
        for role, active in [("", "on"), ("Admin", "")]:
            response = self.client.post(url, {"username": "admin", "role": role, "is_active": active})
            self.assertContains(response, "Keep at least one active Admin account.")
        response = self.client.post(reverse("moderation-user-delete", args=[self.admin.pk]), {"confirmation": "admin", "reason": "Testing"})
        self.assertContains(response, "Keep at least one active Admin account.")
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active and self.admin.is_superuser)

    def test_suspension_revokes_sessions_keys_and_oauth(self):
        browser = Client()
        browser.force_login(self.author)
        key, raw = APIKey.issue(user=self.author, name="Key", scopes=["read"])
        app = Application.objects.create(user=self.author, name="Manager", client_type="public", authorization_grant_type="authorization-code")
        access = AccessToken.objects.create(user=self.author, application=app, token="suspend-test", scope="read", expires=timezone.now() + timedelta(hours=1))
        RefreshToken.objects.create(user=self.author, application=app, access_token=access, token="refresh-test")
        self.login(self.admin)
        self.assertEqual(self.client.post(self.user_url, {"username": "creator", "role": ""}).status_code, 302)
        self.author.refresh_from_db()
        self.assertFalse(self.author.is_active)
        key.refresh_from_db()
        self.assertFalse(key.active)
        self.assertFalse(AccessToken.objects.filter(user=self.author).exists())
        self.assertFalse(RefreshToken.objects.filter(user=self.author).exists())
        self.assertEqual(browser.get("/account/profile/").status_code, 302)
        self.api.credentials(HTTP_AUTHORIZATION=f"ApiKey {raw}")
        self.assertEqual(self.api.get("/api/v1/me/").status_code, 401)

    def test_shadow_ban_requires_private_reason_and_blocks_every_public_route(self):
        self.login(self.moderator)
        self.assertEqual(self.client.post(self.user_url, {"action": "shadow-ban", "reason": "   "}).status_code, 200)
        self.assertFalse(UserModeration.objects.exists())
        self.client.post(self.user_url, {"action": "shadow-ban", "reason": "Internal duplicate-account evidence"})
        self.assertIsNotNone(UserModeration.objects.get(user=self.author).shadow_banned_at)
        self.assertEqual(ModerationLog.objects.get(action="shadow ban").reason, "Internal duplicate-account evidence")
        self.client.logout()
        self.api.logout()
        for user in [None, self.stranger]:
            if user:
                self.login(user)
            with self.subTest(user=user):
                for url in [self.item.get_absolute_url(), self.gate, self.url, self.download, self.image_url]:
                    self.assertEqual(self.client.get(url).status_code, 404, url)
                self.assertNotContains(self.client.get("/?q=Sunset"), self.item.title)
                self.assertEqual(self.api.get("/api/v1/items/").json()["count"], 0)
                self.assertNotContains(self.client.get("/"), "Internal duplicate-account evidence")
        self.login(self.author)
        for url in [self.item.get_absolute_url(), self.url, self.download, self.image_url, "/?view=mine", self.editor]:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200, url)
            if not response.streaming:
                self.assertNotContains(response, "Internal duplicate-account evidence")
        self.assertNotContains(self.client.get("/account/profile/"), "shadow ban")
        for user in [self.admin, self.moderator, self.reviewer]:
            self.login(user)
            self.assertEqual(self.client.get(self.item.get_absolute_url()).status_code, 200)
            self.assertEqual(self.client.get(self.download).status_code, 200)

    def test_future_uploads_remain_shadow_banned_and_unban_requires_reason(self):
        shadow_ban_user(self.moderator, self.author, action="shadow-ban", reason="Internal reason")
        future = Item.objects.create(author=self.author, content_type=self.item.content_type, title="Future upload", summary="Next", description="Next")
        self.assertEqual(self.client.get(future.get_absolute_url()).status_code, 404)
        self.login(self.author)
        self.assertEqual(self.client.get(future.get_absolute_url()).status_code, 200)
        self.login(self.moderator)
        self.client.post(self.user_url, {"action": "remove-shadow-ban", "reason": ""})
        self.assertEqual(Client().get(future.get_absolute_url()).status_code, 404)
        self.client.post(self.user_url, {"action": "remove-shadow-ban", "reason": "Reviewed the account"})
        self.assertEqual(Client().get(future.get_absolute_url()).status_code, 200)
        self.assertEqual(self.client.post(reverse("moderation-user", args=[self.admin.pk]), {"action": "shadow-ban", "reason": "No"}).status_code, 403)

    def test_shadow_banned_content_is_excluded_from_highlights_and_counts(self):
        moderate_item(self.reviewer, self.item, "highlight")
        shadow_ban_user(self.moderator, self.author, action="shadow-ban", reason="Internal only")
        page = self.client.get("/")
        self.assertEqual(list(page.context["featured_items"]), [])
        self.assertEqual(page.context["site_totals"]["uploads"], 0)
        self.assertEqual(page.context["stats"]["items"], 0)
        self.assertEqual(next(category for category in page.context["types_with_counts"] if category.pk == self.item.content_type_id).total, 0)

    def test_admin_purge_removes_account_activity_files_and_access(self):
        owned_browser = Client()
        owned_browser.force_login(self.author)
        owned_session_key = owned_browser.session.session_key
        SocialAccount.objects.create(user=self.author, provider="steam", uid="purge-test")
        Bookmark.objects.create(user=self.author, item=self.item)
        APIKey.issue(user=self.author, name="Purge key", scopes=["read"])
        other_item = Item.objects.create(author=self.stranger, content_type=self.item.content_type, title="Keep", summary="Keep", description="Keep")
        Revision.objects.create(item=other_item, editor=self.author, snapshot={"title": "Old edit"})
        ModerationLog.objects.create(actor=self.author, action="old activity", item=other_item)
        names = [self.release.file.name, *(shot.image.name for shot in self.shots)]
        self.login(self.admin)
        url = reverse("moderation-user-delete", args=[self.author.pk])
        for data in [{"confirmation": "creator"}, {"confirmation": "wrong", "reason": "Purge test"}]:
            self.assertEqual(self.client.post(url, data).status_code, 200)
            self.assertTrue(get_user_model().objects.filter(pk=self.author.pk).exists())
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(url, {"confirmation": "creator", "reason": "Repeated prohibited uploads"}).status_code, 302)
        self.assertFalse(get_user_model().objects.filter(pk=self.author.pk).exists())
        self.assertFalse(Item.objects.filter(pk=self.item.pk).exists())
        self.assertTrue(Item.objects.filter(pk=other_item.pk).exists())
        for model in [Release, Screenshot, Bookmark, APIKey, SocialAccount, Revision]:
            self.assertFalse(model.objects.exists(), model.__name__)
        self.assertFalse(Session.objects.filter(session_key=owned_session_key).exists())
        self.assertEqual(ModerationLog.objects.count(), 1)
        log = ModerationLog.objects.get()
        self.assertEqual(log.action, "purge user")
        self.assertEqual(log.reason, "Repeated prohibited uploads")
        self.assertIsNone(log.target_user)
        self.assertFalse(FileDeletion.objects.exists())
        for name in names:
            self.assertFalse(default_storage.exists(name))

    def test_failed_storage_deletion_is_retained_and_retried(self):
        self.login(self.admin)
        with patch("hub.file_cleanup.default_storage.delete", side_effect=OSError("Storage offline")), self.assertLogs("hub.file_cleanup", "ERROR"), self.captureOnCommitCallbacks(execute=True):
            self.client.post(reverse("moderation-delete", args=[self.item.pk]), {"confirmation": self.item.title, "reason": "Cleanup test"})
        self.assertEqual(FileDeletion.objects.count(), 4)
        self.assertFalse(Item.objects.filter(pk=self.item.pk).exists())
        call_command("cleanup_deleted_files")
        self.assertFalse(FileDeletion.objects.exists())
        self.assertFalse(default_storage.exists(self.release.file.name))

    def test_file_edit_and_admin_deletion_keep_publication_valid(self):
        self.login(self.moderator)
        url = reverse("moderation-release-edit", args=[self.item.pk, self.release.pk])
        self.assertEqual(self.client.post(url, {"version": "1.1", "game_version": "1", "changelog": "Corrected notes"}).status_code, 302)
        self.release.refresh_from_db()
        self.assertEqual(self.release.version, "1.1")
        self.assertEqual(self.client.get(reverse("moderation-release-delete", args=[self.item.pk, self.release.pk])).status_code, 403)
        self.login(self.admin)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(reverse("moderation-release-delete", args=[self.item.pk, self.release.pk]), {"confirmation": "lot.json", "reason": "Invalid release"})
        self.assertEqual(response.status_code, 302)
        self.item.refresh_from_db()
        self.assertEqual(self.item.status, Item.Status.DRAFT)
        self.assertFalse(default_storage.exists(self.release.file.name))

    def test_staff_cannot_rename_a_release_to_an_existing_version(self):
        Release.objects.create(item=self.item, version="2", file="releases/another.json", original_filename="another.json", sha256="b" * 64, size=2)
        self.login(self.moderator)
        response = self.client.post(reverse("moderation-release-edit", args=[self.item.pk, self.release.pk]), {"version": "2", "game_version": "", "changelog": ""})
        self.assertContains(response, "This version already exists.")
        self.release.refresh_from_db()
        self.assertEqual(self.release.version, "1")

    def test_author_can_unpublish_and_self_delete_then_restore(self):
        self.login(self.author)
        self.assertEqual(self.client.post(reverse("item-unpublish", args=[self.item.pk])).status_code, 302)
        self.assertEqual(Client().get(self.item.get_absolute_url()).status_code, 404)
        self.assertEqual(self.api.patch(self.url, {"status": "published"}).status_code, 200)
        self.assertEqual(self.client.post(reverse("item-self-delete", args=[self.item.pk])).status_code, 302)
        self.item.refresh_from_db()
        self.assertTrue(self.item.can_restore)
        self.assertEqual(self.item.delete_after - self.item.deleted_at, timedelta(days=14))
        self.assertTrue(default_storage.exists(self.release.file.name))
        for path in [self.item.get_absolute_url(), self.gate, self.url, self.download, self.image_url]:
            self.assertEqual(Client().get(path).status_code, 404, path)
        self.assertContains(self.client.get("/?view=mine"), "Restore")
        self.assertContains(self.client.get(self.item.get_absolute_url()), "Deleted by the author")
        for user in [self.admin, self.moderator, self.reviewer]:
            browser = Client()
            browser.force_login(user)
            self.assertEqual(browser.get(self.item.get_absolute_url()).status_code, 200)
        self.assertEqual(self.client.post(reverse("item-self-restore", args=[self.item.pk])).status_code, 302)
        self.item.refresh_from_db()
        self.assertIsNone(self.item.deleted_at)
        self.assertEqual(Client().get(self.item.get_absolute_url()).status_code, 200)

    def test_api_soft_delete_and_restore_cannot_clear_hidden_or_shadow_ban(self):
        moderate_item(self.moderator, self.item, "hide", "Public reason")
        shadow_ban_user(self.moderator, self.author, action="shadow-ban", reason="Private reason")
        self.login(self.author)
        self.assertEqual(self.api.delete(self.url).status_code, 204)
        self.item.refresh_from_db()
        deleted_at = self.item.deleted_at
        self.assertEqual(self.api.delete(self.url).status_code, 204)
        self.item.refresh_from_db()
        self.assertEqual(self.item.deleted_at, deleted_at)
        self.assertEqual(self.api.post(self.url + "restore/").status_code, 200)
        self.item.refresh_from_db()
        self.assertTrue(self.item.is_hidden)
        self.assertIsNotNone(UserModeration.objects.get(user=self.author).shadow_banned_at)
        self.assertEqual(Client().get(self.item.get_absolute_url()).status_code, 404)

    def test_self_delete_expiry_is_exact_and_cleanup_preserves_restorable_items(self):
        self_delete_item(self.author, self.item)
        moment = timezone.now()
        Item.objects.filter(pk=self.item.pk).update(deleted_at=moment - timedelta(days=14) + timedelta(seconds=1))
        self.login(self.author)
        with patch("django.utils.timezone.now", return_value=moment):
            self.assertEqual(self.api.post(self.url + "restore/").status_code, 200)
        self_delete_item(self.author, self.item)
        Item.objects.filter(pk=self.item.pk).update(deleted_at=moment - timedelta(days=14))
        with patch("django.utils.timezone.now", return_value=moment):
            self.assertEqual(self.api.post(self.url + "restore/").status_code, 400)
        fresh = Item.objects.create(author=self.author, content_type=self.item.content_type, title="Recent deletion", summary="Recent", description="Recent", deleted_at=moment)
        with self.captureOnCommitCallbacks(execute=True):
            call_command("cleanup_deleted_files")
        self.assertFalse(Item.objects.filter(pk=self.item.pk).exists())
        self.assertTrue(Item.objects.filter(pk=fresh.pk).exists())
        self.assertFalse(default_storage.exists(self.release.file.name))

    def test_staff_changes_and_self_delete_require_csrf_and_restore_is_post_only(self):
        csrf = Client(enforce_csrf_checks=True)
        csrf.force_login(self.admin)
        for url, data in [(self.tools, {"action": "hide", "reason": "Reason"}), (self.user_url, {"action": "shadow-ban", "reason": "Private"}), (reverse("moderation-delete", args=[self.item.pk]), {"confirmation": self.item.title, "reason": "Reason"})]:
            self.assertEqual(csrf.post(url, data).status_code, 403)
        csrf.force_login(self.author)
        for name in ["item-self-delete", "item-self-restore", "item-unpublish"]:
            self.assertEqual(csrf.post(reverse(name, args=[self.item.pk])).status_code, 403)
        self.login(self.author)
        self.assertEqual(self.client.get(reverse("item-self-restore", args=[self.item.pk])).status_code, 405)
        self.login(self.stranger)
        self.assertEqual(self.client.post(reverse("item-self-delete", args=[self.item.pk])).status_code, 404)
        self.assertEqual(self.client.post(reverse("item-self-restore", args=[self.item.pk])).status_code, 404)

    def test_staff_restore_preserves_other_restrictions_and_reviewer_cannot_restore(self):
        self_delete_item(self.author, self.item)
        moderate_item(self.moderator, self.item, "hide", "Still under review")
        self.login(self.reviewer)
        self.assertEqual(self.client.post(self.tools, {"action": "restore-deleted"}).status_code, 403)
        self.login(self.moderator)
        self.assertEqual(self.client.post(self.tools, {"action": "restore-deleted"}).status_code, 302)
        self.item.refresh_from_db()
        self.assertIsNone(self.item.deleted_at)
        self.assertTrue(self.item.is_hidden)
