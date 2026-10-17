from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError

from hub.models import Release
from hub.upload_jobs import queue_release_stats


class Command(BaseCommand):
    help = 'Queue isolated statistics extraction for existing native releases. Does not reupload files.'

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=32)
        parser.add_argument('--force', action='store_true')
        parser.add_argument('--release', action='append', dest='releases')

    def handle(self, *args, **options):
        if not 1 <= options['limit'] <= 64:
            raise CommandError('Use a limit from 1 to 64.')
        releases = Release.objects.filter(item__is_demo=False, item__deleted_at=None).select_related('item__author')
        if options['releases']:
            releases = releases.filter(pk__in=options['releases'])
        if not options['force']:
            releases = releases.filter(file_stats={})
        queued = 0
        for release in releases.iterator():
            if Path(release.original_filename).suffix.lower() not in {'.cpbp', '.cpcs'}:
                continue
            try:
                job = queue_release_stats(release)
            except ValidationError as exc:
                raise CommandError('; '.join(exc.messages)) from exc
            if job:
                queued += 1
            if queued >= options['limit']:
                break
        self.stdout.write(f'{queued} file statistics jobs queued.')
