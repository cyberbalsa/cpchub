from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.models import Group
from django.shortcuts import redirect
from .models import APIKey, ContentType, Item, Release, Revision, Screenshot


@admin.register(ContentType)
class ContentTypeAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "allowed_extensions", "uploads_enabled", "position"]
    list_filter = ["uploads_enabled"]
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Item)
class ItemAdmin(admin.ModelAdmin):
    list_display = ["title", "author", "content_type", "status", "is_hidden", "featured_at", "updated_at"]
    list_filter = ["status", "is_hidden", "content_type", "is_demo"]
    search_fields = ["title", "author__username"]
    readonly_fields = ["downloads"]
    actions = None

    def add_view(self, request, form_url="", extra_context=None):
        return redirect("item-create")

    def change_view(self, request, object_id, form_url="", extra_context=None):
        return redirect("moderation-item", pk=object_id)

    def delete_view(self, request, object_id, extra_context=None):
        return redirect("moderation-delete", pk=object_id)

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        from .services import record_revision
        record_revision(obj, request.user)


class ImmutableAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class FileAdmin(ImmutableAdmin):
    def change_view(self, request, object_id, form_url="", extra_context=None):
        obj = self.get_object(request, object_id)
        if obj is None:
            return redirect("moderation")
        return redirect("moderation-item", pk=obj.item_id)


admin.site.register(Release, FileAdmin)
admin.site.register(Revision, ImmutableAdmin)
admin.site.register(Screenshot, FileAdmin)


class ManagedUserAdmin(UserAdmin):
    actions = None

    def changelist_view(self, request, extra_context=None):
        return redirect("moderation-users")

    def change_view(self, request, object_id, form_url="", extra_context=None):
        return redirect("moderation-user", pk=object_id)

    def add_view(self, request, form_url="", extra_context=None):
        return redirect("moderation-users")

    def delete_view(self, request, object_id, extra_context=None):
        return redirect("moderation-user-delete", pk=object_id)

    def user_change_password(self, request, id, form_url=""):
        return redirect("moderation-user", pk=id)


admin.site.unregister(get_user_model())
admin.site.register(get_user_model(), ManagedUserAdmin)
admin.site.unregister(Group)


@admin.register(APIKey)
class APIKeyAdmin(ImmutableAdmin):
    list_display = ["name", "user", "prefix", "expires_at", "revoked_at"]
    exclude = ["digest"]

admin.site.site_header = "CPC Hub · Control Panel"
admin.site.site_title = "CPC Hub"
