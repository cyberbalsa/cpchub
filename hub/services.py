import hashlib
import logging
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import AccountActivity, Item, Release, Revision, Screenshot
from .activity import record_activity
from .reviews import queue_for_review
from .upload_limits import upload_slot
from .validators import clean_screenshot, validate_package, validate_version


logger = logging.getLogger(__name__)


def create_with_release(item, *, release_data, screenshots, request=None):
    """Save a web upload only after all its files have passed validation."""
    validate_upload_type(item.content_type)
    validate_package(release_data["file"], item.content_type)
    if not settings.MIN_SCREENSHOTS <= len(screenshots) <= settings.MAX_SCREENSHOTS:
        raise ValidationError(f"Choose {settings.MIN_SCREENSHOTS}–{settings.MAX_SCREENSHOTS} screenshots.")
    intended_status = item.status
    stored_files = []
    try:
        with upload_slot(request.user if request else item.author):
            item.status = Item.Status.DRAFT
            item.save()
            for image in screenshots:
                stored_files.append(Screenshot.objects.create(item=item, image=image).image)
            stored_files.append(_save_release(item, **release_data).file)
            item.status = intended_status
            if item.status == Item.Status.PUBLISHED:
                validate_publication(item)
            item.save(update_fields=["status"])
            record_revision(item, item.author)
            record_activity(request, AccountActivity.Action.CREATE, item=item)
    except Exception:
        for field in stored_files:
            try:
                field.storage.delete(field.name)
            except Exception:
                logger.exception("Could not remove a file from an incomplete upload.")
        raise
    return item


def validate_upload_type(content_type):
    if not content_type.uploads_enabled:
        raise ValidationError("Uploads for this file type are disabled.")


def validate_screenshot_minimum(item):
    if Screenshot.objects.filter(item=item).count() < settings.MIN_SCREENSHOTS:
        raise ValidationError(f"Add at least {settings.MIN_SCREENSHOTS} screenshot{'s' if settings.MIN_SCREENSHOTS != 1 else ''} before publishing.")


def validate_publication(item):
    validate_upload_type(item.content_type)
    if not Release.objects.filter(item=item).exists():
        raise ValidationError("Upload a release before publishing.")
    validate_screenshot_minimum(item)


def record_revision(item, editor):
    snapshot = {
        field: getattr(item, field) for field in ["title", "summary", "description", "tags", "status", "content_type_id"]
    }
    previous = item.revisions.first()
    if previous is None or previous.snapshot != snapshot:
        queue_for_review(item)
    return Revision.objects.create(item=item, editor=editor, snapshot=snapshot)


def add_release(item, *, file, version, game_version="", changelog="", request=None):
    with upload_slot(request.user if request else item.author):
        return _save_release(item, file=file, version=version, game_version=game_version, changelog=changelog, request=request)


@transaction.atomic
def _save_release(item, *, file, version, game_version="", changelog="", request=None):
    item = Item.objects.select_for_update(of=("self",)).select_related("content_type").get(pk=item.pk)
    validate_upload_type(item.content_type)
    if item.status == Item.Status.PUBLISHED:
        validate_screenshot_minimum(item)
    validate_version(version)
    if item.releases.filter(version=version).exists():
        raise ValidationError("This version already exists. Use a new version; releases cannot be replaced.")
    validate_package(file, item.content_type)
    digest = hashlib.sha256()
    for chunk in file.chunks():
        digest.update(chunk)
    file.seek(0)
    release = Release.objects.create(item=item, file=file, version=version, game_version=game_version,
                                     changelog=changelog, original_filename=Path(file.name).name,
                                     sha256=digest.hexdigest(), size=file.size)
    Item.objects.filter(pk=item.pk).update(updated_at=timezone.now())
    queue_for_review(item)
    record_activity(request, AccountActivity.Action.RELEASE, item=item)
    return release


@transaction.atomic
def add_screenshot(item, *, image, caption="", request=None):
    item = Item.objects.select_for_update().get(pk=item.pk)
    if item.screenshots.count() >= settings.MAX_SCREENSHOTS:
        raise ValidationError(f"An item can have up to {settings.MAX_SCREENSHOTS} screenshots. Remove one before adding another.")
    screenshot = Screenshot.objects.create(item=item, image=clean_screenshot(image), caption=caption)
    queue_for_review(item)
    record_activity(request, AccountActivity.Action.SCREENSHOT, item=item)
    return screenshot


@transaction.atomic
def remove_screenshot(screenshot):
    item = Item.objects.select_for_update().get(pk=screenshot.item_id)
    if item.status == Item.Status.PUBLISHED and item.screenshots.count() <= settings.MIN_SCREENSHOTS:
        raise ValidationError(f"Published creations need at least {settings.MIN_SCREENSHOTS} screenshot{'s' if settings.MIN_SCREENSHOTS != 1 else ''}. Add a replacement first, or save the creation as a draft.")
    screenshot.delete()
    queue_for_review(item)
