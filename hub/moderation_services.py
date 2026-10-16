from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.contrib.sessions.models import Session
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from oauth2_provider.models import AccessToken, RefreshToken, Grant

from .access import ROLES, assigned_role, can_edit_item, can_manage_content, can_moderate, is_admin
from .models import APIKey, Item, ItemReview, ModerationLog, Revision, UserModeration


def log_action(actor, action, *, item=None, user=None, reason=""):
    return ModerationLog.objects.create(
        actor=actor, action=action, item=item, item_title=item.title if item else "",
        target_user=user, username=user.username if user else "", reason=reason,
    )


def staff_reason(reason):
    reason = reason.strip()
    if not reason or len(reason) > 2000:
        raise ValidationError("Give a staff-only reason of up to 2,000 characters.")
    return reason


@transaction.atomic
def moderate_item(actor, item, action, reason=""):
    if not can_moderate(actor):
        raise PermissionDenied
    item = Item.objects.select_for_update().get(pk=item.pk)
    if action == "hide":
        reason = reason.strip()
        if not reason or len(reason) > 2000:
            raise ValidationError("Give a reason of up to 2,000 characters. The author and visitors will see it.")
        item.is_hidden, item.hidden_reason = True, reason
        item.hidden_at, item.hidden_by = timezone.now(), actor
        item.featured_at = item.featured_by = None
    elif action == "restore":
        if not can_manage_content(actor):
            raise PermissionDenied
        item.is_hidden, item.hidden_reason = False, ""
        item.hidden_at = item.hidden_by = None
    elif action == "highlight":
        if item.is_hidden or item.deleted_at or item.status != Item.Status.PUBLISHED or UserModeration.objects.filter(user=item.author, shadow_banned_at__isnull=False).exists():
            raise ValidationError("Only published, visible creations can be highlighted.")
        item.featured_at, item.featured_by = timezone.now(), actor
    elif action == "unhighlight":
        item.featured_at = item.featured_by = None
    elif action == "restore-deleted":
        return restore_self_deleted_item(actor, item)
    else:
        raise ValidationError("Choose a moderation action.")
    item.save(update_fields=["is_hidden", "hidden_reason", "hidden_at", "hidden_by", "featured_at", "featured_by"])
    log_action(actor, action, item=item, reason=reason)
    return item


@transaction.atomic
def delete_item(actor, item, *, reason):
    if not is_admin(actor):
        raise PermissionDenied
    item = Item.objects.select_for_update().get(pk=item.pk)
    log_action(actor, "delete creation", item=item, reason=staff_reason(reason))
    item.delete()


def revoke_credentials(user):
    APIKey.objects.filter(user=user, revoked_at=None).update(revoked_at=timezone.now())
    RefreshToken.objects.filter(user=user).delete()
    AccessToken.objects.filter(user=user).delete()
    Grant.objects.filter(user=user).delete()
    # Changing the unusable password rotates the session authentication hash.
    user.set_unusable_password()
    user.save(update_fields=["password"])


def lock_user_management():
    # A single lock serializes administrator changes, including concurrent demotions.
    Group.objects.select_for_update().get(name="Admin")


def protect_last_admin(user, *, remains_admin):
    if user.is_active and is_admin(user) and not remains_admin:
        others = get_user_model().objects.filter(is_active=True).exclude(pk=user.pk)
        if not others.filter(is_superuser=True).exists() and not others.filter(groups__name="Admin").exists():
            raise ValidationError("Keep at least one active Admin account.")


@transaction.atomic
def update_user(actor, user, *, username, role, is_active):
    if not is_admin(actor):
        raise PermissionDenied
    if role not in ("", *ROLES):
        raise ValidationError("Choose a valid role.")
    lock_user_management()
    user = get_user_model().objects.select_for_update().get(pk=user.pk)
    protect_last_admin(user, remains_admin=is_active and role == "Admin")
    before = f"{user.username}; {assigned_role(user) or 'Member'}; {'active' if user.is_active else 'suspended'}"
    suspended = user.is_active and not is_active
    user.username, user.is_active = username, is_active
    user.is_staff = user.is_superuser = role == "Admin"
    user.full_clean(exclude=["password"])
    user.save(update_fields=["username", "is_active", "is_staff", "is_superuser"])
    user.groups.remove(*Group.objects.filter(name__in=ROLES))
    if role:
        user.groups.add(Group.objects.get(name=role))
    if suspended:
        revoke_credentials(user)
    log_action(actor, "update user", user=user, reason=f"{before} → {username}; {role or 'Member'}; {'active' if is_active else 'suspended'}")
    return user


@transaction.atomic
def delete_user(actor, user, *, reason):
    if not is_admin(actor):
        raise PermissionDenied
    lock_user_management()
    user = get_user_model().objects.select_for_update().get(pk=user.pk)
    protect_last_admin(user, remains_admin=False)
    reason = staff_reason(reason)
    ModerationLog.objects.filter(Q(actor=user) | Q(target_user=user)).delete()
    Revision.objects.filter(editor=user).delete()
    Item.objects.filter(reviews__reviewer=user, reviews__content_revision=F("reviewed_revision")).update(
        reviewed_revision=0, review_requested_at=timezone.now(),
    )
    ItemReview.objects.filter(reviewer=user).delete()
    for session in Session.objects.iterator():
        if str(session.get_decoded().get("_auth_user_id")) == str(user.pk):
            session.delete()
    log_action(actor, "purge user", user=user, reason=reason)
    user.delete()


@transaction.atomic
def self_delete_item(actor, item):
    item = Item.objects.select_for_update().get(pk=item.pk)
    if not actor.is_authenticated or not actor.is_active or item.author_id != actor.pk:
        raise PermissionDenied
    if item.deleted_at is None:
        item.deleted_at = timezone.now()
        item.featured_at = item.featured_by = None
        item.save(update_fields=["deleted_at", "featured_at", "featured_by"])
        log_action(actor, "self delete creation", item=item)
    return item


@transaction.atomic
def restore_self_deleted_item(actor, item):
    item = Item.objects.select_for_update().get(pk=item.pk)
    if not can_edit_item(actor, item):
        raise PermissionDenied
    if not item.can_restore:
        raise ValidationError("The 14-day restoration period has ended, or this creation is not deleted.")
    item.deleted_at = None
    item.save(update_fields=["deleted_at"])
    log_action(actor, "restore self-deleted creation", item=item)
    return item


def purge_expired_creations():
    deadline = timezone.now() - timedelta(days=14)
    candidates = list(Item.objects.filter(deleted_at__lte=deadline).values_list("pk", flat=True))
    for pk in candidates:
        with transaction.atomic():
            item = Item.objects.select_for_update().filter(pk=pk, deleted_at__lte=deadline).first()
            if item:
                log_action(None, "expire self-deleted creation", item=item)
                item.delete()


@transaction.atomic
def shadow_ban_user(actor, user, *, action, reason):
    if not can_manage_content(actor):
        raise PermissionDenied
    reason = staff_reason(reason)
    user = get_user_model().objects.select_for_update().get(pk=user.pk)
    if assigned_role(user) and not is_admin(actor):
        raise PermissionDenied("Only an Admin can shadow ban staff accounts.")
    if action not in {"shadow-ban", "remove-shadow-ban"}:
        raise ValidationError("Choose a valid action.")
    banned = action == "shadow-ban"
    UserModeration.objects.update_or_create(user=user, defaults={
        "shadow_banned_at": timezone.now() if banned else None,
        "shadow_banned_by": actor if banned else None,
    })
    log_action(actor, action.replace("-", " "), user=user, reason=reason)
