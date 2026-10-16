from django.db.models import Count, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce

from .models import Bookmark, Item


ROLES = ("Admin", "Moderator", "Reviewer")


def role_for(user):
    if not user.is_authenticated or not user.is_active:
        return ""
    return assigned_role(user)


def assigned_role(user):
    if user.is_superuser:
        return "Admin"
    if not hasattr(user, "_hub_role"):
        names = set(user.groups.values_list("name", flat=True))
        user._hub_role = next((role for role in ROLES if role in names), "")
    return user._hub_role


def is_admin(user):
    return role_for(user) == "Admin"


def can_moderate(user):
    return bool(role_for(user))


def can_manage_content(user):
    return role_for(user) in {"Admin", "Moderator"}


def can_edit_item(user, item):
    return user.is_authenticated and user.is_active and (item.author_id == user.pk or can_manage_content(user))


def can_remove_screenshot(user, item):
    return user.is_authenticated and user.is_active and (item.author_id == user.pk or is_admin(user))


def item_query():
    # Keep the total independent of saved-collection filters and release joins.
    saves = Bookmark.objects.filter(item_id=OuterRef("pk")).order_by().values("item_id").annotate(total=Count("pk")).values("total")
    return Item.objects.annotate(_collection_count=Coalesce(Subquery(saves), Value(0))).select_related("author", "content_type").prefetch_related("releases", "screenshots")


def public_items():
    return item_query().filter(status=Item.Status.PUBLISHED, is_hidden=False, deleted_at=None, author__moderation_state__shadow_banned_at__isnull=True)


def visible_items(user):
    query = Q(status=Item.Status.PUBLISHED, author__moderation_state__shadow_banned_at__isnull=True)
    if user.is_authenticated:
        query |= Q(author=user)
    return item_query().filter(query, is_hidden=False, deleted_at=None)


def accessible_items(user, *, staff_access=True):
    if staff_access and can_moderate(user):
        return item_query()
    query = Q(status=Item.Status.PUBLISHED) | Q(is_hidden=True)
    if user.is_authenticated:
        query |= Q(author=user)
    audience = Q(author__moderation_state__shadow_banned_at__isnull=True, deleted_at=None)
    if user.is_authenticated:
        audience |= Q(author=user)
    return item_query().filter(query & audience)


def hidden_response(request, item):
    from django.shortcuts import render
    response = render(request, "hub/hidden.html", {
        "item": item, "can_edit": can_edit_item(request.user, item),
    }, status=403)
    response["Cache-Control"] = "private, no-store"
    return response
