from allauth.socialaccount.views import ConnectionsView
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.urls import reverse_lazy
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache

from .download_warning import warning_acknowledged
from .models import Item

@method_decorator(login_required, name="dispatch")
@method_decorator(never_cache, name="dispatch")
class ProfileView(ConnectionsView):
    template_name = "hub/profile.html"
    success_url = reverse_lazy("profile")

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        accounts = list(self.request.user.socialaccount_set.order_by("provider", "pk"))
        context["linked_accounts"] = [
            {"id": account.pk, "provider": account.get_provider().name,
             "name": account.get_provider_account().to_str()}
            for account in accounts
        ]
        context["can_disconnect"] = len(accounts) > 1
        context["download_warning_acknowledged"] = warning_acknowledged(self.request)
        context["hidden_creations"] = Item.objects.filter(author=self.request.user, is_hidden=True).order_by("-hidden_at")
        return context

    @transaction.atomic
    def post(self, request, *args, **kwargs):
        # Serialize disconnects so concurrent requests cannot remove both logins.
        get_user_model().objects.select_for_update().get(pk=request.user.pk)
        return super().post(request, *args, **kwargs)
