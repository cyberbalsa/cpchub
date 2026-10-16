from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .access import can_moderate
from .models import Item, ItemReview
from .moderation_services import log_action


def queue_for_review(item):
    """Call inside the content edit's transaction, with the item row locked."""
    Item.objects.filter(pk=item.pk).update(
        content_revision=F("content_revision") + 1,
        review_requested_at=timezone.now(),
    )
    # Keep later saves of this instance from overwriting the new revision.
    item.refresh_from_db(fields=["content_revision", "review_requested_at"])


def review_queue_items():
    # Hidden and shadow-banned uploads still need staff review.
    return Item.objects.filter(status=Item.Status.PUBLISHED, deleted_at=None, is_demo=False)


@transaction.atomic
def mark_seen(actor, item, *, content_revision, note=""):
    if not can_moderate(actor):
        raise PermissionDenied
    item = Item.objects.select_for_update().get(pk=item.pk)
    if item.content_revision != content_revision:
        raise ValidationError("This creation changed while this page was open. Reload the review and check the changes before marking it as seen.")
    note = note.strip()
    if len(note) > 2000:
        raise ValidationError("Keep the staff note under 2,000 characters.")
    if not item.needs_review:
        return False
    ItemReview.objects.create(item=item, reviewer=actor, content_revision=content_revision, note=note)
    item.reviewed_revision = content_revision
    item.save(update_fields=["reviewed_revision"])
    log_action(actor, "marked seen", item=item, reason=note)
    return True
