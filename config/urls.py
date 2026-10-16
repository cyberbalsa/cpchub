from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from oauth2_provider import views as oauth_views
from rest_framework.routers import DefaultRouter

from hub import api, views, moderation, self_service
from hub.accounts import ProfileView
from hub.download_warning import download, reset_warning
from hub.oauth import PKCEAuthorizationView
from hub.support import donate

router = DefaultRouter()
router.register("items", api.ItemViewSet, basename="api-item")
router.register("types", api.ContentTypeViewSet, basename="api-type")
router.register("keys", api.KeyViewSet, basename="api-key")

urlpatterns = [
    path("", views.catalog, name="catalog"),
    path("upload/", views.create_item, name="item-create"),
    path("items/<uuid:pk>/", views.detail, name="item-detail"),
    path("items/<uuid:pk>/edit/", views.edit_item, name="item-edit"),
    path("items/<uuid:pk>/save/", views.bookmark, name="bookmark"),
    path("items/<uuid:pk>/delete/", self_service.delete_own_item, name="item-self-delete"),
    path("items/<uuid:pk>/restore/", self_service.restore_own_item, name="item-self-restore"),
    path("items/<uuid:pk>/unpublish/", self_service.unpublish_own_item, name="item-unpublish"),
    path("items/<uuid:pk>/releases/<uuid:release_id>/download/", download, name="item-download"),
    path("account/keys/", views.keys, name="keys"),
    path("account/profile/", ProfileView.as_view(), name="profile"),
    path("account/download-warning/reset/", reset_warning, name="download-warning-reset"),
    path("account/keys/<uuid:pk>/revoke/", views.revoke_key, name="key-revoke"),
    path("account/managers/<int:pk>/revoke/", views.revoke_manager, name="manager-revoke"),
    path("developers/", views.developers, name="developers"),
    path("donate/", donate, name="donate"),
    path("moderation/", moderation.dashboard, name="moderation"),
    path("moderation/activity/", moderation.account_activity, name="moderation-account-activity"),
    path("moderation/items/<uuid:pk>/", moderation.item_tools, name="moderation-item"),
    path("moderation/items/<uuid:pk>/delete/", moderation.remove_item, name="moderation-delete"),
    path("moderation/items/<uuid:pk>/releases/<uuid:file_id>/edit/", moderation.edit_file, {"kind": "release"}, name="moderation-release-edit"),
    path("moderation/items/<uuid:pk>/releases/<uuid:file_id>/delete/", moderation.remove_file, {"kind": "release"}, name="moderation-release-delete"),
    path("moderation/items/<uuid:pk>/screenshots/<uuid:file_id>/edit/", moderation.edit_file, {"kind": "screenshot"}, name="moderation-screenshot-edit"),
    path("moderation/items/<uuid:pk>/screenshots/<uuid:file_id>/delete/", moderation.remove_file, {"kind": "screenshot"}, name="moderation-screenshot-delete"),
    path("moderation/users/", moderation.users, name="moderation-users"),
    path("moderation/users/<int:pk>/", moderation.user_edit, name="moderation-user"),
    path("moderation/users/<int:pk>/delete/", moderation.user_delete, name="moderation-user-delete"),
    path("accounts/3rdparty/", ProfileView.as_view()),
    path("accounts/", include("allauth.account.urls")),
    path("accounts/3rdparty/", include("allauth.socialaccount.urls")),
    # Steam needs OpenID's models, but generic OpenID login is not offered.
    path("accounts/", include("allauth.socialaccount.providers.steam.urls")),
    path("accounts/", include("allauth.socialaccount.providers.discord.urls")),
    # Expose authorization/token/revocation only. Client registration is staff-managed.
    path("o/authorize/", PKCEAuthorizationView.as_view(), name="authorize"),
    path("o/token/", oauth_views.TokenView.as_view(), name="token"),
    path("o/revoke_token/", oauth_views.RevokeTokenView.as_view(), name="revoke-token"),
    path("api/v1/me/", api.ProfileView.as_view(), name="api-me"),
    path("api/v1/", include(router.urls)),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
    path("health/", views.health, name="health"),
    path("admin/", admin.site.urls),
]
