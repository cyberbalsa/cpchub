from django.conf import settings
from django.db.models import Count, Sum
from .models import ContentType
from .support import kofi_page_url
from .access import can_manage_content, can_moderate, is_admin, public_items, role_for


def site(request):
    return {"catalog_types": ContentType.objects.filter(uploads_enabled=True), "public_url": settings.PUBLIC_URL,
            "min_screenshots": settings.MIN_SCREENSHOTS, "max_screenshots": settings.MAX_SCREENSHOTS,
            "site_role": role_for(request.user), "can_moderate": can_moderate(request.user), "can_manage_content": can_manage_content(request.user), "is_site_admin": is_admin(request.user),
            "site_totals": public_items().filter(is_demo=False).aggregate(
                uploads=Count("pk", distinct=True), total_bytes=Sum("releases__size", default=0)),
            "kofi_page_url": kofi_page_url(),
            "discord_enabled": "discord" in settings.SOCIALACCOUNT_PROVIDERS,
            "steam_enabled": "steam" in settings.SOCIALACCOUNT_PROVIDERS}
