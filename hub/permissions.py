from rest_framework.permissions import BasePermission, SAFE_METHODS

from .models import APIKey


def token_scopes(request):
    if isinstance(request.auth, APIKey):
        return set(request.auth.scopes)
    if request.auth is not None:
        return set(request.auth.scope.split())
    return None  # Browser session: CSRF enforced by SessionAuthentication.


class CatalogPermission(BasePermission):
    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            scopes = token_scopes(request)
            return scopes is None or "read" in scopes
        if not request.user.is_authenticated:
            return False
        scopes = token_scopes(request)
        return scopes is None or "write" in scopes

    def has_object_permission(self, request, view, obj):
        return request.method in SAFE_METHODS or obj.author_id == request.user.pk


class KeyPermission(BasePermission):
    def has_permission(self, request, view):
        if not request.user.is_authenticated or isinstance(request.auth, APIKey):
            return False
        scopes = token_scopes(request)
        return scopes is None or "keys:write" in scopes
