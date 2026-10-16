import os
from pathlib import Path
from urllib.parse import urlsplit

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv("DEBUG", "0") == "1"
SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("Set SECRET_KEY, or DEBUG=1 for local development.")
    SECRET_KEY = "local-development-only-not-for-deployment-cpchub"
PUBLIC_URL = os.getenv("PUBLIC_URL", "http://127.0.0.1:8000" if DEBUG else "https://cpchub.net").rstrip("/")
# Public Ko-fi profile URL only; payment/API credentials never belong in templates.
KOFI_PAGE_URL = os.getenv("KOFI_PAGE_URL", "https://ko-fi.com/cpchub")
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS", "127.0.0.1,localhost,cpchub.net").split(",")
CSRF_TRUSTED_ORIGINS = os.getenv("CSRF_TRUSTED_ORIGINS", PUBLIC_URL).split(",")
INSTALLED_APPS = [
    "hub.apps.HubAdminConfig", "django.contrib.auth", "django.contrib.contenttypes",
    "django.contrib.sessions", "django.contrib.messages", "django.contrib.staticfiles",
    "allauth", "allauth.account", "allauth.socialaccount",
    "allauth.socialaccount.providers.discord", "allauth.socialaccount.providers.openid", "allauth.socialaccount.providers.steam",
    "rest_framework", "drf_spectacular", "drf_spectacular_sidecar",
    "oauth2_provider", "django_htmx", "hub.apps.HubConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware", "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware", "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware", "django.contrib.auth.middleware.AuthenticationMiddleware",
    "allauth.account.middleware.AccountMiddleware", "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware", "django_htmx.middleware.HtmxMiddleware",
    "hub.middleware.PrivateResponseMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [BASE_DIR / "templates"],
              "APP_DIRS": True, "OPTIONS": {"context_processors": [
                  "django.template.context_processors.request", "django.contrib.auth.context_processors.auth",
                  "django.contrib.messages.context_processors.messages", "hub.context_processors.site",
              ]}}]
DATABASES = {"default": dj_database_url.config(default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}", conn_max_age=60)}
if not DEBUG and DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
    raise ImproperlyConfigured("Production requires a PostgreSQL DATABASE_URL.")
AUTH_PASSWORD_VALIDATORS = [{"NAME": f"django.contrib.auth.password_validation.{name}"} for name in [
    "UserAttributeSimilarityValidator", "MinimumLengthValidator", "CommonPasswordValidator", "NumericPasswordValidator",
]]
AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend", "allauth.account.auth_backends.AuthenticationBackend"]
LOGIN_URL = "/accounts/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/"
ACCOUNT_LOGIN_METHODS = {"username"}
ACCOUNT_SIGNUP_FIELDS = ["username*"]
ACCOUNT_EMAIL_VERIFICATION = "none"
SOCIALACCOUNT_ONLY = True
SOCIALACCOUNT_QUERY_EMAIL = False
SOCIALACCOUNT_EMAIL_AUTHENTICATION = False
SOCIALACCOUNT_EMAIL_AUTHENTICATION_AUTO_CONNECT = False
SOCIALACCOUNT_LOGIN_ON_GET = False
SOCIALACCOUNT_STORE_TOKENS = False
SOCIALACCOUNT_PROVIDERS = {}
if os.getenv("DISCORD_CLIENT_ID") and os.getenv("DISCORD_CLIENT_SECRET"):
    SOCIALACCOUNT_PROVIDERS["discord"] = {"APPS": [{"client_id": os.environ["DISCORD_CLIENT_ID"], "secret": os.environ["DISCORD_CLIENT_SECRET"]}], "SCOPE": ["identify"]}
if os.getenv("STEAM_API_KEY"):
    SOCIALACCOUNT_PROVIDERS["steam"] = {"APPS": [{"client_id": os.environ["STEAM_API_KEY"], "secret": os.environ["STEAM_API_KEY"]}]}
EMAIL_BACKEND = os.getenv("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend" if DEBUG else "django.core.mail.backends.smtp.EmailBackend")
EMAIL_HOST = os.getenv("EMAIL_HOST", "localhost")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.getenv("EMAIL_USE_TLS", "1") == "1"
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "CPC Hub <accounts@cpchub.net>")
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}, "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}}
# Only UGC uses Wasabi. Static files continue to use WhiteNoise.
MEDIA_STORAGE = os.getenv("MEDIA_STORAGE", "local")
if MEDIA_STORAGE not in {"local", "wasabi"}:
    raise ImproperlyConfigured("MEDIA_STORAGE must be local or wasabi.")
WASABI_BUCKET_NAME = os.getenv("WASABI_BUCKET_NAME", "")
WASABI_REGION = os.getenv("WASABI_REGION", "us-east-1")
WASABI_ENDPOINT_URL = os.getenv("WASABI_ENDPOINT_URL", f"https://s3.{WASABI_REGION}.wasabisys.com")
WASABI_SIGNED_URL_SECONDS = int(os.getenv("WASABI_SIGNED_URL_SECONDS", "300"))
if not 60 <= WASABI_SIGNED_URL_SECONDS <= 900:
    raise ImproperlyConfigured("WASABI_SIGNED_URL_SECONDS must be between 60 and 900.")
