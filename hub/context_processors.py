from django.conf import settings
from django.db.models import Count, Sum
from .models import ContentType, Item
from .support import kofi_page_url


def site(request):
    return {"catalog_types": ContentType.objects.filter(uploads_enabled=True), "public_url": settings.PUBLIC_URL,
            "min_screenshots": settings.MIN_SCREENSHOTS, "max_screenshots": settings.MAX_SCREENSHOTS,
            "site_totals": Item.objects.filter(status=Item.Status.PUBLISHED, is_demo=False).aggregate(
                uploads=Count("pk", distinct=True), total_bytes=Sum("releases__size", default=0)),
            "kofi_page_url": kofi_page_url(),
            "discord_enabled": "discord" in settings.SOCIALACCOUNT_PROVIDERS,
            "steam_enabled": "steam" in settings.SOCIALACCOUNT_PROVIDERS}
