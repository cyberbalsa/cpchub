import json
from functools import wraps

from django import forms
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Count, F, OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods

from .access import ROLES, assigned_role, can_manage_content, can_moderate, is_admin, item_query
from .models import AccountActivity, FileDeletion, Item, ItemReview, ModerationLog, Release, Screenshot, UserModeration
from .moderation_services import delete_item, delete_user, log_action, moderate_item, revoke_credentials, shadow_ban_user, update_user
from .services import record_revision
from .validators import validate_version
from .reviews import mark_seen, queue_for_review, review_queue_items


def staff_required(*, admin_only=False):
    def decorate(view):
        @login_required
        @never_cache
        @wraps(view)
        def checked(request, *args, **kwargs):
            if not (is_admin(request.user) if admin_only else can_moderate(request.user)):
                raise PermissionDenied
            return view(request, *args, **kwargs)
        return checked
    return decorate


class ModerationForm(forms.Form):
    action = forms.ChoiceField(choices=[(value, value) for value in ["hide", "restore", "highlight", "unhighlight", "restore-deleted"]])
    reason = forms.CharField(required=False, max_length=2000, label="Reason shown to the author and visitors", widget=forms.Textarea(attrs={"rows": 4}))

    def clean(self):
        data = super().clean()
        if data.get("action") == "hide" and not data.get("reason"):
            self.add_error("reason", "Give a reason before hiding this creation.")
        return data


class ReviewForm(forms.Form):
    content_revision = forms.IntegerField(min_value=1, widget=forms.HiddenInput)
    note = forms.CharField(required=False, max_length=2000, label="Staff note (optional)", widget=forms.Textarea(attrs={"rows": 3}), help_text="Only staff can read this note.")


class ConfirmDeleteForm(forms.Form):
    confirmation = forms.CharField(label="Type the name to confirm")
    reason = forms.CharField(max_length=2000, label="Staff-only reason", widget=forms.Textarea(attrs={"rows": 3}), help_text="Required. Only staff can read this in the mod log.")

    def __init__(self, *args, expected, **kwargs):
        self.expected = expected
        super().__init__(*args, **kwargs)

    def clean_confirmation(self):
        value = self.cleaned_data["confirmation"]
        if value != self.expected:
            raise ValidationError("The name does not match.")
        return value


class ShadowBanForm(forms.Form):
    action = forms.ChoiceField(choices=[("shadow-ban", "Shadow ban"), ("remove-shadow-ban", "Remove shadow ban")])
    reason = forms.CharField(max_length=2000, label="Staff-only reason", widget=forms.Textarea(attrs={"rows": 3}), help_text="Required. Only staff can read this in the mod log.")


class ActivityFilterForm(forms.Form):
    user = forms.IntegerField(required=False, min_value=1, widget=forms.HiddenInput)
    username = forms.CharField(required=False, max_length=150, label="Username")
    ip = forms.GenericIPAddressField(required=False, unpack_ipv4=True, label="IP address")
    action = forms.ChoiceField(required=False, choices=[("", "All activity"), *AccountActivity.Action.choices])


@staff_required(admin_only=True)
def account_activity(request):
    form = ActivityFilterForm(request.GET)
    events = AccountActivity.objects.select_related("user", "item")
    if form.is_valid():
        if form.cleaned_data["user"]:
            events = events.filter(user_id=form.cleaned_data["user"])
        if form.cleaned_data["username"]:
            events = events.filter(user__username__icontains=form.cleaned_data["username"])
        if form.cleaned_data["ip"]:
            events = events.filter(ip_address=form.cleaned_data["ip"])
        if form.cleaned_data["action"]:
            events = events.filter(action=form.cleaned_data["action"])
    else:
        events = events.none()
    return render(request, "hub/moderation/account_activity.html", {
        "filter_form": form, "page_obj": Paginator(events, 50).get_page(request.GET.get("page")),
    })


