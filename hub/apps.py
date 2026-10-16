from django.apps import AppConfig
from django.contrib.admin.apps import AdminConfig


class HubAdminConfig(AdminConfig):
    default_site = "hub.admin_site.HubAdminSite"


class HubConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "hub"

    def ready(self):
        from . import schema, file_cleanup, activity  # noqa: F401
