"""Public search metadata and stable, permission-checked share images."""
import json
from urllib.parse import urlencode

from django.conf import settings
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404
from django.templatetags.static import static
from django.urls import reverse
from django.utils.html import format_html
from django.utils.safestring import mark_safe
from rest_framework.exceptions import NotFound
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe

from .access import public_items
from .file_delivery import StorageUnavailable, file_response

SITE_TITLE = "CPC Hub | Car Park Capital blueprints and scenarios"
SITE_DESCRIPTION = "Share and download fan-made blueprints and scenarios for Car Park Capital. Browse screenshots, save creations, and find new builds for your game."
STATIC_PAGES = {
    "catalog": (SITE_TITLE, SITE_DESCRIPTION),
    "donate": ("Support CPC Hub | Hosting and storage", "Help cover CPC Hub's $45 monthly hosting and storage costs with an optional Ko-fi tip."),
    "developers": ("CPC Hub API | Mod manager developer guide", "Connect a mod manager to CPC Hub. Browse creations, download releases, and manage uploads with API keys or OAuth."),
}


def absolute_url(path):
    return settings.PUBLIC_URL.rstrip("/") + path


def published_items():
    return public_items().filter(is_demo=False).order_by()


def metadata(*, title=SITE_TITLE, description=SITE_DESCRIPTION, path="/", indexable=False):
    return {
        "title": title, "description": description, "canonical": absolute_url(path),
        "robots": "index, follow, max-image-preview:large" if indexable else "noindex, follow",
        "indexable": indexable, "image": absolute_url(static("art/share-card.png")),
        "image_type": "image/png", "image_width": 1200, "image_height": 630,
        "image_alt": "CPC Hub: Car Park Capital blueprints and scenarios", "type": "website",
    }


def structured_data(*nodes):
    # Escape script delimiters, including user-supplied titles and usernames.
    payload = json.dumps({"@context": "https://schema.org", "@graph": nodes}, ensure_ascii=False)
    payload = payload.translate(str.maketrans({"<": "\\u003C", ">": "\\u003E", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029"}))
    return format_html('<script type="application/ld+json">{}</script>', mark_safe(payload))


def context(request):
    name = getattr(request.resolver_match, "url_name", "")
    title, description = STATIC_PAGES.get(name, (SITE_TITLE, SITE_DESCRIPTION))
    seo = metadata(title=title, description=description, path=request.path, indexable=name in STATIC_PAGES and not request.GET)
    if seo["indexable"]:
        seo["structured_data"] = structured_data({"@type": "WebPage", "name": title, "url": seo["canonical"], "description": description})
    if not hasattr(request, "seo_indexable"):
        request.seo_indexable = seo["indexable"]
    return {"seo": seo}


def _apply(request, seo):
    request.seo_indexable = seo["indexable"]
    return seo


def _page_path(path, page):
    return path + ("?" + urlencode({"page": page.number}) if page.number > 1 else "")


def catalog_metadata(request, page):
    # Search/filter combinations remain crawlable, but do not compete with items.
    filtered = any(values and not (key == "page" or key == "sort" and values == ["updated"] or key == "view" and values == ["all"]) for key, values in request.GET.lists() if any(values))
    seo = metadata(path=_page_path("/", page), indexable=not filtered)
    if page.number > 1:
        seo["title"] = f"Car Park Capital creations, page {page.number} | CPC Hub"
    if not filtered:
        seo["structured_data"] = structured_data(
            {"@type": "WebSite", "@id": absolute_url("/#website"), "url": absolute_url("/"), "name": "CPC Hub", "alternateName": "Car Park Capital Hub", "description": SITE_DESCRIPTION},
            {"@type": "CollectionPage", "name": seo["title"], "url": seo["canonical"], "isPartOf": {"@id": absolute_url("/#website")}},
        )
    return _apply(request, seo)


def item_metadata(request, item):
    visible = published_items().filter(pk=item.pk).exists()
    if not visible:
        return _apply(request, metadata(title="Private creation | CPC Hub", path=item.get_absolute_url()))
    description = f"{item.summary.strip()} By {item.author.username}.".strip()
    seo = metadata(title=f"{item.title} | Car Park Capital | CPC Hub", description=description, path=item.get_absolute_url(), indexable=True)
    shot = item.screenshots.first()
    if shot:
        seo.update(image=absolute_url(reverse("share-image", args=[item.pk, shot.pk])), image_type="image/webp", image_alt=shot.caption or f"{item.title} by {item.author.username}", image_width=None, image_height=None)
    creator_url = absolute_url(reverse("creator-profile", args=[item.author_id]))
    work = {
        "@type": "CreativeWork", "@id": seo["canonical"] + "#creation", "url": seo["canonical"],
        "name": item.title, "description": item.summary, "image": seo["image"],
        "author": {"@type": "Person", "name": item.author.username, "url": creator_url},
        "datePublished": item.created_at.isoformat(), "dateModified": max(item.updated_at, item.review_requested_at).isoformat(),
        "genre": item.content_type.name, "isAccessibleForFree": True,
        "about": {"@type": "VideoGame", "name": "Car Park Capital"},
    }
    if item.latest_release:
        work["version"] = item.latest_release.version
    seo["structured_data"] = structured_data(
        work, {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "CPC Hub", "item": absolute_url("/")},
            {"@type": "ListItem", "position": 2, "name": item.title, "item": seo["canonical"]},
        ]},
    )
    return _apply(request, seo)


def creator_metadata(request, creator, page):
    visible = published_items().filter(author=creator).exists()
    seo = metadata(title=f"{creator.username}'s Car Park Capital creations | CPC Hub", description=f"Browse blueprints and scenarios shared by {creator.username} on CPC Hub.", path=_page_path(reverse("creator-profile", args=[creator.pk]), page), indexable=visible and not any(key != "page" for key in request.GET))
    if seo["indexable"]:
        seo["structured_data"] = structured_data({"@type": "ProfilePage", "url": seo["canonical"], "mainEntity": {"@type": "Person", "name": creator.username, "url": absolute_url(reverse("creator-profile", args=[creator.pk]))}})
    return _apply(request, seo)


@never_cache
@require_safe
def share_image(request, pk, screenshot_id):
    # This endpoint is public-only, even when the requester is the author or staff.
    item = get_object_or_404(published_items(), pk=pk)
    shot = get_object_or_404(item.screenshots, pk=screenshot_id)
    try:
        response = file_response(shot.image, method=request.method, content_type="image/webp")
    except NotFound as exc:
        raise Http404 from exc
    except StorageUnavailable:
        return HttpResponse("The screenshot is temporarily unavailable.", status=503)
    response["X-Robots-Tag"] = "index, max-image-preview:large"
    return response


@require_safe
def robots(request):
    lines = ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /o/", "Disallow: /admin/", "Disallow: /moderation/", "", "Sitemap: " + absolute_url(reverse("sitemap-index")), ""]
    return HttpResponse("\n".join(lines), content_type="text/plain; charset=utf-8")


class SearchIndexMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if response.status_code >= 400 or not getattr(request, "seo_indexable", False):
            response.setdefault("X-Robots-Tag", "noindex, follow")
        else:
            response.setdefault("X-Robots-Tag", "index, follow, max-image-preview:large")
        return response
