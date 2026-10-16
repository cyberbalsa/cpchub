from django.core.management.base import BaseCommand
from django.utils import timezone

from hub.file_cleanup import clean_deleted_file
from hub.download_counts import purge_download_ips
from hub.models import FileDeletion, UploadEvent
from hub.moderation_services import purge_expired_creations
from hub.upload_limits import UPLOAD_WINDOW


class Command(BaseCommand):
    help = "Remove expired download IPs and creations, and retry storage deletions."

    def handle(self, **options):
        removed = purge_download_ips()
        self.stdout.write(f"{removed} expired download IP records removed.")
        UploadEvent.objects.filter(created_at__lte=timezone.now() - UPLOAD_WINDOW).delete()
        purge_expired_creations()
        for pk in FileDeletion.objects.values_list("pk", flat=True).iterator():
            clean_deleted_file(pk)
        self.stdout.write(f"{FileDeletion.objects.count()} file deletions pending.")
