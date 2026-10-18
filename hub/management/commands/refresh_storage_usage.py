"""Count hosted R2 objects without downloading their contents."""
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.core.files.storage import storages
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from hub.models import StorageUsage


class Command(BaseCommand):
    help = 'Refresh the donation page R2 file count and storage estimate.'

    def handle(self, *args, **options):
        if settings.MEDIA_STORAGE != 'r2':
            raise CommandError('Storage cost inventory requires the active R2 backend.')
        storage = storages['default']
        count = size = 0
        try:
            # Count the entire dedicated bucket, including unreferenced objects.
            pages = storage.connection.meta.client.get_paginator('list_objects_v2').paginate(
                Bucket=storage.bucket_name,
            )
            for page in pages:
                for obj in page.get('Contents', []):
                    count += 1
                    size += obj['Size']
        except (BotoCoreError, ClientError, OSError):
            # Do not replace the last successful snapshot with a partial/zero count.
            raise CommandError('R2 inventory failed; the previous storage count was retained.') from None
        StorageUsage.objects.update_or_create(pk=1, defaults={
            'backend': 'r2', 'object_count': count, 'size_bytes': size,
            'measured_at': timezone.now(),
        })
        self.stdout.write(f'Counted {count} files, {size} bytes in R2.')
