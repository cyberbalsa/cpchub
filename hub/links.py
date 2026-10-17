"""Web links leave the site only after an explicit confirmation."""
import unicodedata
from urllib.parse import urlencode, urlsplit

from django.http import HttpResponseBadRequest
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe


def safe_web_url(value, *, absolute=False):
    value = str(value or "").strip()
    if not value or len(value) > 4096 or "\\" in value:
        return ""
    if any(char.isspace() or unicodedata.category(char).startswith("C") for char in value):
        return ""
    if value.startswith("//") and not value.startswith("///"):
        value = "https:" + value
    try:
        parts = urlsplit(value)
        if parts.scheme:
            if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
                return ""
            if parts.username is not None or parts.password is not None:
                return ""
            parts.port  # Reject malformed/out-of-range ports.
        elif absolute or parts.netloc or value.startswith("//"):
            return ""
    except ValueError:
        return ""
    return value


def _origin(value):
    parts = urlsplit(value)
    return parts.scheme.lower(), parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)


def protected_url(value, request):
    value = safe_web_url(value)
    if not value:
        return ""
    if not urlsplit(value).scheme or _origin(value) == _origin(request.build_absolute_uri("/")):
        return value
    return reverse("outbound-link") + "?" + urlencode({"url": value})


@never_cache
@require_safe
def outbound_link(request):
    destination = safe_web_url(request.GET.get("url"), absolute=True)
    if not destination:
        return HttpResponseBadRequest("This link is not a valid web address.")
    return render(request, "hub/outbound.html", {"destination": destination})
