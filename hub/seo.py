"""Public search metadata and stable, permission-checked share images."""
import json
from urllib.parse import urlencode

from django.conf import settings
from django.http import Http404, HttpResponse, HttpResponsePermanentRedirect
from django.shortcuts import get_object_or_404
from django.template.loader import render_to_string
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
PUBLIC_ROBOTS = "index, follow, max-image-preview:large, max-snippet:-1"
STATIC_PAGES = {
    "install": ("Install Car Park Capital blueprints and scenarios | CPC Hub", "Install Car Park Capital blueprints in assets/blueprints and scenarios in saves/scenarios. Find the folders on Windows and Linux."),
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
        "robots": PUBLIC_ROBOTS if indexable else "noindex, follow",
        "indexable": indexable, "image": absolute_url(static("art/share-card.png")),
        "logo": absolute_url(static("art/logo.png")),
        "image_type": "image/png", "image_width": 1200, "image_height": 630,
        "image_alt": "CPC Hub: Car Park Capital blueprints and scenarios", "type": "website",
    }


def site_entities():
    return [
        {"@type": "Organization", "@id": absolute_url("/#organization"), "name": "CPC Hub",
         "url": absolute_url("/"), "description": "Fan-made Car Park Capital blueprint and scenario community.",
         "logo": {"@type": "ImageObject", "url": absolute_url(static("art/logo.png")), "width": 512, "height": 512}},
        {"@type": "WebSite", "@id": absolute_url("/#website"), "url": absolute_url("/"),
         "name": "CPC Hub", "alternateName": "Car Park Capital Hub", "description": SITE_DESCRIPTION,
         "inLanguage": "en", "publisher": {"@id": absolute_url("/#organization")}},
    ]


def webpage(seo, page_type="WebPage"):
    return {"@type": page_type, "@id": seo["canonical"] + "#webpage", "url": seo["canonical"],
            "name": seo["title"], "description": seo["description"], "inLanguage": "en",
            "isPartOf": {"@id": absolute_url("/#website")}, "primaryImageOfPage": {
                "@type": "ImageObject", "url": seo["image"], "caption": seo["image_alt"],
            }}


def has_content_query(request, allowed=()):
    # Campaign tags do not change the content or its canonical URL.
    tracking = {"gclid", "dclid", "fbclid", "msclkid"}
    return any(key not in allowed and key not in tracking and not key.startswith("utm_")
               for key, values in request.GET.lists() if any(values))


def structured_data(*nodes):
    # Escape script delimiters, including user-supplied titles and usernames.
    payload = json.dumps({"@context": "https://schema.org", "@graph": nodes}, ensure_ascii=False)
    payload = payload.translate(str.maketrans({"<": "\\u003C", ">": "\\u003E", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029"}))
    return format_html('<script type="application/ld+json">{}</script>', mark_safe(payload))


def context(request):
    name = getattr(request.resolver_match, "url_name", "")
    title, description = STATIC_PAGES.get(name, (SITE_TITLE, SITE_DESCRIPTION))
    seo = metadata(title=title, description=description, path=request.path, indexable=name in STATIC_PAGES and not has_content_query(request))
    if seo["indexable"]:
        seo["structured_data"] = structured_data(webpage(seo), *site_entities())
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
    filtered = has_content_query(request, allowed=("page", "sort", "view")) or any(
        values != [default] for key, default in (("sort", "updated"), ("view", "all"))
        if any(values := request.GET.getlist(key))
    )
    seo = metadata(path=_page_path("/", page), indexable=not filtered)
    if page.number > 1:
        seo["title"] = f"Car Park Capital creations, page {page.number} | CPC Hub"
        seo["description"] = f"Browse page {page.number} of community blueprints and scenarios for Car Park Capital."
    if not filtered:
        seo["structured_data"] = structured_data(
            *site_entities(), webpage(seo, "CollectionPage"),
        )
    return _apply(request, seo)


def item_metadata(request, item):
    visible = published_items().filter(pk=item.pk).exists()
    if not visible:
        return _apply(request, metadata(title="Private creation | CPC Hub", path=item.get_absolute_url()))
    kind = {"blueprints": "blueprint", "scenarios": "scenario"}.get(item.content_type.slug, "creation")
    description = f"{item.summary.strip() or f'Download this Car Park Capital {kind}.'} By {item.author.username}."
    seo = metadata(title=f"{item.title} | Car Park Capital {kind} | CPC Hub", description=description, path=item.get_absolute_url(), indexable=True)
    seo["author"] = item.author.username
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
        "mainEntityOfPage": {"@id": seo["canonical"] + "#webpage"},
        "about": {"@type": "VideoGame", "name": "Car Park Capital"},
    }
    if item.latest_release:
        work["version"] = item.latest_release.version
    seo["structured_data"] = structured_data(
        work, {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "CPC Hub", "item": absolute_url("/")},
            {"@type": "ListItem", "position": 2, "name": item.title, "item": seo["canonical"]},
        ]}, webpage(seo), *site_entities(),
    )
    return _apply(request, seo)


def creator_metadata(request, creator, page):
    visible = published_items().filter(author=creator).exists()
    seo = metadata(title=f"{creator.username}'s Car Park Capital creations | CPC Hub", description=f"Browse blueprints and scenarios shared by {creator.username} on CPC Hub.", path=_page_path(reverse("creator-profile", args=[creator.pk]), page), indexable=visible and not has_content_query(request, allowed=("page",)))
    if page.number > 1:
        seo["title"] = f"{creator.username}'s creations, page {page.number} | CPC Hub"
        seo["description"] = f"Page {page.number} of Car Park Capital blueprints and scenarios shared by {creator.username}."
    if seo["indexable"]:
        seo.update(type="profile", username=creator.username)
        profile = webpage(seo, "ProfilePage")
        profile["mainEntity"] = {"@type": "Person", "name": creator.username, "url": absolute_url(reverse("creator-profile", args=[creator.pk]))}
        seo["structured_data"] = structured_data(profile, *site_entities())
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
    response["X-Robots-Tag"] = PUBLIC_ROBOTS
    return response


@require_safe
def robots(request):
    body = render_to_string("hub/robots.txt", {
        "sitemap_url": absolute_url(reverse("sitemap-index")),
        "security_url": absolute_url(reverse("security-txt")),
    })
    return HttpResponse(body, content_type="text/plain; charset=utf-8")


@require_safe
def security_txt(request):
    body = render_to_string("hub/security.txt", {"canonical_url": absolute_url(reverse("security-txt"))})
    return HttpResponse(body, content_type="text/plain; charset=utf-8")


@require_safe
def security_txt_redirect(request):
    return HttpResponsePermanentRedirect(absolute_url(reverse("security-txt")))


class SearchIndexMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if response.status_code >= 400 or not getattr(request, "seo_indexable", False):
            response.setdefault("X-Robots-Tag", "noindex, follow")
        else:
            response.setdefault("X-Robots-Tag", PUBLIC_ROBOTS)
        return response