_wasabi_keys = {"access_key": os.getenv("WASABI_ACCESS_KEY_ID", ""), "secret_key": os.getenv("WASABI_SECRET_ACCESS_KEY", "")}
if MEDIA_STORAGE == "wasabi" or any(_wasabi_keys.values()) or WASABI_BUCKET_NAME:
    if not all(_wasabi_keys.values()) or not WASABI_BUCKET_NAME:
        raise ImproperlyConfigured("Set WASABI_BUCKET_NAME, WASABI_ACCESS_KEY_ID and WASABI_SECRET_ACCESS_KEY together.")
    _endpoint = urlsplit(WASABI_ENDPOINT_URL)
    if (_endpoint.scheme != "https" or not (_endpoint.hostname or "").endswith(".wasabisys.com")
            or _endpoint.username or _endpoint.password or _endpoint.port or _endpoint.path not in {"", "/"}
            or _endpoint.query or _endpoint.fragment):
        raise ImproperlyConfigured("WASABI_ENDPOINT_URL must be an HTTPS Wasabi S3 regional endpoint.")
    STORAGES["wasabi"] = {"BACKEND": "hub.storage.WasabiMediaStorage", "OPTIONS": {
        **_wasabi_keys, "bucket_name": WASABI_BUCKET_NAME, "region_name": WASABI_REGION,
        "endpoint_url": WASABI_ENDPOINT_URL, "querystring_expire": WASABI_SIGNED_URL_SECONDS,
    }}
    if MEDIA_STORAGE == "wasabi":
        STORAGES["default"] = STORAGES["wasabi"]
# Application URLs check permissions, then stream local files or redirect to signed URLs.
MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", str(BASE_DIR / "media")))
MEDIA_URL = "/private-media/"
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
MAX_SCREENSHOTS = 8
# allauth's legacy OpenID tables use AutoField; HubConfig opts our tables into BigAutoField.
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"
OAUTH2_PROVIDER_APPLICATION_MODEL = "oauth2_provider.Application"
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
# Enable only behind the supplied Caddy proxy, which replaces this header.
if os.getenv("TRUST_PROXY", "0") == "1":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
OAUTH2_PROVIDER = {
    "PKCE_REQUIRED": True,
    "ACCESS_TOKEN_EXPIRE_SECONDS": 900,
    "REFRESH_TOKEN_EXPIRE_SECONDS": 30 * 86400,
    "ROTATE_REFRESH_TOKEN": True,
    "REFRESH_TOKEN_REUSE_PROTECTION": True,
    "REFRESH_TOKEN_GRACE_PERIOD_SECONDS": 0,
    "SCOPES": {"read": "Read your profile and catalog", "write": "Publish and edit your uploads", "keys:write": "Create and revoke API keys for this manager"},
    "DEFAULT_SCOPES": ["read"],
    "ALLOWED_REDIRECT_URI_SCHEMES": ["http", "https"],
    "OAUTH2_VALIDATOR_CLASS": "hub.oauth.HubOAuth2Validator",
    "COMPLIANT_BCP_RFC9700_IMPLICIT_GRANT": True,
    "COMPLIANT_BCP_RFC9700_PASSWORD_GRANT": True,
    "COMPLIANT_BCP_RFC9700_PKCE_METHOD": True,
    "COMPLIANT_BCP_RFC9700_ACCESS_TOKEN_TRANSPORT": True,
    "COMPLIANT_BCP_RFC9700_TOKEN_STORAGE": True,
    "COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS": True,
    "OIDC_ISS_ENDPOINT": PUBLIC_URL,
}
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["hub.authentication.APIKeyAuthentication", "oauth2_provider.contrib.rest_framework.OAuth2Authentication", "rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["hub.permissions.CatalogPermission"],
    "DEFAULT_SCHEMA_CLASS": "hub.schema.HubAutoSchema",
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 24,
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle", "rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"anon": "120/min", "user": "300/min"},
    "EXCEPTION_HANDLER": "hub.api_errors.exception_handler",
}
SPECTACULAR_SETTINGS = {
    "TITLE": "CPC Hub API", "DESCRIPTION": "Versioned community catalog for Car Park Capital. OAuth authorization code + S256 PKCE for mod managers; scoped personal API keys for scripts.",
    "VERSION": "1.0.0", "OAS_VERSION": "3.1.0", "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SWAGGER_UI_DIST": "SIDECAR", "SWAGGER_UI_FAVICON_HREF": "SIDECAR", "REDOC_DIST": "SIDECAR",
    "OAUTH2_FLOWS": ["authorizationCode"], "OAUTH2_AUTHORIZATION_URL": "/o/authorize/", "OAUTH2_TOKEN_URL": "/o/token/",
    "OAUTH2_SCOPES": OAUTH2_PROVIDER["SCOPES"],
    "SWAGGER_UI_OAUTH2_CONFIG": {"usePkceWithAuthorizationCodeGrant": True},
}
