from django.conf import settings
from .models import ContentType
from .support import kofi_page_url


def site(request):
    return {"catalog_types": ContentType.objects.all(), "public_url": settings.PUBLIC_URL,
            "kofi_page_url": kofi_page_url(),
            "discord_enabled": "discord" in settings.SOCIALACCOUNT_PROVIDERS,
            "steam_enabled": "steam" in settings.SOCIALACCOUNT_PROVIDERS}
