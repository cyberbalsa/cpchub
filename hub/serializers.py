from rest_framework import serializers

from .models import APIKey, ContentType, Item, Release, Revision, Screenshot
from .validators import validate_version


class ErrorSerializer(serializers.Serializer):
    status = serializers.IntegerField()
    errors = serializers.JSONField(help_text="Field errors or a detail message.")


class ContentTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = ContentType
        fields = ["slug", "name", "description", "allowed_extensions", "uploads_enabled"]


class ReleaseSerializer(serializers.ModelSerializer):
    # Keep the PostgreSQL counter limit in the schema when developing with SQLite.
    downloads = serializers.IntegerField(min_value=0, max_value=2147483647, read_only=True, help_text="Download links issued for this release, deduplicated by account and by IP for 14 days. IPv6 uses /32 subnets. Historical totals are retained.")
    download_url = serializers.SerializerMethodField(help_text="Stable application URL. Checks permissions and redirects to an expiring signed download URL when using Wasabi.")

    def get_download_url(self, obj) -> str:
        return self.context["request"].build_absolute_uri(f"/api/v1/items/{obj.item_id}/releases/{obj.pk}/download/")

    class Meta:
        model = Release
        fields = ["id", "version", "game_version", "changelog", "original_filename", "sha256", "size", "downloads", "created_at", "download_url"]


class ReleaseUploadSerializer(serializers.Serializer):
    file = serializers.FileField(help_text="Native game file, ZIP pack, or JSON. Allowed extensions depend on the content type.")
    version = serializers.CharField(max_length=40, validators=[validate_version])
    game_version = serializers.CharField(max_length=40, required=False, allow_blank=True)
    changelog = serializers.CharField(max_length=10000, required=False, allow_blank=True)


class ScreenshotSerializer(serializers.ModelSerializer):
    image_url = serializers.SerializerMethodField(help_text="Stable application URL. Checks permissions and redirects to an expiring signed screenshot URL when using Wasabi.")

    def get_image_url(self, obj) -> str:
        return self.context["request"].build_absolute_uri(f"/api/v1/items/{obj.item_id}/screenshots/{obj.pk}/image/")

    class Meta:
        model = Screenshot
        fields = ["id", "caption", "image_url", "created_at"]


class ScreenshotUploadSerializer(serializers.Serializer):
    image = serializers.FileField(help_text="PNG, JPEG or WebP; max 10 MB, 20 megapixels. Re-encoded to strip metadata.")
    caption = serializers.CharField(max_length=180, required=False, allow_blank=True)


class RevisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Revision
        fields = ["id", "snapshot", "created_at"]


class ItemSerializer(serializers.ModelSerializer):
    downloads = serializers.IntegerField(min_value=0, max_value=2147483647, read_only=True, help_text="Download links issued across all releases, deduplicated by account and by IP for 14 days. IPv6 uses /32 subnets. Downloading another release does not recount the creation. Historical totals are retained.")
    author = serializers.CharField(source="author.username", read_only=True)
    collection_count = serializers.IntegerField(min_value=0, read_only=True, help_text="Number of people who currently have this creation saved in their collection.")
    content_type = serializers.SlugRelatedField(slug_field="slug", queryset=ContentType.objects.filter(uploads_enabled=True), help_text="An enabled type from /api/v1/types/: blueprints, blueprint-packs or scenarios. Mod uploads are currently disabled.")
    releases = ReleaseSerializer(many=True, read_only=True)
    screenshots = ScreenshotSerializer(many=True, read_only=True)

    def validate_content_type(self, value):
        if self.instance and self.instance.content_type_id != value.pk and self.instance.releases.exists():
            from pathlib import Path
            if any(Path(r.original_filename).suffix.lower() not in value.allowed_extensions for r in self.instance.releases.all()):
                raise serializers.ValidationError("This type does not support all existing release files.")
        return value

    class Meta:
        model = Item
        fields = ["id", "title", "summary", "description", "content_type", "author", "tags", "status", "is_demo", "is_hidden", "hidden_reason", "deleted_at", "featured_at", "downloads", "collection_count", "created_at", "updated_at", "releases", "screenshots"]
        read_only_fields = ["id", "is_demo", "is_hidden", "hidden_reason", "deleted_at", "featured_at", "downloads", "created_at", "updated_at"]


class KeyCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    scopes = serializers.ListField(child=serializers.ChoiceField(choices=["read", "write"]), allow_empty=False, default=["read"])
    days = serializers.IntegerField(min_value=1, max_value=90, default=None, allow_null=True,
                                    help_text="Omit or send null for no expiry (default), or choose 1–90 days. Keys can always be revoked.")


class KeySerializer(serializers.ModelSerializer):
    class Meta:
        model = APIKey
        fields = ["id", "name", "prefix", "scopes", "created_at", "expires_at", "last_used_at", "revoked_at"]


class IssuedKeySerializer(KeySerializer):
    key = serializers.CharField(help_text="Shown only once. Store in the operating system credential store.")

    class Meta(KeySerializer.Meta):
        fields = KeySerializer.Meta.fields + ["key"]


class ProfileSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    username = serializers.CharField()
