"""Copy referenced uploads without changing file names or removing local originals."""
import hashlib

from django.conf import settings
from django.core.files.storage import FileSystemStorage, storages
from django.core.management.base import BaseCommand, CommandError

from hub.models import Release, Screenshot


def digest(storage, name):
    sha = hashlib.sha256()
    with storage.open(name, "rb") as source:
        for chunk in source.chunks():
            sha.update(chunk)
    return sha.hexdigest()


class Command(BaseCommand):
    help = "Verify and copy uploaded releases/screenshots to Wasabi. Defaults to a dry run; local files are kept."

    def add_arguments(self, parser):
        parser.add_argument("--source", default=str(settings.MEDIA_ROOT))
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        if "wasabi" not in settings.STORAGES:
            raise CommandError("Configure Wasabi credentials before migrating uploads.")
        source = FileSystemStorage(location=options["source"])
        target = storages["wasabi"]
        checked = copied = 0
        for model, field in [(Release, "file"), (Screenshot, "image")]:
            for row in model.objects.all().iterator():
                name = getattr(row, field).name
                expected_prefix = "releases/" if model is Release else "screenshots/"
                if not name.startswith(expected_prefix):
                    raise CommandError(f"Unexpected upload path for {model.__name__} {row.pk}.")
                if not source.exists(name):
                    raise CommandError(f"Missing local upload for {model.__name__} {row.pk}.")
                checksum = digest(source, name)
                if model is Release and (checksum != row.sha256 or source.size(name) != row.size):
                    raise CommandError(f"Local file does not match release {row.pk}.")
                if target.exists(name):
                    if digest(target, name) != checksum:
                        raise CommandError(f"Remote content differs for {row.pk}; refusing to overwrite it.")
                elif options["apply"]:
                    with source.open(name, "rb") as original:
                        stored_name = target.save(name, original)
                    if stored_name != name:
                        target.delete(stored_name)
                        raise CommandError(f"Remote name collision for {row.pk}; migration stopped.")
                    if digest(target, name) != checksum:
                        raise CommandError(f"Remote checksum verification failed for {row.pk}.")
                    copied += 1
                checked += 1
        mode = "Migration" if options["apply"] else "Dry run"
        self.stdout.write(self.style.SUCCESS(f"{mode}: {checked} files verified, {copied} copied. Local originals retained."))
