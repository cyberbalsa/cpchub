from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from hub.models import AccountActivity, ContentType, Item, ModerationLog, Revision, UserModeration
from hub.reviews import mark_seen


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False)
class CreatorProfileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.author = User.objects.create_user("creator", email="private-mail@example.com")
        cls.other = User.objects.create_user("visitor")
        cls.admin = User.objects.create_superuser("admin", password=None)
        cls.moderator = User.objects.create_user("moderator")
        cls.reviewer = User.objects.create_user("reviewer")
        cls.moderator.groups.add(Group.objects.get(name="Moderator"))
        cls.reviewer.groups.add(Group.objects.get(name="Reviewer"))
        category = ContentType.objects.get(slug="blueprints")
        fields = {"author": cls.author, "content_type": category, "summary": "A lot", "description": "Parking"}
        cls.public = Item.objects.create(**fields, title="Public lot")
        cls.draft = Item.objects.create(**fields, title="Unfinished lot", status="draft")
        cls.hidden = Item.objects.create(**fields, title="Hidden lot", is_hidden=True, hidden_reason="Private-profile reason")
        cls.deleted = Item.objects.create(**fields, title="Deleted lot", deleted_at=timezone.now())
        cls.url = reverse("creator-profile", args=[cls.author.pk])

    def test_public_profile_only_lists_public_creations(self):
        SocialAccount.objects.create(user=self.author, provider="discord", uid="private-social-id")
        for viewer in [None, self.other]:
            if viewer:
                self.client.force_login(viewer)
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(list(response.context["page_obj"]), [self.public])
            for private in [self.draft.title, self.hidden.title, self.deleted.title,
                            self.hidden.hidden_reason, self.author.email, "private-social-id", "Account settings"]:
                self.assertNotContains(response, private)
            self.assertContains(response, "1 creation")
            self.assertIn("no-store", response.headers["Cache-Control"])
            self.assertNotContains(response, 'id="community-map"')

    def test_owner_and_each_staff_role_can_see_all_the_creators_items(self):
        for viewer in [self.author, self.admin, self.moderator, self.reviewer]:
            self.client.force_login(viewer)
            response = self.client.get(self.url)
            self.assertEqual(response.context["page_obj"].paginator.count, 4)
            for item in [self.public, self.draft, self.hidden, self.deleted]:
                self.assertContains(response, item.title)
            self.assertContains(response, "Account settings", count=1 if viewer == self.author else 0)
            self.assertContains(response, "Manage user", count=1 if viewer in [self.admin, self.moderator] else 0)
            self.assertNotContains(response, self.author.email)

    def test_shadow_banned_profiles_are_only_visible_to_creator_and_staff(self):
        UserModeration.objects.create(user=self.author, shadow_banned_at=timezone.now(), shadow_banned_by=self.admin)
        for viewer in [None, self.other, self.author, self.admin, self.moderator, self.reviewer]:
            self.client.logout()
            if viewer:
                self.client.force_login(viewer)
            permitted = viewer in [self.author, self.admin, self.moderator, self.reviewer]
            for suffix in ["", "?page=2", "?view=mine"]:
                self.assertEqual(self.client.get(self.url + suffix).status_code, 200 if permitted else 404)

    def test_profile_paginates_without_leaking_other_authors_or_private_counts(self):
        Item.objects.bulk_create([
            Item(author=self.author, content_type=self.public.content_type, title=f"Published {index}")
            for index in range(13)
        ])
        Item.objects.create(author=self.other, content_type=self.public.content_type, title="Another creator's lot")
        first = self.client.get(self.url)
        self.assertEqual(first.context["page_obj"].paginator.count, 14)
        self.assertEqual(len(first.context["page_obj"]), 12)
        self.assertContains(first, 'href="?page=2"')
        second = self.client.get(self.url + "?page=2")
        self.assertEqual(len(second.context["page_obj"]), 2)
        for response in [first, second]:
            self.assertNotContains(response, "Another creator&#x27;s lot")
            self.assertNotContains(response, self.hidden.title)

    def test_empty_missing_and_renamed_profiles(self):
        self.assertContains(self.client.get(reverse("creator-profile", args=[self.other.pk])), "No public creations yet.")
        self.assertEqual(self.client.get(reverse("creator-profile", args=[999999])).status_code, 404)
        self.author.username = "NewName"
        self.author.save(update_fields=["username"])
        self.assertContains(self.client.get(self.url), "NewName")
        self.assertContains(self.client.get(self.public.get_absolute_url()), f'href="{self.url}">NewName</a>')

    def test_public_username_links_and_owner_account_settings(self):
        expected = f'href="{self.url}">creator</a>'
        self.assertContains(self.client.get("/"), expected)
        self.assertContains(self.client.get(self.public.get_absolute_url()), expected)
        self.client.force_login(self.author)
        self.assertContains(self.client.get("/account/profile/"), expected)
        response = self.client.get("/account/keys/")
        self.assertContains(response, f'class="account-name" href="{self.url}"')
        self.assertContains(self.client.get(self.url), 'href="/account/profile/">Account settings</a>')

    def test_staff_names_and_history_link_to_profiles(self):
        Revision.objects.create(item=self.public, editor=self.author, snapshot={"title": self.public.title})
        ModerationLog.objects.create(actor=self.author, target_user=self.author, username=self.author.username, item=self.public, item_title=self.public.title, action="test")
        AccountActivity.objects.create(user=self.author, action="login", ip_source="direct", auth_method="discord", request_path="/")
        mark_seen(self.reviewer, self.public, content_revision=self.public.content_revision)
        self.client.force_login(self.admin)
        expected = f'href="{self.url}">creator</a>'
        for path in ["/moderation/", "/moderation/users/", "/moderation/activity/", "/moderation/reviews/?state=seen",
                     reverse("moderation-user", args=[self.author.pk]), reverse("moderation-item", args=[self.public.pk]),
                     reverse("item-edit", args=[self.public.pk])]:
            self.assertContains(self.client.get(path), expected)
        reviewer_link = f'href="{reverse("creator-profile", args=[self.reviewer.pk])}">reviewer</a>'
        self.assertContains(self.client.get("/moderation/reviews/?state=seen"), reviewer_link)
        self.assertContains(self.client.get(reverse("moderation-item", args=[self.public.pk])), reviewer_link)

    def test_deleted_editors_and_reviewers_render_without_broken_profile_links(self):
        Revision.objects.create(item=self.public, editor=None, snapshot={"title": "Older title"})
        mark_seen(self.reviewer, self.public, content_revision=self.public.content_revision)
        self.reviewer.delete()
        self.client.force_login(self.admin)
        self.assertContains(self.client.get(reverse("item-edit", args=[self.public.pk])), "Deleted account")
        self.assertContains(self.client.get(reverse("moderation-item", args=[self.public.pk])), "Deleted account")
