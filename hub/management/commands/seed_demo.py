import hashlib
import json
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from hub.models import ContentType, Item, Release
from hub.services import record_revision


ENTRIES = [
    ("The Neighborhood Special", "blueprints", "A small parking lot with two buildings along the rear edge.", "compact, parking, starter"),
    ("Downtown, Reimagined", "scenarios", "A city block with three buildings, parking bays, and a loop road.", "city, challenge, urban"),
    ("Park & Prosper Collection", "blueprint-packs", "Example pack listing. ZIP packs can hold several blueprints in one download.", "collection, modular, parking"),
    ("Riverside Redevelopment", "scenarios", "A waterfront layout with two buildings and a road across the site.", "waterfront, sandbox, scenic"),
    ("Sunbelt Starter Lot", "blueprints", "A compact parking lot with two low-rise buildings.", "desert, compact, beginner"),
    ("The Concrete Essentials", "mods", "Example listing for mods that fall outside blueprints and scenarios.", "sample, collection, community"),
]
DEMO_DESCRIPTION = (
    "This demo page shows the file details, version history, and download controls.\n\n"
    "The download contains sample JSON metadata only; it cannot be loaded in Car Park Capital. "
    "To share a game file, upload a .cpbp blueprint or .cpcs scenario."
)


class Command(BaseCommand):
    help = "Add labeled demo listings for enabled types with sample JSON downloads."

    @transaction.atomic
    def handle(self, *args, **options):
        if Item.objects.filter(is_demo=True).exists():
            self.stdout.write("Demo catalog already exists; leaving it unchanged.")
            return
        user, created = get_user_model().objects.get_or_create(username="CPC_Demo", defaults={"is_active": False})
        if created:
            user.set_unusable_password()
            user.save()
        elif user.is_active:
            raise CommandError("CPC_Demo is already an active account. Choose another demo username.")
        created_count = 0
        for n,(title,slug,summary,tags) in enumerate(ENTRIES):
            content_type = ContentType.objects.get(slug=slug)
            if not content_type.uploads_enabled:
                continue
            item = Item.objects.create(author=user, title=title, content_type=content_type, summary=summary,
                description=DEMO_DESCRIPTION,
                tags=tags, is_demo=True, artwork=n, status=Item.Status.DRAFT)
            data = json.dumps({"demo": True, "title": title, "notice": "Sample metadata only. Not a game export."}, indent=2).encode()
            # Development fixtures retain clearly labeled sample downloads; public uploads require native files.
            Release.objects.create(item=item, file=ContentFile(data, name="catalog-example.json"), version="1.0.0",
                original_filename="catalog-example.json", size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                changelog="Sample JSON metadata for the demo catalog.")
            # Trusted development fixtures use the bundled illustrations; real uploads use screenshots.
            item.status = Item.Status.PUBLISHED
            item.save(update_fields=["status"])
            record_revision(item,user)
            created_count += 1
        self.stdout.write(self.style.SUCCESS(f"Created {created_count} demo listings. No login-capable demo accounts or game assets added."))
