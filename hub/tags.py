import unicodedata

from django.core.exceptions import ValidationError
from django.db.models import Count, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce

from .models import Item, Tag, TagSettings


def normalize_tag(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def tag_names(value):
    return list(dict.fromkeys(name for part in unicodedata.normalize("NFKC", value).split(",") if (name := normalize_tag(part))))


def clean_tags(value):
    value = ", ".join(tag_names(value))
    if len(value) > 200:
        raise ValidationError("Use at most 200 characters for all tags together.")
    return value


def public_creation_filter(prefix=""):
    return Q(**{prefix + "status": Item.Status.PUBLISHED, prefix + "is_hidden": False,
                prefix + "deleted_at__isnull": True, prefix + "is_demo": False,
                prefix + "author__moderation_state__shadow_banned_at__isnull": True})


def minimum_tag_items():
    return TagSettings.objects.filter(pk=1).values_list("minimum_items", flat=True).first() or 11


def public_tags():
    # A correlated count stays global even when this query is used by Prefetch.
    counts = (Item.tag_index.through.objects.filter(tag_id=OuterRef("pk"))
              .filter(public_creation_filter("item__")).order_by().values("tag_id")
              .annotate(total=Count("item_id", distinct=True)).values("total"))
    minimum = Coalesce(Subquery(TagSettings.objects.filter(pk=1).values("minimum_items")), Value(11))
    return Tag.objects.annotate(item_count=Coalesce(Subquery(counts), Value(0), output_field=IntegerField())).filter(item_count__gte=minimum)


def suggested_tags(user):
    # Editors can reuse uncommon tags, without seeing other people's private tags.
    items = Item.objects.filter(public_creation_filter() | Q(author=user))
    return Tag.objects.filter(items__in=items).distinct().order_by("name")


def filter_tags(items, *, query="", tag="", private=False):
    allowed = Tag.objects.all() if private else public_tags()
    if query:
        matching = allowed.filter(name__icontains=normalize_tag(query))
        items = items.filter(Q(title__icontains=query) | Q(summary__icontains=query) |
                             Q(description__icontains=query) | Q(tag_index__in=matching)).distinct()
    if tag:
        items = items.filter(tag_index__in=allowed.filter(name=normalize_tag(tag)))
    return items
