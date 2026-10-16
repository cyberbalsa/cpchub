from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from hub.access import item_query
from hub.models import Bookmark, ContentType, Item, Release


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False)
class CollectionCountTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("creator")
        cls.collectors = [get_user_model().objects.create_user(f"collector-{i}") for i in range(2)]
        cls.item = Item.objects.create(
            author=cls.author, content_type=ContentType.objects.get(slug="blueprints"),
            title="Station parking", summary="Parking by the station", description="A parking blueprint.",
            downloads=7, featured_at=timezone.now(),
        )
        cls.empty_item = Item.objects.create(author=cls.author, content_type=cls.item.content_type, title="Unsaved lot")
        cls.url = reverse("api-item-detail", args=[cls.item.pk])
        cls.save_url = reverse("bookmark", args=[cls.item.pk])

    def save_for_collectors(self):
        for collector in self.collectors:
            Bookmark.objects.get_or_create(user=collector, item=self.item)

    def test_counts_current_people_without_per_item_queries(self):
        self.save_for_collectors()
        self.save_for_collectors()
        self.assertEqual(self.item.collection_count, 2)
        with self.assertNumQueries(3):
            counts = {item.pk: item.collection_count for item in item_query()}
        self.assertEqual(counts, {self.item.pk: 2, self.empty_item.pk: 0})
        self.collectors[0].delete()
        self.assertEqual(item_query().get(pk=self.item.pk).collection_count, 1)

    def test_catalog_saved_collection_and_highlights_keep_total(self):
        self.save_for_collectors()
        for version, size in [("1", 512), ("2", 1536)]:
            Release.objects.create(item=self.item, version=version, file=f"releases/fixture-{version}.json", original_filename="lot.json", sha256="a" * 64, size=size)
        response = self.client.get("/")
        self.assertEqual(response.context["stats"], {"items": 2, "downloads": 7, "authors": 1})
        self.assertEqual(response.context["site_totals"], {"uploads": 2, "total_bytes": 2048})
        self.assertEqual(response.context["featured_items"][0].collection_count, 2)
        self.assertContains(response, 'title="Saved by 2 people"', count=2)
        self.assertContains(response, 'title="Saved by 0 people"')
        self.client.force_login(self.collectors[0])
        for headers in [{}, {"HTTP_HX_REQUEST": "true"}]:
            response = self.client.get("/?view=saved", **headers)
            self.assertEqual(response.context["page_obj"].paginator.count, 1)
            self.assertEqual(response.context["page_obj"][0].collection_count, 2)
            self.assertContains(response, 'title="Saved by 2 people"', count=1)

    def test_save_and_remove_refresh_button_and_count(self):
        self.assertContains(self.client.get(self.item.get_absolute_url()), "Saved by 0 people")
        self.client.force_login(self.collectors[0])
        response = self.client.post(self.save_url, HTTP_HX_REQUEST="true")
        self.assertContains(response, "Saved by 1 person")
        self.assertContains(response, "★ Saved")
        self.assertContains(response, 'id="bookmark-control"', count=1)
        self.assertContains(response, 'hx-target="#bookmark-control"')
        Bookmark.objects.create(user=self.collectors[1], item=self.item)
        self.assertContains(self.client.get(self.item.get_absolute_url()), "Saved by 2 people")
        response = self.client.post(self.save_url, HTTP_HX_REQUEST="true")
        self.assertContains(response, "Saved by 1 person")
        self.assertContains(response, "☆ Save creation")
        self.assertFalse(Bookmark.objects.filter(user=self.collectors[0], item=self.item).exists())
        self.client.force_login(self.collectors[1])
        response = self.client.post(self.save_url, follow=True)
        self.assertContains(response, "Saved by 0 people")

    def test_api_count_is_read_only_and_matches_list_and_detail(self):
        self.save_for_collectors()
        api = APIClient()
        self.assertEqual(api.get(self.url).data["collection_count"], 2)
        counts = {item["id"]: item["collection_count"] for item in api.get("/api/v1/items/").data["results"]}
        self.assertEqual(counts, {str(self.item.pk): 2, str(self.empty_item.pk): 0})
        api.force_login(self.author)
        response = api.patch(self.url, {"title": "Station lot", "collection_count": 9000}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["collection_count"], 2)
        response = api.post("/api/v1/items/", {
            "title": "New lot", "summary": "A new lot", "description": "A parking blueprint.",
            "content_type": "blueprints", "collection_count": 9000,
        }, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["collection_count"], 0)
