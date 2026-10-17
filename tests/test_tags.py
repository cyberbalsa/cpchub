from importlib import import_module
from types import SimpleNamespace
from urllib.parse import urlencode

from django.apps import apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import connection
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from hub.access import item_query
from hub.forms import ItemForm
from hub.models import APIKey, Bookmark, ContentType, Item, ModerationLog, Release, Tag, TagSettings, UserModeration
from hub.tags import clean_tags, public_tags, tag_names


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False)
class TagTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("tag-author")
        cls.other = get_user_model().objects.create_user("tag-other")
        cls.admin = get_user_model().objects.create_user("tag-admin")
        cls.admin.groups.add(Group.objects.get(name="Admin"))
        cls.category = ContentType.objects.get(slug="blueprints")

    def setUp(self):
        self.api = APIClient()

    def item(self, tags="parking", **fields):
        return Item.objects.create(**{"author": self.author, "content_type": self.category,
                                      "title": "A creation", "tags": tags, **fields})

    def threshold(self, count):
        TagSettings.objects.update_or_create(pk=1, defaults={"minimum_items": count})

    def test_tag_names_normalize_case_spaces_unicode_and_duplicates(self):
        self.assertEqual(clean_tags(" Parking , PARKING,  city   block, , Ｐａｒｋｉｎｇ"), "parking, city block")
        item = self.item("Parking, PARKING, city  block")
        self.assertEqual(list(item.tag_index.values_list("name", flat=True)), ["city block", "parking"])
        item.tags = "waterfront, city block"
        item.save(update_fields=["tags"])
        self.assertEqual(list(item.tag_index.values_list("name", flat=True)), ["city block", "waterfront"])
        item.tags = "unsaved"
        item.save(update_fields=["title"])
        self.assertFalse(item.tag_index.filter(name="unsaved").exists())

    def test_default_threshold_requires_eleven_distinct_visible_creations(self):
        items = [self.item() for _ in range(10)]
        for version in ["1", "2"]:
            Release.objects.create(item=items[0], version=version, size=1)
        self.assertFalse(public_tags().exists())
        last = self.item("PARKING, parking")
        self.assertEqual(public_tags().get().item_count, 11)
        self.assertEqual(item_query().get(pk=last.pk).public_tag_list, ["parking"])
        last.tags = "different"
        last.save(update_fields=["tags"])
        self.assertFalse(public_tags().exists())

    def test_private_and_demo_creations_never_count(self):
        self.threshold(2)
        public = self.item()
        self.item(status="draft")
        self.item(is_hidden=True, hidden_reason="Hidden")
        self.item(deleted_at=timezone.now())
        self.item(is_demo=True)
        self.item(author=self.other)
        UserModeration.objects.create(user=self.other, shadow_banned_at=timezone.now())
        self.assertFalse(public_tags().exists())
        self.threshold(1)
        self.assertEqual(public_tags().get().item_count, 1)
        public.delete()
        self.assertFalse(public_tags().exists())

    def test_visibility_changes_immediately_change_tag_publication(self):
        self.threshold(1)
        item = self.item()
        changes = [{"status": "draft"}, {"is_hidden": True, "hidden_reason": "Review"}, {"deleted_at": timezone.now()}]
        for change in changes:
            with self.subTest(change=change):
                Item.objects.filter(pk=item.pk).update(**change)
                self.assertFalse(public_tags().exists())
                Item.objects.filter(pk=item.pk).update(status="published", is_hidden=False, hidden_reason="", deleted_at=None)
                self.assertTrue(public_tags().exists())
        state = UserModeration.objects.create(user=self.author, shadow_banned_at=timezone.now())
        self.assertFalse(public_tags().exists())
        state.delete()
        self.assertTrue(public_tags().exists())

    def test_public_tag_search_matches_whole_normalized_tags(self):
        self.threshold(1)
        exact = self.item("parking")
        self.item("parking lot")
        self.item("other", title="Parking in the title")
        response = self.api.get("/api/v1/items/", {"tag": " PARKING "})
        self.assertEqual([row["id"] for row in response.data["results"]], [str(exact.pk)])
        response = self.client.get("/", {"tag": " PARKING "})
        self.assertEqual(list(response.context["page_obj"]), [exact])
        self.assertContains(response, '/?tag=parking')
        self.assertContains(response, 'name="tag" value="parking"')

    def test_unpublished_tags_do_not_appear_in_public_html_api_or_search(self):
        item = self.item("uncommon")
        for url in ["/", item.get_absolute_url(), reverse("creator-profile", args=[self.author.pk])]:
            self.assertNotContains(self.client.get(url), "uncommon")
        self.assertEqual(self.api.get(f"/api/v1/items/{item.pk}/").data["tags"], "")
        self.assertEqual(self.api.get("/api/v1/tags/").data["count"], 0)
        for query in [{"tag": "uncommon"}, {"q": "uncommon"}]:
            self.assertEqual(self.api.get("/api/v1/items/", query).data["count"], 0)
            self.assertEqual(self.client.get("/", query).context["page_obj"].paginator.count, 0)
        self.threshold(1)
        self.assertContains(self.client.get(item.get_absolute_url()), '/?tag=uncommon')
        self.assertEqual(self.api.get("/api/v1/items/", {"q": "uncommon"}).data["count"], 1)

    def test_public_tag_list_filters_and_reports_global_counts(self):
        self.threshold(1)
        item = self.item("parking, urban")
        self.item("parking")
        self.item("parking", status="draft")
        response = self.api.get("/api/v1/tags/", {"q": " PARK "})
        self.assertEqual(response.data["results"], [{"name": "parking", "item_count": 2}])
        self.assertIn("no-store", response["Cache-Control"])
        tags = item_query().filter(pk=item.pk).first()._public_tags
        self.assertEqual({tag.name: tag.item_count for tag in tags}, {"parking": 2, "urban": 1})

    def test_editing_suggestions_include_uncommon_public_and_own_private_tags_only(self):
        self.item("public-uncommon", author=self.other)
        self.item("own-draft", status="draft")
        self.item("own-deleted", deleted_at=timezone.now())
        self.item("private-draft", author=self.other, status="draft")
        self.item("private-hidden", author=self.other, is_hidden=True, hidden_reason="Reason")
        self.item("private-deleted", author=self.other, deleted_at=timezone.now())
        self.item("demo-only", author=self.other, is_demo=True)
        url = "/api/v1/tags/suggest/"
        self.assertEqual(self.api.get(url).status_code, 401)
        self.api.force_login(self.author)
        response = self.api.get(url)
        self.assertEqual({tag["name"] for tag in response.data}, {"public-uncommon", "own-draft", "own-deleted"})
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(self.api.get(url, {"q": "PUBLIC"}).data, [{"name": "public-uncommon"}])
        UserModeration.objects.create(user=self.other, shadow_banned_at=timezone.now())
        self.assertNotIn({"name": "public-uncommon"}, self.api.get(url).data)

    def test_suggestions_require_read_scope_and_limit_results(self):
        for index in range(25):
            self.item(f"tag-{index}")
        _, raw = APIKey.issue(user=self.author, name="writer", scopes=["write"])
        self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + raw)
        self.assertEqual(self.api.get("/api/v1/tags/suggest/").status_code, 403)
        _, raw = APIKey.issue(user=self.author, name="reader", scopes=["read"])
        self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + raw)
        self.assertEqual(len(self.api.get("/api/v1/tags/suggest/").data), 20)

    def test_owner_private_tag_search_and_api_edits_keep_index_current(self):
        item = self.item("private", status="draft")
        self.item("private", author=self.other, status="draft")
        self.api.force_login(self.author)
        self.assertEqual(self.api.get("/api/v1/items/", {"mine": "true", "tag": "private"}).data["count"], 1)
        url = f"/api/v1/items/{item.pk}/"
        self.assertEqual(self.api.get(url).data["tags"], "private")
        response = self.api.patch(url, {"tags": "New, NEW, second"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["tags"], "new, second")
        self.assertEqual(set(item.tag_index.values_list("name", flat=True)), {"new", "second"})
        item.refresh_from_db()
        self.assertTrue(item.needs_review)
        self.client.force_login(self.author)
        self.assertEqual(self.client.get("/", {"view": "mine", "tag": "new"}).context["page_obj"].paginator.count, 1)

    def test_upload_edit_and_staff_forms_offer_tag_suggestions(self):
        item = self.item(status="draft")
        self.client.force_login(self.author)
        for url in ["/upload/", reverse("item-edit", args=[item.pk])]:
            response = self.client.get(url)
            self.assertContains(response, 'data-tag-input="/api/v1/tags/suggest/"')
            self.assertContains(response, "11 published creations")
        form = ItemForm(data={"title": "New", "content_type": self.category.pk, "summary": "A lot", "description": "A lot", "tags": " PARKING, parking ", "status": "draft"})
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["tags"], "parking")

    def test_tag_filter_combines_with_collection_type_query_sort_and_pagination(self):
        self.threshold(1)
        for index in range(13):
            item = self.item("parking", title=f"Lot {index}")
            Bookmark.objects.create(user=self.author, item=item)
        self.item("parking lot", title="Lot outside filter")
        self.client.force_login(self.author)
        params = {"view": "saved", "tag": "parking", "type": "blueprints", "q": "Lot", "sort": "newest"}
        response = self.client.get("/?" + urlencode(params), HTTP_HX_REQUEST="true")
        self.assertEqual(response.context["page_obj"].paginator.count, 13)
        self.assertContains(response, "tag=parking")
        self.assertContains(response, "page=2")
        self.assertNotContains(response, "<!doctype")
        response = self.client.get("/", {**params, "page": 2}, HTTP_HX_REQUEST="true", HTTP_HX_HISTORY_RESTORE_REQUEST="true")
        self.assertContains(response, "<!doctype")
        self.assertEqual(len(response.context["page_obj"]), 1)

    def test_only_admin_can_change_threshold_and_change_is_logged(self):
        url = reverse("moderation-tag-settings")
        for role in [None, "Reviewer", "Moderator"]:
            self.other.groups.clear()
            if role:
                self.other.groups.add(Group.objects.get(name=role))
            self.client.force_login(self.other)
            self.assertEqual(self.client.get(url).status_code, 403)
            self.assertEqual(self.client.post(url, {"minimum_items": 1}).status_code, 403)
        self.client.force_login(self.admin)
        self.item()
        self.assertContains(self.client.get(url), "Minimum public creations")
        for invalid in [0, -1, "", 10001]:
            self.assertEqual(self.client.post(url, {"minimum_items": invalid}).status_code, 200)
            self.assertEqual(TagSettings.objects.get(pk=1).minimum_items, 11)
        self.assertEqual(self.client.post(url, {"minimum_items": 1}).status_code, 302)
        self.assertTrue(public_tags().exists())
        log = ModerationLog.objects.get(action="change tag threshold")
        self.assertEqual(log.actor, self.admin)
        self.assertIn("from 11 to 1", log.reason)

    def test_backfill_preserves_legacy_metadata_and_indexes_existing_tags(self):
        item = self.item("")
        Item.objects.filter(pk=item.pk).update(tags=" Parking , PARKING, city  block")
        migration = import_module("hub.migrations.0013_tag_search")
        migration.index_existing_tags(apps, SimpleNamespace(connection=connection))
        migration.index_existing_tags(apps, SimpleNamespace(connection=connection))
        item.refresh_from_db()
        self.assertEqual(item.tags, " Parking , PARKING, city  block")
        self.assertEqual(set(item.tag_index.values_list("name", flat=True)), {"parking", "city block"})
