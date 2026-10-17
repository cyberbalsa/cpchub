"""Daily discovery snapshots, with live visibility checks on every response."""
from xml.etree.ElementTree import Element, SubElement, tostring

from django.conf import settings
from django.core.paginator import EmptyPage, Paginator
from django.db import transaction
from django.db.models import Max, Q, Subquery
from django.db.models.functions import Greatest
from django.http import Http404, HttpResponse
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe

from .models import SitemapEntry, SitemapState
from .seo import absolute_url, published_items

NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"


@transaction.atomic
def build_snapshot(*, only_if_missing=False):
    state, created = SitemapState.objects.get_or_create(pk=1)
    state = SitemapState.objects.select_for_update().get(pk=state.pk)
    if only_if_missing and not created:
        return 0
    SitemapEntry.objects.all().delete()
    batch = [SitemapEntry(path=reverse(name)) for name in ["catalog", "developers", "donate"]]
    public = published_items()
    modified = Greatest("updated_at", "review_requested_at")
    for item in public.annotate(modified=modified).values("pk", "modified").order_by("pk").iterator(chunk_size=1000):
        batch.append(SitemapEntry(path=reverse("item-detail", args=[item["pk"]]), last_modified=item["modified"], item_id=item["pk"]))
        if len(batch) >= 1000:
            SitemapEntry.objects.bulk_create(batch)
            batch = []
    for author in public.values("author_id").annotate(modified=Max(modified)).order_by("author_id").iterator(chunk_size=1000):
        batch.append(SitemapEntry(path=reverse("creator-profile", args=[author["author_id"]]), last_modified=author["modified"], author_id=author["author_id"]))
        if len(batch) >= 1000:
            SitemapEntry.objects.bulk_create(batch)
            batch = []
    if batch:
        SitemapEntry.objects.bulk_create(batch)
    state.generated_at = timezone.now()
    state.save(update_fields=["generated_at"])
    return SitemapEntry.objects.count()


def visible_entries():
    if not SitemapState.objects.filter(pk=1).exists():
        build_snapshot(only_if_missing=True)
    public = published_items()
    # Hiding, unpublishing, shadow bans and deletions take effect immediately,
    # including on an older snapshot. Staff cookies never broaden this query.
    return SitemapEntry.objects.filter(
        Q(item_id=None, author_id=None)
        | Q(item_id__in=Subquery(public.values("pk")))
        | Q(author_id__in=Subquery(public.values("author_id")))
    )


def _paginator():
    return Paginator(visible_entries(), settings.SITEMAP_PAGE_SIZE)


def _response(root):
    return HttpResponse(tostring(root, encoding="utf-8", xml_declaration=True), content_type="application/xml; charset=utf-8")


@never_cache
@require_safe
def sitemap_index(request):
    root = Element("sitemapindex", xmlns=NAMESPACE)
    for number in _paginator().page_range:
        entry = SubElement(root, "sitemap")
        SubElement(entry, "loc").text = absolute_url(reverse("sitemap-page", args=[number]))
    return _response(root)


@never_cache
@require_safe
def sitemap_page(request, page):
    try:
        entries = _paginator().page(page)
    except EmptyPage as exc:
        raise Http404 from exc
    root = Element("urlset", xmlns=NAMESPACE)
    for entry in entries:
        node = SubElement(root, "url")
        SubElement(node, "loc").text = absolute_url(entry.path)
        if entry.last_modified:
            SubElement(node, "lastmod").text = entry.last_modified.isoformat()
    return _response(root)
