from botocore.exceptions import BotoCoreError, ClientError
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.paginator import Paginator
from django.db import connection, transaction
from django.db.models import Count, Q, Sum
from django.http import Http404, JsonResponse
from django.shortcuts import redirect, render
from rest_framework.generics import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_POST
from django.views.decorators.cache import never_cache
from django.views.decorators.vary import vary_on_headers
from oauth2_provider.models import Application, AccessToken, RefreshToken

from .access import accessible_items, can_edit_item, can_moderate, can_remove_screenshot, hidden_response, item_query, public_items, visible_items
from .forms import ItemForm, KeyForm, ReleaseForm, ScreenshotBatchForm, ScreenshotForm
from .models import APIKey, Bookmark, ContentType, Item
from .services import add_release, add_screenshot, create_with_release, record_revision, remove_screenshot, validate_publication


@never_cache
@vary_on_headers("HX-Request")
def catalog(request):
    items = visible_items(request.user)
    q = request.GET.get("q", "").strip()[:200]
    category = request.GET.get("type", "")
    view = request.GET.get("view", "all")
    sort = request.GET.get("sort", "updated")
    if q:
        items = items.filter(Q(title__icontains=q) | Q(summary__icontains=q) | Q(tags__icontains=q))
    if category:
        items = items.filter(content_type__slug=category)
    if view in {"saved", "mine"}:
        if not request.user.is_authenticated:
            return redirect(f"/accounts/login/?next={request.path}?view={view}")
        if view == "mine":
            items = item_query().filter(author=request.user)
            if q:
                items = items.filter(Q(title__icontains=q) | Q(summary__icontains=q) | Q(tags__icontains=q))
            if category:
                items = items.filter(content_type__slug=category)
        else:
            items = items.filter(bookmarks__user=request.user)
    items = items.order_by({"popular": "-downloads", "newest": "-created_at"}.get(sort, "-updated_at"), "id")
    page = Paginator(items, 12).get_page(request.GET.get("page"))
    public = public_items().filter(is_demo=False)
    stats = public.aggregate(items=Count("pk"), downloads=Sum("downloads"), authors=Count("author", distinct=True))
    context = {"page_obj": page, "q": q, "category": category, "catalog_view": view, "sort": sort,
               "stats": stats, "has_demo": items.filter(is_demo=True).exists(),
               "featured_items": public_items().filter(featured_at__isnull=False).order_by("-featured_at", "pk")[:6] if view == "all" and not q and not category and not request.GET.get("page") else [],
               "types_with_counts": ContentType.objects.filter(uploads_enabled=True).annotate(total=Count("items", filter=Q(items__status="published", items__is_hidden=False, items__deleted_at=None, items__author__moderation_state__shadow_banned_at__isnull=True))).order_by("position", "name")}
    return render(request, "hub/results.html" if request.htmx and not request.htmx.history_restore_request else "hub/catalog.html", context)


@never_cache
def detail(request, pk):
    from .download_warning import DownloadWarningForm, warning_acknowledged

    item = get_object_or_404(accessible_items(request.user), pk=pk)
    if item.is_hidden and not can_moderate(request.user):
        return hidden_response(request, item)
    return render(request, "hub/detail.html", {
        "item": item, "saved": request.user.is_authenticated and Bookmark.objects.filter(user=request.user, item=item).exists(),
        "show_download_warning": not warning_acknowledged(request), "download_warning_form": DownloadWarningForm(),
        "can_edit": can_edit_item(request.user, item),
    })


@login_required
def create_item(request):
    form = ItemForm(request.POST or None)
    release_form = ReleaseForm(request.POST or None, request.FILES or None)
    screenshot_form = ScreenshotBatchForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and all([form.is_valid(), release_form.is_valid(), screenshot_form.is_valid()]):
        try:
            item = form.save(commit=False)
            item.author = request.user
            create_with_release(item, release_data=release_form.cleaned_data, screenshots=screenshot_form.cleaned_data["screenshots"])
            messages.success(request, "Creation saved with your file and screenshots.")
            return redirect("item-edit", pk=item.pk)
        except ValidationError as exc:
            release_form.add_error(None, exc)
        except (BotoCoreError, ClientError):
            release_form.add_error(None, "File storage is temporarily unavailable. Try again shortly.")
    return render(request, "hub/editor.html", {"form": form, "release_form": release_form, "screenshot_form": screenshot_form, "creating": True})