class UserManagementForm(forms.ModelForm):
    role = forms.ChoiceField(choices=[("", "Member"), *((role, role) for role in ROLES)], required=False)

    class Meta:
        model = get_user_model()
        fields = ["username", "role", "is_active"]
        labels = {"is_active": "Account active"}
        help_texts = {"is_active": "Suspending an account signs it out and revokes its API keys and manager access."}


class ReleaseMetadataForm(forms.ModelForm):
    version = forms.CharField(max_length=40, validators=[validate_version])

    def clean_version(self):
        version = self.cleaned_data["version"]
        if Release.objects.filter(item_id=self.instance.item_id, version=version).exclude(pk=self.instance.pk).exists():
            raise ValidationError("This version already exists. Choose a different version.")
        return version

    class Meta:
        model = Release
        fields = ["version", "game_version", "changelog"]


class ScreenshotCaptionForm(forms.ModelForm):
    class Meta:
        model = Screenshot
        fields = ["caption"]


@staff_required()
def review_queue(request):
    items = review_queue_items()
    pending_count = items.filter(reviewed_revision__lt=F("content_revision")).count()
    q = request.GET.get("q", "").strip()[:200]
    state = "seen" if request.GET.get("state") == "seen" else "pending"
    if q:
        items = items.filter(Q(title__icontains=q) | Q(author__username__icontains=q))
    if state == "seen":
        items = items.filter(reviewed_revision=F("content_revision"))
    else:
        items = items.filter(reviewed_revision__lt=F("content_revision"))
    last_review = ItemReview.objects.filter(item_id=OuterRef("pk"))
    items = items.select_related("author", "content_type").annotate(
        last_seen_at=Subquery(last_review.values("created_at")[:1]),
        last_seen_by=Subquery(last_review.values("reviewer__username")[:1]),
        last_seen_by_id=Subquery(last_review.values("reviewer_id")[:1]),
    ).order_by("review_requested_at", "pk")
    return render(request, "hub/moderation/review_queue.html", {
        "page_obj": Paginator(items, 25).get_page(request.GET.get("page")),
        "pending_count": pending_count, "q": q, "state": state,
    })


@staff_required()
def dashboard(request):
    items = item_query()
    q = request.GET.get("q", "").strip()[:200]
    state = request.GET.get("state", "all")
    if q:
        items = items.filter(Q(title__icontains=q) | Q(author__username__icontains=q))
    if state == "hidden":
        items = items.filter(is_hidden=True)
    elif state == "highlighted":
        items = items.filter(is_hidden=False, deleted_at=None, author__moderation_state__shadow_banned_at__isnull=True, status=Item.Status.PUBLISHED, featured_at__isnull=False)
    elif state == "draft":
        items = items.filter(status=Item.Status.DRAFT)
    elif state == "deleted":
        items = items.filter(deleted_at__isnull=False)
    return render(request, "hub/moderation/dashboard.html", {
        "page_obj": Paginator(items.order_by("-updated_at", "pk"), 25).get_page(request.GET.get("page")),
        "q": q, "state": state, "hidden_count": Item.objects.filter(is_hidden=True).count(),
        "logs": ModerationLog.objects.select_related("actor")[:30],
        "pending_deletions": FileDeletion.objects.count() if is_admin(request.user) else 0,
    })


