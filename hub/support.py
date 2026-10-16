"""The public support page. Ko-fi handles checkout; no payment secrets reach HTML."""
import re

from django.conf import settings
from django.shortcuts import render
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe


def kofi_page_url():
    # Configuration is a public profile URL, never an API key or checkout URL.
    value = getattr(settings, "KOFI_PAGE_URL", "").strip()
    if re.fullmatch(r"https://ko-fi\.com/[A-Za-z0-9_\-]+/?", value):
        return value.rstrip("/")
    return ""


@never_cache
@require_safe
def donate(request):
    # The shared site header can contain account details; keep this response private.
    return render(request, "hub/donate.html", {"kofi_page_url": kofi_page_url()})
