"""Copy referenced uploads between backends, keeping names and source objects."""
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.core.files.storage import FileSystemStorage, storages
from django.core.management.base import BaseCommand, CommandError

from hub.management.commands.migrate_uploads_to_wasabi import digest
from hub.models import Release, Screenshot


class Command(BaseCommand):
    help = "Copy and checksum releases/screenshots between storage backends. Stop upload writers before applying."

    def add_arguments(self, parser):
        parser.add_argument("--source", required=True, choices=["local", "wasabi", "r2"])
        parser.add_argument("--target", required=True, choices=["wasabi", "r2"])
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument("--apply", action="store_true")
        mode.add_argument("--verify-only", action="store_true")

    def handle(self, *args, **options):
        if options["source"] == options["target"]:
            raise CommandError("Source and target must be different storage backends.")
        for alias in (options["source"], options["target"]):
            if alias != "local" and alias not in settings.STORAGES:
                raise CommandError(f"Configure {alias} credentials before migrating uploads.")
        source = FileSystemStorage(location=settings.MEDIA_ROOT) if options["source"] == "local" else storages[options["source"]]
        target = storages[options["target"]]
        checked = copied = missing = 0
        try:
            for model, field, prefix in [(Release, "file", "releases/"), (Screenshot, "image", "screenshots/")]:
                for row in model.objects.all().iterator():
                    name = getattr(row, field).name
                    if not name.startswith(prefix) or ".." in name.split("/"):
                        raise CommandError(f"Unexpected upload path for {model.__name__} {row.pk}.")
                    if not source.exists(name):
                        raise CommandError(f"Missing source upload for {model.__name__} {row.pk}.")
                    checksum = digest(source, name)
                    if model is Release and (checksum != row.sha256 or source.size(name) != row.size):
                        raise CommandError(f"Source content does not match release {row.pk}.")
                    if target.exists(name):
                        if digest(target, name) != checksum:
                            raise CommandError(f"Target content differs for {row.pk}; refusing to overwrite it.")
                    elif options["verify_only"]:
                        raise CommandError(f"Missing target upload for {model.__name__} {row.pk}.")
                    elif options["apply"]:
                        with source.open(name, "rb") as original:
                            stored_name = target.save(name, original)
                        if stored_name != name:
                            target.delete(stored_name)
                            raise CommandError(f"Target name collision for {row.pk}; migration stopped.")
                        if digest(target, name) != checksum:
                            raise CommandError(f"Target checksum verification failed for {row.pk}.")
                        copied += 1
                    else:
                        missing += 1
                    checked += 1
        except (BotoCoreError, ClientError, OSError):
            raise CommandError("Storage operation failed. Source files were retained; keep the current backend active and retry.") from None
        self.stdout.write(self.style.SUCCESS(
            f"Checked {checked} source files; copied {copied}; missing from target {missing}. Source originals retained."
        ))