@staff_required()
@require_http_methods(["GET", "POST"])
def item_tools(request, pk):
    item = get_object_or_404(item_query(), pk=pk)
    reviewing = request.method == "POST" and request.POST.get("action") == "mark-seen"
    review_form = ReviewForm(request.POST if reviewing else None, initial={"content_revision": item.content_revision})
    form = ModerationForm(request.POST if request.method == "POST" and not reviewing else None, initial={"reason": item.hidden_reason})
    response_status = 200
    if reviewing and review_form.is_valid():
        try:
            changed = mark_seen(request.user, item, **review_form.cleaned_data)
        except ValidationError as exc:
            review_form.add_error(None, exc)
            response_status = 409
        else:
            messages.success(request, "Marked as seen." if changed else "Another staff member has already marked this version as seen.")
            return redirect("moderation-review-queue")
    elif request.method == "POST" and not reviewing and form.is_valid():
        try:
            moderate_item(request.user, item, **form.cleaned_data)
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            messages.success(request, "Moderation changes saved.")
            return redirect("moderation-item", pk=pk)
    return render(request, "hub/moderation/item.html", {
        "item": item, "form": form, "review_form": review_form,
        "page_obj": Paginator(item.reviews.select_related("reviewer"), 20).get_page(request.GET.get("page")),
        "can_manage": can_manage_content(request.user),
        "can_highlight": not (item.is_hidden or item.deleted_at or item.status != Item.Status.PUBLISHED or UserModeration.objects.filter(user=item.author, shadow_banned_at__isnull=False).exists()),
        "logs": item.moderationlog_set.select_related("actor")[:30],
    }, status=response_status)


@staff_required(admin_only=True)
@require_http_methods(["GET", "POST"])
def remove_item(request, pk):
    item = get_object_or_404(Item, pk=pk)
    form = ConfirmDeleteForm(request.POST if request.method == "POST" else None, expected=item.title)
    if request.method == "POST" and form.is_valid():
        delete_item(request.user, item, reason=form.cleaned_data["reason"])
        messages.success(request, "Creation deleted.")
        return redirect("moderation")
    return render(request, "hub/moderation/delete.html", {
        "form": form, "name": item.title, "cancel_url": item.get_absolute_url(),
        "consequence": "This deletes the creation, every release, its screenshots, and edit history. It cannot be undone.",
    })


@staff_required()
@require_http_methods(["GET", "POST"])
def edit_file(request, pk, file_id, kind):
    if not can_manage_content(request.user):
        raise PermissionDenied
    item = get_object_or_404(Item, pk=pk)
    model, form_class = (Release, ReleaseMetadataForm) if kind == "release" else (Screenshot, ScreenshotCaptionForm)
    instance = get_object_or_404(model, pk=file_id, item=item)
    form = form_class(instance=instance)
    if request.method == "POST":
        with transaction.atomic():
            item = Item.objects.select_for_update().get(pk=pk)
            instance = model.objects.select_for_update().get(pk=file_id, item=item)
            before = {field: getattr(instance, field) for field in form_class._meta.fields}
            form = form_class(request.POST, instance=instance)
            if form.is_valid():
                form.save()
                if form.has_changed():
                    queue_for_review(item)
                log_action(request.user, f"edit {kind}", item=item, reason=json.dumps({"before": before, "after": form.cleaned_data}))
                messages.success(request, "File details saved.")
                return redirect("moderation-item", pk=pk)
    return render(request, "hub/moderation/file.html", {"item": item, "form": form, "kind": kind})


@staff_required(admin_only=True)
@require_http_methods(["GET", "POST"])
def remove_file(request, pk, file_id, kind):
    item = get_object_or_404(Item, pk=pk)
    model = Release if kind == "release" else Screenshot
    instance = get_object_or_404(model, pk=file_id, item=item)
    name = instance.original_filename if kind == "release" else str(instance.pk)
    form = ConfirmDeleteForm(request.POST if request.method == "POST" else None, expected=name)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            item = Item.objects.select_for_update().get(pk=pk)
            instance = get_object_or_404(model, pk=file_id, item=item)
            log_action(request.user, f"delete {kind}", item=item, reason=f"{name}: {form.cleaned_data['reason']}")
            instance.delete()
            queue_for_review(item)
            from django.conf import settings
            if not item.releases.exists() or item.screenshots.count() < settings.MIN_SCREENSHOTS:
                item.status = Item.Status.DRAFT
                item.featured_at = item.featured_by = None
                item.save(update_fields=["status", "featured_at", "featured_by"])
                record_revision(item, request.user)
        messages.success(request, "File deleted. Creations without a release or screenshot are saved as drafts.")
        return redirect("moderation-item", pk=pk)
    return render(request, "hub/moderation/delete.html", {
        "form": form, "name": name, "cancel_url": item.get_absolute_url(),
        "consequence": "This permanently deletes the file. If the creation has no releases or screenshots left, it becomes a draft.",
    })


