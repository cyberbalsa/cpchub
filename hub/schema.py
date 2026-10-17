from drf_spectacular.extensions import OpenApiAuthenticationExtension
from drf_spectacular.contrib.django_oauth_toolkit import DjangoOAuthToolkitScheme
from drf_spectacular.openapi import AutoSchema


class HubAutoSchema(AutoSchema):
    def get_auth(self):
        auth = super().get_auth()
        if self.method in {"GET", "HEAD"} and (self.view.__class__.__name__ == "ContentTypeViewSet" or self.view.__class__.__name__ == "TagViewSet" and self.view.action == "list" or self.view.__class__.__name__ == "ItemViewSet" and self.view.action in {"list", "retrieve", "download", "screenshot_image"}):
            auth.append({})
        return auth

    def get_response_serializers(self):
        from .serializers import ErrorSerializer
        response = super().get_response_serializers()
        if not isinstance(response, dict):
            code = "201" if self._is_create_operation() else "204" if self.method == "DELETE" else "200"
            response = {code: response if code != "204" else None}
        for code in [400, 401, 403, 404, 429]:
            response.setdefault(code, ErrorSerializer)
        return response


class HubOAuthScheme(DjangoOAuthToolkitScheme):
    priority = 1

    def get_security_requirement(self, auto_schema):
        if auto_schema.view.__class__.__name__ == "KeyViewSet":
            return {self.name: ["keys:write"]}
        return {self.name: ["read" if auto_schema.method in {"GET", "HEAD", "OPTIONS"} else "write"]}


class APIKeyScheme(OpenApiAuthenticationExtension):
    target_class = "hub.authentication.APIKeyAuthentication"
    name = "PersonalAPIKey"

    def get_security_requirement(self, auto_schema):
        if auto_schema.view.__class__.__name__ == "KeyViewSet":
            return None
        return {self.name: []}

    def get_security_definition(self, auto_schema):
        return {"type": "apiKey", "in": "header", "name": "Authorization",
                "description": "ApiKey cpc_<prefix>_<secret>. Keys are scoped and revocable, with no expiry by default."}
