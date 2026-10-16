from django import forms
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods, require_POST

from .access import accessible_items, can_moderate, hidden_response
from .models import UserPreferences


WARNING_VERSION = 1
COOKIE_NAME = "cpchub_ugc_warning"
COOKIE_SALT = "hub.download-warning"
COOKIE_MAX_AGE = 365 * 24 * 60 * 60


class DownloadWarningForm(forms.Form):
    remember = forms.BooleanField(required=False, label="Don’t show this again.")


def warning_acknowledged(request):
    if request.user.is_authenticated:
        preferences = UserPreferences.objects.filter(user=request.user).first()
        if preferences is not None:
            # An explicit profile reset also overrides older cookies on other devices.
            return preferences.ugc_warning_version == WARNING_VERSION
    return request.get_signed_cookie(
        COOKIE_NAME, default="", salt=COOKIE_SALT, max_age=COOKIE_MAX_AGE,
    ) == str(WARNING_VERSION)


def remember_warning(request, response):
    if request.user.is_authenticated:
        preferences, _ = UserPreferences.objects.get_or_create(user=request.user)
        if preferences.ugc_warning_version != WARNING_VERSION:
            preferences.ugc_warning_version = WARNING_VERSION
            preferences.ugc_warning_acknowledged_at = timezone.now()
            preferences.save(update_fields=["ugc_warning_version", "ugc_warning_acknowledged_at"])
    response.set_signed_cookie(
        COOKIE_NAME, str(WARNING_VERSION), salt=COOKIE_SALT, max_age=COOKIE_MAX_AGE,
        secure=settings.SESSION_COOKIE_SECURE, httponly=True, samesite="Lax",
    )
    return response


@never_cache
@require_http_methods(["GET", "POST"])
def download(request, pk, release_id):
    item = get_object_or_404(accessible_items(request.user), pk=pk)
    if item.is_hidden and not can_moderate(request.user):
        return hidden_response(request, item)
    release = get_object_or_404(item.releases, pk=release_id)
    destination = reverse("api-item-download", kwargs={"pk": item.pk, "release_id": release.pk})
    form = DownloadWarningForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        if request.headers.get("Accept") == "application/json":
            response = JsonResponse({
                "download_url": destination, "remembered": form.cleaned_data["remember"],
            })
        else:
            response = redirect(destination)
        if form.cleaned_data["remember"]:
            remember_warning(request, response)
        return response
    if request.method == "GET" and warning_acknowledged(request):
        # Restore the browser cookie from a profile, or carry a guest choice into a new profile.
        return remember_warning(request, redirect(destination))
    return render(request, "hub/download_warning.html", {
        "item": item, "release": release, "download_warning_form": form,
        "download_warning_url": request.path,
    })


@login_required
@never_cache
@require_POST
def reset_warning(request):
    UserPreferences.objects.update_or_create(user=request.user, defaults={
        "ugc_warning_version": 0, "ugc_warning_acknowledged_at": None,
    })
    messages.success(request, "The fan-content warning will appear before your next download.")
    response = redirect("profile")
    response.delete_cookie(COOKIE_NAME, samesite="Lax")
    return response