@staff_required()
def users(request):
    if not can_manage_content(request.user):
        raise PermissionDenied
    query = get_user_model().objects.select_related("moderation_state").prefetch_related("groups", "socialaccount_set").annotate(upload_count=Count("items"))
    q = request.GET.get("q", "").strip()[:150]
    if q:
        query = query.filter(username__icontains=q)
    page = Paginator(query.order_by("username", "pk"), 30).get_page(request.GET.get("page"))
    for user in page:
        user.site_role = assigned_role(user) or "Member"
    return render(request, "hub/moderation/users.html", {"page_obj": page, "q": q})


@staff_required()
@require_http_methods(["GET", "POST"])
def user_edit(request, pk):
    if not can_manage_content(request.user):
        raise PermissionDenied
    user = get_object_or_404(get_user_model(), pk=pk)
    action = request.POST.get("action", "save") if request.method == "POST" else None
    form = UserManagementForm(request.POST if action == "save" else None, instance=user, initial={"role": assigned_role(user)})
    shadow_form = ShadowBanForm(request.POST if action in {"shadow-ban", "remove-shadow-ban"} else None)
    if request.method == "POST":
        action = request.POST.get("action", "save")
        if action in {"shadow-ban", "remove-shadow-ban"}:
            if shadow_form.is_valid():
                shadow_ban_user(request.user, user, **shadow_form.cleaned_data)
                messages.success(request, "Shadow ban updated. The reason is recorded in the staff mod log.")
                return redirect("moderation-user", pk=pk)
        elif not is_admin(request.user):
            raise PermissionDenied
        if action == "revoke":
            with transaction.atomic():
                user = get_user_model().objects.select_for_update().get(pk=pk)
                revoke_credentials(user)
                log_action(request.user, "revoke access", user=user)
            messages.success(request, "Sessions, API keys, and manager access revoked. The user can sign in again through a linked account.")
            return redirect("moderation-user", pk=pk)
        if action == "save" and form.is_valid():
            try:
                update_user(request.user, user, **form.cleaned_data)
            except ValidationError as exc:
                form.add_error(None, "; ".join(exc.messages))
            else:
                messages.success(request, "User updated.")
                return redirect("moderation-user", pk=pk)
    return render(request, "hub/moderation/user.html", {
        "managed_user": user, "form": form, "shadow_form": shadow_form,
        "shadow_banned": UserModeration.objects.filter(user=user, shadow_banned_at__isnull=False).exists(),
        "can_shadow_ban": is_admin(request.user) or not assigned_role(user),
        "linked_accounts": user.socialaccount_set.all(),
        "logs": user.moderation_history.select_related("actor")[:30],
    })


@staff_required(admin_only=True)
@require_http_methods(["GET", "POST"])
def user_delete(request, pk):
    user = get_object_or_404(get_user_model(), pk=pk)
    form = ConfirmDeleteForm(request.POST if request.method == "POST" else None, expected=user.username)
    if request.method == "POST" and form.is_valid():
        try:
            delete_user(request.user, user, reason=form.cleaned_data["reason"])
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            messages.success(request, "User and their creations deleted.")
            return redirect("moderation-users")
    return render(request, "hub/moderation/delete.html", {
        "form": form, "name": user.username, "cancel_url": "/moderation/users/",
        "consequence": f"This purges the account, its {user.items.count()} creations, all uploaded files, linked logins, and account activity. A staff-only purge record will remain. It cannot be undone.",
    })
