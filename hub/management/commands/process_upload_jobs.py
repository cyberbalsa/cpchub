import logging
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from hub.models import UploadJob
from hub.upload_jobs import collect_job

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Collect isolated file-check results and publish completed uploads.'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true')

    def handle(self, *args, **options):
        while True:
            for pk in UploadJob.objects.filter(status='pending').values_list('pk', flat=True).iterator():
                try:
                    collect_job(pk)
                except Exception:
                    logger.exception('Could not collect upload job %s; will retry.', pk)
            if not options['loop']:
                return
            close_old_connections()
            time.sleep(2)
