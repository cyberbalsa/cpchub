from django.conf import settings
from django.contrib.admin import AdminSite
from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied
from django.shortcuts import redirect
from django.urls import reverse


class HubAdminSite(AdminSite):
    site_header = "CPC Hub administration"
    site_title = "CPC Hub admin"

    def login(self, request, extra_context=None):
        if self.has_permission(request):
            return redirect("admin:index")
        if request.user.is_authenticated:
            raise PermissionDenied("This account does not have administrator access.")
        return redirect_to_login(reverse("admin:index"), settings.LOGIN_URL)

    def password_change(self, request, extra_context=None):
        return redirect("profile")
