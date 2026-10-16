from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from oauth2_provider import views as oauth_views
from rest_framework.routers import DefaultRouter

from hub import api, views
from hub.oauth import PKCEAuthorizationView

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
    path("account/keys/", views.keys, name="keys"),
    path("account/keys/<uuid:pk>/revoke/", views.revoke_key, name="key-revoke"),
    path("account/managers/<int:pk>/revoke/", views.revoke_manager, name="manager-revoke"),
    path("developers/", views.developers, name="developers"),
    path("accounts/", include("allauth.urls")),
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
