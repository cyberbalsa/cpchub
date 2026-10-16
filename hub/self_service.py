from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods, require_POST

from .models import Item
from .moderation_services import restore_self_deleted_item, self_delete_item
from .services import record_revision


@login_required
@never_cache
@require_http_methods(["GET", "POST"])
def delete_own_item(request, pk):
    item = get_object_or_404(Item, pk=pk, author=request.user)
    if request.method == "POST":
        self_delete_item(request.user, item)
        messages.success(request, "Creation deleted. You can restore it from My uploads within 14 days.")
        return redirect("/?view=mine")
    return render(request, "hub/self_delete.html", {"item": item})


@login_required
@never_cache
@require_POST
def restore_own_item(request, pk):
    item = get_object_or_404(Item, pk=pk, author=request.user)
    try:
        restore_self_deleted_item(request.user, item)
    except ValidationError as exc:
        messages.error(request, " ".join(exc.messages))
    else:
        messages.success(request, "Creation restored. Any previous moderation restriction still applies.")
    return redirect("/?view=mine")


@login_required
@require_POST
@transaction.atomic
def unpublish_own_item(request, pk):
    item = get_object_or_404(Item.objects.select_for_update(), pk=pk, author=request.user)
    item.status = Item.Status.DRAFT
    item.featured_at = item.featured_by = None
    item.save(update_fields=["status", "featured_at", "featured_by"])
    record_revision(item, request.user)
    messages.success(request, "Creation unpublished. Only you and staff can view it.")
    return redirect("item-edit", pk=pk)