@login_required
def edit_item(request, pk):
    item = get_object_or_404(accessible_items(request.user), pk=pk)
    if not can_edit_item(request.user, item):
        raise Http404
    form = ItemForm(instance=item)
    release_form = ReleaseForm()
    screenshot_form = ScreenshotForm()
    if request.method == "POST":
        action = request.POST.get("action", "metadata")
        if action == "metadata":
            with transaction.atomic():
                item = Item.objects.select_for_update().get(pk=item.pk)
                form = ItemForm(request.POST, instance=item)
                if form.is_valid():
                    try:
                        if form.cleaned_data["status"] == Item.Status.PUBLISHED:
                            validate_publication(item)
                        item = form.save()
                        record_revision(item, request.user)
                    except ValidationError as exc:
                        form.add_error("status", exc)
                    else:
                        messages.success(request, "Changes saved to the edit history.")
                        return redirect("item-edit", pk=pk)
        elif action == "release":
            release_form = ReleaseForm(request.POST, request.FILES)
            if release_form.is_valid():
                try:
                    add_release(item, **release_form.cleaned_data)
                    messages.success(request, "New release published. Previous versions are still available.")
                    return redirect("item-edit", pk=pk)
                except ValidationError as exc:
                    release_form.add_error(None, exc)
                except (BotoCoreError, ClientError):
                    release_form.add_error(None, "File storage is temporarily unavailable. Try again shortly.")
        elif action == "screenshot":
            screenshot_form = ScreenshotForm(request.POST, request.FILES)
            if screenshot_form.is_valid():
                try:
                    add_screenshot(item, **screenshot_form.cleaned_data)
                    messages.success(request, "Screenshot added.")
                    return redirect("item-edit", pk=pk)
                except ValidationError as exc:
                    screenshot_form.add_error(None, exc)
                except (BotoCoreError, ClientError):
                    screenshot_form.add_error(None, "File storage is temporarily unavailable. Try again shortly.")
        elif action == "remove-screenshot":
            if not can_remove_screenshot(request.user, item):
                raise PermissionDenied
            screenshot = get_object_or_404(item.screenshots, pk=request.POST.get("screenshot_id"))
            try:
                remove_screenshot(screenshot)
            except ValidationError as exc:
                messages.error(request, " ".join(exc.messages))
            return redirect("item-edit", pk=pk)
    return render(request, "hub/editor.html", {"item": item, "form": form, "release_form": release_form, "screenshot_form": screenshot_form,
                                             "can_remove_screenshots": can_remove_screenshot(request.user, item)})


@login_required
@require_POST
def bookmark(request, pk):
    item = get_object_or_404(visible_items(request.user), pk=pk)
    entry, created = Bookmark.objects.get_or_create(item=item, user=request.user)
    if not created:
        entry.delete()
    if request.htmx:
        return render(request, "hub/bookmark.html", {"item": item, "saved": created})
    return redirect(item)


@login_required
def keys(request):
    form = KeyForm(request.POST or None)
    raw = None
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            from django.contrib.auth import get_user_model
            get_user_model().objects.select_for_update().get(pk=request.user.pk)
            if request.user.api_keys.active().count() >= 20:
                form.add_error(None, "You have 20 active keys. Revoke one before creating another.")
            else:
                _, raw = APIKey.issue(user=request.user, **form.cleaned_data)
                form = KeyForm()
    apps = Application.objects.filter(Q(accesstoken__user=request.user) | Q(apikey__user=request.user, apikey__revoked_at=None)).distinct()
    return render(request, "hub/keys.html", {"form": form, "keys": request.user.api_keys.all(), "new_key": raw, "connected_apps": apps})


@login_required
@require_POST
def revoke_key(request, pk):
    key = get_object_or_404(APIKey, pk=pk, user=request.user)
    key.revoked_at = timezone.now()
    key.save(update_fields=["revoked_at"])
    messages.success(request, "API key revoked.")
    return redirect("keys")


@login_required
@require_POST
@transaction.atomic
def revoke_manager(request, pk):
    app = get_object_or_404(Application, pk=pk)
    RefreshToken.objects.filter(user=request.user, application=app).delete()
    AccessToken.objects.filter(user=request.user, application=app).delete()
    APIKey.objects.filter(user=request.user, application=app, revoked_at=None).update(revoked_at=timezone.now())
    messages.success(request, "Manager disconnected and its tokens and keys revoked.")
    return redirect("keys")


def developers(request):
    return render(request, "hub/developers.html")


def health(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return JsonResponse({"status": "ok"})
    except Exception:
        return JsonResponse({"status": "unavailable"}, status=503)
