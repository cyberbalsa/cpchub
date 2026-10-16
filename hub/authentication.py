import hashlib
import secrets

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed

from .models import APIKey


class APIKeyAuthentication(BaseAuthentication):
    def authenticate(self, request):
        parts = get_authorization_header(request).split()
        if not parts or parts[0].lower() != b"apikey":
            return None
        if len(parts) != 2:
            raise AuthenticationFailed("Use Authorization: ApiKey <key>.")
        try:
            raw = parts[1].decode("ascii")
            prefix = raw.split("_")[1]
            key = APIKey.objects.select_related("user", "application").get(prefix=prefix)
        except (ValueError, IndexError, UnicodeDecodeError, APIKey.DoesNotExist):
            raise AuthenticationFailed("Invalid API key.")
        if not secrets.compare_digest(key.digest, hashlib.sha256(raw.encode()).hexdigest()) or not key.active or not key.user.is_active:
            raise AuthenticationFailed("Invalid or expired API key.")
        APIKey.objects.filter(pk=key.pk).update(last_used_at=timezone.now())
        return key.user, key

    def authenticate_header(self, request):
        return "ApiKey"
