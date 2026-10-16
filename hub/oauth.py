from urllib.parse import urlparse
from oauth2_provider.oauth2_validators import OAuth2Validator
from oauth2_provider.views import AuthorizationView
from django.http import JsonResponse


class PKCEAuthorizationView(AuthorizationView):
    def dispatch(self, request, *args, **kwargs):
        data = request.GET if request.method == "GET" else request.POST
        if data.get("code_challenge_method") != "S256" or not data.get("code_challenge"):
            return JsonResponse({"error": "invalid_request", "error_description": "A code_challenge with code_challenge_method=S256 is required."}, status=400)
        return super().dispatch(request, *args, **kwargs)


class HubOAuth2Validator(OAuth2Validator):
    def validate_redirect_uri(self, client_id, redirect_uri, request, *args, **kwargs):
        parsed = urlparse(redirect_uri)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1"}):
            return False
        return super().validate_redirect_uri(client_id, redirect_uri, request, *args, **kwargs)

    def validate_grant_type(self, client_id, grant_type, client, request, *args, **kwargs):
        if grant_type not in {"authorization_code", "refresh_token"}:
            return False
        return super().validate_grant_type(client_id, grant_type, client, request, *args, **kwargs)
