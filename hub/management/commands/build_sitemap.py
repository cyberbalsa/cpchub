import logging
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from hub.sitemaps import build_snapshot

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Rebuild the paginated public sitemap snapshot."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true", help="Rebuild on startup and every 24 hours (Compose).")

    def handle(self, *args, **options):
        while True:
            try:
                count = build_snapshot()
                self.stdout.write(f"Sitemap rebuilt: {count} URLs.")
            except Exception:
                if not options["loop"]:
                    raise
                logger.exception("Sitemap rebuild failed; the previous snapshot is retained.")
                close_old_connections()
                time.sleep(300)
                continue
            if not options["loop"]:
                return
            close_old_connections()
            time.sleep(86400)
