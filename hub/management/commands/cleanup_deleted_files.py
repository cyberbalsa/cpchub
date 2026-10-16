from django.core.management.base import BaseCommand

from hub.file_cleanup import clean_deleted_file
from hub.models import FileDeletion
from hub.moderation_services import purge_expired_creations


class Command(BaseCommand):
    help = "Retry removal of deleted uploads from file storage."

    def handle(self, **options):
        purge_expired_creations()
        for pk in FileDeletion.objects.values_list("pk", flat=True).iterator():
            clean_deleted_file(pk)
        self.stdout.write(f"{FileDeletion.objects.count()} file deletions pending.")
