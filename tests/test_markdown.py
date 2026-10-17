from urllib.parse import parse_qs, urlsplit

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from django.urls import reverse

from hub.forms import ItemForm, ReleaseForm
from hub.links import protected_url, safe_web_url
from hub.markdown import MARKDOWN_HELP, render_markdown
from hub.models import ContentType, Item, Release


@override_settings(ALLOWED_HOSTS=["testserver"])
class MarkdownTests(SimpleTestCase):
    def setUp(self):
        self.request = RequestFactory().get("/items/example/")

    def test_basic_formatting_and_small_headings(self):
        output = render_markdown("# Notes\n\n**Bold** and *italic* with `code`\nnext line\n\n- One\n- Two\n\n1. First\n2. Second\n\n> Quote\n\n```\n<script>\n```", self.request)
        for part in ["<h4>Notes</h4>", "<strong>Bold</strong>", "<em>italic</em>", "<code>code</code>", "<br", "<ul>", "<ol>", "<blockquote>", "&lt;script&gt;"]:
            self.assertIn(part, output)
        self.assertNotIn("<h1", output)

    def test_raw_html_and_embedded_images_cannot_execute_or_load(self):
        for source in ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://example.com"></iframe>', '<svg/onload=alert(1)>', '![Tracker](https://example.com/tracker.png)', '<a data-confirm-external href="https://evil.example">Skip</a>']:
            with self.subTest(source=source):
                output = render_markdown(source, self.request)
                for tag in ["<script", "<img", "<iframe", "<svg", "<a data-confirm-external"]:
                    self.assertNotIn(tag, output)

    def test_dangerous_link_schemes_are_never_clickable(self):
        for target in ["javascript:alert%281%29", "jav&#x61;script:alert%281%29", "data:text/html,test", "vbscript:msgbox%281%29", "file:///etc/passwd", "mailto:hello@example.com"]:
            with self.subTest(target=target):
                self.assertNotIn("<a ", render_markdown(f"[Click]({target})", self.request))

    def test_external_links_use_warning_route_and_escape_attributes(self):
        source = '[Guide](https://example.com/path?a=1&b=2 "A &quot;quoted&quot; guide")'
        output = render_markdown(source, self.request)
        self.assertIn('href="/out/?url=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1%26b%3D2"', output)
        self.assertIn('title="A &quot;quoted&quot; guide"', output)
        self.assertIn('rel="nofollow ugc noopener noreferrer"', output)

    def test_internal_links_and_fragments_stay_direct(self):
        for target in ["/creators/1/", "#versions", "?q=parking", "http://testserver/items/", "http://testserver:80/items/"]:
            with self.subTest(target=target):
                self.assertEqual(protected_url(target, self.request), target)
        for target in ["https://testserver/items/", "http://testserver.evil.example/", "http://testserver:81/items/", "//example.com/path"]:
            with self.subTest(target=target):
                self.assertTrue(protected_url(target, self.request).startswith("/out/?url="))

    def test_url_validation_rejects_ambiguous_addresses(self):
        for target in ["https:///evil.example", "///evil.example", "https://cpchub.net@evil.example", "https://example.com:bad", "https://example.com:99999", "https://[broken", "https://exam\nple.com", "https://example.com/\u202eevil", "https://example.com\\@evil.example", "https://" + "a" * 4096]:
            with self.subTest(target=target):
                self.assertEqual(safe_web_url(target), "")


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False)
class MarkdownPageTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("writer")
        cls.item = Item.objects.create(author=cls.author, content_type=ContentType.objects.get(slug="blueprints"), title="Markdown sample", summary="Short **plain** summary", description="A **small lot**. [Guide](https://example.com/guide)")
        cls.release = Release.objects.create(item=cls.item, version="1.0", file="releases/example.cpbp", size=20, changelog="- Added *parking*\n- Fixed `entrance`")

    def test_item_description_and_changelog_render_but_api_keeps_source(self):
        response = self.client.get(self.item.get_absolute_url())
        self.assertContains(response, "<strong>small lot</strong>")
        self.assertContains(response, "<em>parking</em>")
        self.assertContains(response, "<code>entrance</code>")
        self.assertContains(response, "Short **plain** summary")
        response = self.client.get(f"/api/v1/items/{self.item.pk}/")
        self.assertEqual(response.json()["description"], self.item.description)
        self.assertEqual(response.json()["releases"][0]["changelog"], self.release.changelog)

    def test_authors_get_markdown_help_in_both_fields(self):
        self.assertEqual(ItemForm().fields["description"].help_text, MARKDOWN_HELP)
        self.assertEqual(ReleaseForm().fields["changelog"].help_text, MARKDOWN_HELP)

    def test_warning_page_is_explicit_and_works_without_javascript(self):
        target = "https://example.com/guide?one=1&two=2"
        response = self.client.get(reverse("outbound-link"), {"url": target})
        self.assertContains(response, "Leaving CPC Hub")
        self.assertContains(response, "Continue to site")
        self.assertContains(response, 'href="https://example.com/guide?one=1&amp;two=2"')
        self.assertNotIn("Location", response)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertNotContains(response, 'http-equiv="refresh"')

    def test_warning_page_rejects_bad_destinations_and_posts(self):
        for target in ["", "/", "javascript:alert(1)", "data:text/html,test", "https://user@example.com", "https://[broken"]:
            with self.subTest(target=target):
                self.assertEqual(self.client.get(reverse("outbound-link"), {"url": target}).status_code, 400)
        self.assertEqual(self.client.post(reverse("outbound-link"), {"url": "https://example.com"}).status_code, 405)

    @override_settings(KOFI_PAGE_URL="https://ko-fi.com/cpchub")
    def test_site_links_use_the_same_warning(self):
        response = self.client.get("/donate/")
        for target in ["https://github.com/cyberbalsa/cpchub", "https://balsa.info", "https://ko-fi.com/cpchub"]:
            url = protected_url(target, RequestFactory().get("/"))
            self.assertContains(response, f'href="{url}"')
            self.assertEqual(parse_qs(urlsplit(url).query)["url"], [target])
        self.assertContains(response, 'id="external-warning"', count=1)
