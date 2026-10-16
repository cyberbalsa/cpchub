import re

from allauth.account.signals import user_logged_in
from django.dispatch import receiver

from .client_ip import normalize_ip
from .models import AccountActivity, APIKey


def clean_header(value, limit):
    return "".join(char for char in value[:limit] if char.isprintable()).strip()


def record_activity(request, action, *, item=None, user=None, sociallogin=None):
    if request is None:
        return
    user = user or request.user
    if not user.is_authenticated:
        return
    auth = getattr(request, "auth", None)
    method = "api_key" if isinstance(auth, APIKey) else "oauth2" if auth is not None else "session"
    provider_uid = ""
    if sociallogin is not None:
        method = sociallogin.account.provider
        provider_uid = str(sociallogin.account.uid)
    ray = request.META.get("HTTP_CF_RAY", "") if getattr(request, "trusted_proxy", False) else ""
    if not re.fullmatch(r"[a-fA-F0-9]{16,32}-[A-Z]{3}", ray):
        ray = ""
    return AccountActivity.objects.create(
        user=user, item=item, item_title=item.title if item else "", action=action,
        ip_address=getattr(request, "client_ip", normalize_ip(request.META.get("REMOTE_ADDR", ""))),
        ip_source=getattr(request, "client_ip_source", "direct"),
        user_agent=clean_header(request.META.get("HTTP_USER_AGENT", ""), 1024),
        accept_language=clean_header(request.META.get("HTTP_ACCEPT_LANGUAGE", ""), 256),
        auth_method=method[:32], provider_uid=provider_uid[:255],
        request_path=request.path[:255], cf_ray=ray,
    )


@receiver(user_logged_in, dispatch_uid="hub.record_login_activity")
def record_login(sender, request, user, sociallogin=None, **kwargs):
    record_activity(request, AccountActivity.Action.LOGIN, user=user, sociallogin=sociallogin)
