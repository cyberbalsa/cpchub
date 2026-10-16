import hashlib
from pathlib import Path

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Item, Release, Revision, Screenshot
from .validators import clean_screenshot, validate_package, validate_version


def record_revision(item, editor):
    return Revision.objects.create(item=item, editor=editor, snapshot={
        field: getattr(item, field) for field in ["title", "summary", "description", "tags", "status", "content_type_id"]
    })


@transaction.atomic
def add_release(item, *, file, version, game_version="", changelog=""):
    Item.objects.select_for_update().get(pk=item.pk)
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
    return release


@transaction.atomic
def add_screenshot(item, *, image, caption=""):
    Item.objects.select_for_update().get(pk=item.pk)
    if item.screenshots.count() >= 8:
        raise ValidationError("An item can have up to 8 screenshots. Remove one before adding another.")
    return Screenshot.objects.create(item=item, image=clean_screenshot(image), caption=caption)
