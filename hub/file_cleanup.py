import logging

from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import FileDeletion, Release, Screenshot, UploadJob


logger = logging.getLogger(__name__)


@receiver(post_delete, sender=UploadJob)
def discard_validation_files(sender, instance, **kwargs):
    from .upload_jobs import discard_job_files
    transaction.on_commit(lambda: discard_job_files(instance.pk))


def clean_deleted_file(pk):
    entry = FileDeletion.objects.filter(pk=pk).first()
    if entry is None:
        return
    try:
        default_storage.delete(entry.name)
    except Exception:
        logger.exception("Storage deletion failed; queued for retry.")
    else:
        entry.delete()


@receiver(post_delete, sender=Release)
@receiver(post_delete, sender=Screenshot)
def queue_deleted_file(sender, instance, **kwargs):
    field = instance.file if sender is Release else instance.image
    if field.name:
        entry, _ = FileDeletion.objects.get_or_create(name=field.name)
        transaction.on_commit(lambda: clean_deleted_file(entry.pk))
