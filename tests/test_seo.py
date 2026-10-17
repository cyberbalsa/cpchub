import json
import re
from html.parser import HTMLParser
from unittest.mock import patch
from xml.etree import ElementTree

from django.contrib.auth import get_user_model
from django.http import HttpResponseRedirect
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.exceptions import NotFound

from hub.file_delivery import StorageUnavailable
from hub.models import ContentType, Item, Screenshot, SitemapEntry, SitemapState, UserModeration
from hub.sitemaps import build_snapshot


class MetadataParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.meta = {}
        self.canonical = ""
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            self.meta[attrs.get("property", attrs.get("name"))] = attrs.get("content")
        elif tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs["href"]


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, PUBLIC_URL="https://cpchub.net", STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
})
class SearchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user('Creator </script><script>alert(1)</script>')
        cls.other = get_user_model().objects.create_user("Other creator")
        cls.admin = get_user_model().objects.create_superuser("admin", "admin@example.com", "test-only")
        category = ContentType.objects.get(slug="blueprints")
        cls.item = Item.objects.create(author=cls.author, content_type=category, title='Lot </script><script>alert(1)</script>', summary='A lot with "trees" & parking.', description="Test")
        cls.second = Item.objects.create(author=cls.author, content_type=category, title="Second lot", summary="Another lot", description="Test")
        cls.shot = Screenshot.objects.create(item=cls.item, image="", caption='A "screenshot" <caption>')
        cls.private = Item.objects.create(author=cls.other, content_type=category, title="Private test lot", status="draft", description="Private")

    def metadata(self, path):
        response = self.client.get(path)
        return response, MetadataParser(response.content.decode())

    def test_item_share_metadata_uses_canonical_public_urls_and_escaped_json(self):
        response, meta = self.metadata(self.item.get_absolute_url() + "?tracking=example")
        self.assertEqual(meta.canonical, "https://cpchub.net" + self.item.get_absolute_url())
        self.assertEqual(meta.meta["og:url"], meta.canonical)
        self.assertIn(self.item.title, meta.meta["og:title"])
        self.assertIn(self.author.username, meta.meta["og:description"])
        self.assertEqual(meta.meta["og:image"], "https://cpchub.net" + reverse("share-image", args=[self.item.pk, self.shot.pk]))
        self.assertNotIn("Signature", meta.meta["og:image"])
        self.assertEqual(meta.meta["twitter:card"], "summary_large_image")
        self.assertIn("max-image-preview:large", response["X-Robots-Tag"])
        html = response.content.decode()
        self.assertNotIn("</script><script>alert(1)</script>", html)
        payload = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S).group(1)
        data = json.loads(payload)["@graph"]
        self.assertEqual(data[0]["name"], self.item.title)
        self.assertEqual(data[0]["@type"], "CreativeWork")
        self.assertEqual(data[1]["@type"], "BreadcrumbList")

    def test_general_pages_have_branded_cards_and_descriptions(self):
        for path in ["/", "/donate/", "/developers/"]:
            with self.subTest(path=path):
                response, meta = self.metadata(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(meta.canonical, "https://cpchub.net" + path)
                self.assertTrue(meta.meta["description"])
                self.assertTrue(meta.meta["og:image"].endswith("/art/share-card.png"))
                self.assertEqual(meta.meta["og:image:width"], "1200")
                self.assertEqual(meta.meta["og:image:height"], "630")
                self.assertTrue(meta.meta["robots"].startswith("index,"))

    def test_private_items_and_account_filters_are_not_indexable(self):
        self.client.force_login(self.other)
        response, meta = self.metadata(self.private.get_absolute_url())
        self.assertTrue(meta.meta["robots"].startswith("noindex"))
        self.assertNotIn(self.private.title, meta.meta["og:title"])
        for path in ["/?q=parking", "/?view=mine", "/?min_width=1", "/account/profile/", "/account/keys/", "/out/?url=https://example.com"]:
            with self.subTest(path=path):
                self.assertIn("noindex", self.client.get(path)["X-Robots-Tag"])
        self.assertIn("noindex", self.client.get("/not-a-page/")["X-Robots-Tag"])

    def test_catalog_pagination_has_its_own_canonical_url(self):
        Item.objects.bulk_create([Item(author=self.author, content_type=self.item.content_type, title=f"Extra {i}") for i in range(15)])
        response, meta = self.metadata("/?page=2")
        self.assertEqual(meta.canonical, "https://cpchub.net/?page=2")
        self.assertTrue(meta.meta["robots"].startswith("index,"))
        _, meta = self.metadata("/?page=1&sort=updated")
        self.assertEqual(meta.canonical, "https://cpchub.net/")

    def test_creator_page_schema_and_empty_profiles(self):
        response, meta = self.metadata(reverse("creator-profile", args=[self.author.pk]))
        self.assertTrue(meta.meta["robots"].startswith("index,"))
        self.assertContains(response, '"@type": "ProfilePage"')
        _, meta = self.metadata(reverse("creator-profile", args=[self.other.pk]))
        self.assertTrue(meta.meta["robots"].startswith("noindex"))

    @patch("hub.seo.file_response")
    def test_share_image_checks_public_visibility_even_for_staff(self, deliver):
        url = reverse("share-image", args=[self.item.pk, self.shot.pk])
        deliver.return_value = HttpResponseRedirect("https://example.wasabisys.com/signed")
        self.assertEqual(self.client.get(url).status_code, 302)
        deliver.assert_called_once()
        self.client.force_login(self.admin)
        for changes in [{"status": "draft"}, {"is_hidden": True, "hidden_reason": "Staff reason"}, {"deleted_at": timezone.now()}, {"is_demo": True}]:
            with self.subTest(changes=changes):
                Item.objects.filter(pk=self.item.pk).update(status="published", is_hidden=False, deleted_at=None, is_demo=False)
                Item.objects.filter(pk=self.item.pk).update(**changes)
                self.assertEqual(self.client.get(url).status_code, 404)
        Item.objects.filter(pk=self.item.pk).update(is_demo=False)
        UserModeration.objects.create(user=self.author, shadow_banned_at=timezone.now())
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(deliver.call_count, 1)

    @patch("hub.seo.file_response")
    def test_share_image_handles_missing_files_and_storage_outages(self, deliver):
        url = reverse("share-image", args=[self.item.pk, self.shot.pk])
        deliver.side_effect = NotFound()
        self.assertEqual(self.client.get(url).status_code, 404)
        deliver.side_effect = StorageUnavailable()
        self.assertEqual(self.client.get(url).status_code, 503)

    @override_settings(SITEMAP_PAGE_SIZE=2)
    def test_sitemap_index_and_children_are_paginated_without_duplicates(self):
        self.assertEqual(build_snapshot(), 7)  # Four static pages, two items, one author.
        root = ElementTree.fromstring(self.client.get("/sitemap.xml").content)
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        links = [node.text for node in root.findall("s:sitemap/s:loc", ns)]
        self.assertEqual(links, [f"https://cpchub.net/sitemap-{n}.xml" for n in [1, 2, 3, 4]])
        urls = []
        for link in links:
            response = self.client.get(link.removeprefix("https://cpchub.net"))
            self.assertIn("no-store", response["Cache-Control"])
            page = ElementTree.fromstring(response.content)
            entries = page.findall("s:url", ns)
            self.assertEqual(len(entries), 1 if link.endswith("sitemap-4.xml") else 2)
            urls.extend(node.find("s:loc", ns).text for node in entries)
        self.assertEqual(len(urls), len(set(urls)))
        self.assertIn("https://cpchub.net" + self.item.get_absolute_url(), urls)
        self.assertNotIn("https://cpchub.net" + self.private.get_absolute_url(), urls)
        self.assertEqual(self.client.get("/sitemap-0.xml").status_code, 404)
        self.assertEqual(self.client.get("/sitemap-5.xml").status_code, 404)

    def test_visibility_changes_remove_snapshot_urls_immediately(self):
        build_snapshot()
        stamp = SitemapState.objects.get(pk=1).generated_at
        self.client.force_login(self.admin)
        Item.objects.filter(pk=self.item.pk).update(is_hidden=True, hidden_reason="Removed")
        Item.objects.filter(pk=self.second.pk).update(status="draft")
        response = self.client.get("/sitemap-1.xml")
        self.assertNotContains(response, self.item.get_absolute_url())
        self.assertNotContains(response, self.second.get_absolute_url())
        self.assertNotContains(response, reverse("creator-profile", args=[self.author.pk]))
        self.assertEqual(SitemapState.objects.get(pk=1).generated_at, stamp)
        Item.objects.filter(pk__in=[self.item.pk, self.second.pk]).update(status="published", is_hidden=False)
        UserModeration.objects.create(user=self.author, shadow_banned_at=timezone.now())
        self.assertNotContains(self.client.get("/sitemap-1.xml"), self.item.get_absolute_url())

    def test_snapshot_keeps_real_modification_dates_and_rebuild_is_atomic(self):
        build_snapshot()
        before = list(SitemapEntry.objects.values_list("path", flat=True))
        entry = SitemapEntry.objects.get(item=self.item)
        self.assertEqual(entry.last_modified, max(self.item.updated_at, self.item.review_requested_at))
        with patch("hub.sitemaps.SitemapEntry.objects.bulk_create", side_effect=RuntimeError("test interruption")):
            with self.assertRaises(RuntimeError):
                build_snapshot()
        self.assertEqual(list(SitemapEntry.objects.values_list("path", flat=True)), before)
        with patch("hub.sitemaps.build_snapshot") as rebuild:
            self.assertEqual(self.client.get("/sitemap.xml").status_code, 200)
            rebuild.assert_not_called()

    def test_first_request_builds_snapshot_and_robots_points_to_index(self):
        self.assertFalse(SitemapState.objects.exists())
        self.assertEqual(self.client.get("/sitemap.xml").status_code, 200)
        self.assertEqual(SitemapState.objects.count(), 1)
        response = self.client.get("/robots.txt")
        self.assertContains(response, "Sitemap: https://cpchub.net/sitemap.xml")
        self.assertNotContains(response, "Disallow: /share/")
