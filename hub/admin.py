from django.contrib import admin
from .models import APIKey, ContentType, Item, Release, Revision, Screenshot


@admin.register(ContentType)
class ContentTypeAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "allowed_extensions", "position"]
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Item)
class ItemAdmin(admin.ModelAdmin):
    list_display = ["title", "author", "content_type", "status", "updated_at"]
    list_filter = ["status", "content_type", "is_demo"]
    search_fields = ["title", "author__username"]
    readonly_fields = ["downloads"]

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        from .services import record_revision
        record_revision(obj, request.user)


class ImmutableAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


admin.site.register(Release, ImmutableAdmin)
admin.site.register(Revision, ImmutableAdmin)
admin.site.register(Screenshot)


@admin.register(APIKey)
class APIKeyAdmin(ImmutableAdmin):
    list_display = ["name", "user", "prefix", "expires_at", "revoked_at"]
    exclude = ["digest"]

admin.site.site_header = "CPC Hub · Control Panel"
admin.site.site_title = "CPC Hub"
