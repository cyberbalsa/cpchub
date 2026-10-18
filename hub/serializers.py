from rest_framework import serializers

from .markdown import MARKDOWN_API_HELP
from .models import APIKey, ContentType, Item, Release, Revision, Screenshot, Tag, UploadJob
from .validators import validate_version
from .tags import clean_tags
from .file_stats import METRICS
from sandbox.protocol import BOUNDS


class FileStatsSerializer(serializers.Serializer):
    schema_version = serializers.IntegerField(min_value=1, max_value=1, required=False)
    kind = serializers.ChoiceField(choices=['blueprint', 'scenario'], required=False)
    format_version = serializers.IntegerField(min_value=2, max_value=3, allow_null=True, required=False)
    width = serializers.IntegerField(min_value=1, max_value=2048, required=False, help_text='Blueprint width, or largest map width, in tiles.')
    depth = serializers.IntegerField(min_value=1, max_value=2048, required=False, help_text='Blueprint depth, or largest map depth, in tiles.')
    height = serializers.IntegerField(min_value=1, max_value=2048, required=False, help_text='Blueprint height, or largest map height, in tiles.')
    footprint_tiles = serializers.IntegerField(min_value=1, max_value=67108864, required=False, help_text='Width × depth for blueprints; sum of map areas for scenarios.')
    objects = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)
    object_types = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)
    parking_spaces = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False, help_text='Saved ParkingBay objects; does not check road access or usability.')
    golf_cart_spaces = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)
    entrances = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)
    exits = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)
    maps = serializers.IntegerField(min_value=1, max_value=16, allow_null=True, required=False)
    entities = serializers.IntegerField(min_value=0, max_value=1000000, allow_null=True, required=False)


FileStatsFilterSerializer = type('FileStatsFilterSerializer', (serializers.Serializer,), {
    f'{bound}_{name}': serializers.IntegerField(required=False, min_value=0, max_value=BOUNDS.get(name, (0, 1000000))[1],
        help_text=f'{title} {label.lower()}{" (" + unit + ")" if unit else ""} in the latest release. Missing statistics never match. Bounds are inclusive.')
    for name, (label, unit) in METRICS.items() for bound, title in [('min', 'Minimum'), ('max', 'Maximum')]
})


class ErrorSerializer(serializers.Serializer):
    status = serializers.IntegerField()
    errors = serializers.JSONField(help_text="Field errors or a detail message.")


class ContentTypeSerializer(serializers.ModelSerializer):
    max_upload_bytes = serializers.SerializerMethodField(help_text="Current maximum size of each game file. Defaults to 15 MiB; Admin-adjustable.")

    def get_max_upload_bytes(self, obj) -> int:
        from .upload_settings import max_game_file_bytes
        return max_game_file_bytes()

    class Meta:
        model = ContentType
        fields = ["slug", "name", "description", "allowed_extensions", "uploads_enabled", "max_upload_bytes"]


class TagSerializer(serializers.ModelSerializer):
    item_count = serializers.IntegerField(read_only=True, min_value=0, help_text="Number of visible, published, non-demo creations using this tag.")

    class Meta:
        model = Tag
        fields = ["name", "item_count"]


class TagSuggestionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["name"]


class ReleaseSerializer(serializers.ModelSerializer):
    changelog = serializers.CharField(max_length=10000, required=False, allow_blank=True, help_text=MARKDOWN_API_HELP)
    file_stats = FileStatsSerializer(read_only=True, help_text='Statistics decoded in an isolated VM. Empty for files not yet inspected; null means unavailable or not applicable.')
    # Keep the PostgreSQL counter limit in the schema when developing with SQLite.
    downloads = serializers.IntegerField(min_value=0, max_value=2147483647, read_only=True, help_text="Download links issued for this release, deduplicated by account and by IP for 14 days. IPv6 uses /32 subnets. Historical totals are retained.")
    download_url = serializers.SerializerMethodField(help_text="Stable application URL. Checks permissions and redirects to an expiring signed download URL when using R2 or Wasabi.")

    def get_download_url(self, obj) -> str:
        return self.context["request"].build_absolute_uri(f"/api/v1/items/{obj.item_id}/releases/{obj.pk}/download/")

    class Meta:
        model = Release
        fields = ["id", "version", "game_version", "changelog", "original_filename", "sha256", "size", "downloads", "created_at", "download_url", "file_stats"]


class ReleaseUploadSerializer(serializers.Serializer):
    file = serializers.FileField(help_text="Raw .cpbp blueprint or .cpcs scenario, up to 15 MB by default (Admin-adjustable). ZIP packs and JSON uploads are disabled.")
    version = serializers.CharField(max_length=40, validators=[validate_version])
    game_version = serializers.CharField(max_length=40, required=False, allow_blank=True)
    changelog = serializers.CharField(max_length=10000, required=False, allow_blank=True, help_text=MARKDOWN_API_HELP)


class ScreenshotSerializer(serializers.ModelSerializer):
    image_url = serializers.SerializerMethodField(help_text="Stable application URL. Checks permissions and redirects to an expiring signed screenshot URL when using R2 or Wasabi.")

    def get_image_url(self, obj) -> str:
        return self.context["request"].build_absolute_uri(f"/api/v1/items/{obj.item_id}/screenshots/{obj.pk}/image/")

    class Meta:
        model = Screenshot
        fields = ["id", "caption", "image_url", "created_at"]


class ScreenshotUploadSerializer(serializers.Serializer):
    image = serializers.FileField(help_text="Still PNG, JPEG or WebP; 320×180 minimum, 8192 pixels per side maximum, max 10 MB and 20 megapixels; aspect ratio 1:6 to 6:1. Checked and re-encoded to WebP inside an isolated VM. Returns a validation job.")
    caption = serializers.CharField(max_length=180, required=False, allow_blank=True)


class RevisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Revision
        fields = ["id", "snapshot", "created_at"]


class UploadJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = UploadJob
        fields = ["id", "kind", "status", "original_filename", "error", "release", "screenshot", "created_at", "completed_at"]
        read_only_fields = fields


class ItemSerializer(serializers.ModelSerializer):
    description = serializers.CharField(max_length=20000, help_text=MARKDOWN_API_HELP)
    downloads = serializers.IntegerField(min_value=0, max_value=2147483647, read_only=True, help_text="Download links issued across all releases, deduplicated by account and by IP for 14 days. IPv6 uses /32 subnets. Downloading another release does not recount the creation. Historical totals are retained.")
    author = serializers.CharField(source="author.username", read_only=True)
    collection_count = serializers.IntegerField(min_value=0, read_only=True, help_text="Number of people who currently have this creation saved in their collection.")
    content_type = serializers.SlugRelatedField(slug_field="slug", queryset=ContentType.objects.filter(uploads_enabled=True), help_text="An enabled type from /api/v1/types/: blueprints or scenarios. Pack and mod uploads are disabled.")
    tags = serializers.CharField(max_length=200, allow_blank=True, required=False, help_text="Comma-separated tags. Public responses include only tags meeting the configurable publication threshold (11 visible creations by default). Authors and staff browser sessions can read all assigned tags. Use /api/v1/tags/suggest/ for editing suggestions.")
    releases = ReleaseSerializer(many=True, read_only=True)
    screenshots = ScreenshotSerializer(many=True, read_only=True)

    def validate_tags(self, value):
        from django.core.exceptions import ValidationError
        try:
            return clean_tags(value)
        except ValidationError as exc:
            raise serializers.ValidationError(exc.messages)

    def to_representation(self, instance):
        from .access import can_moderate
        data = super().to_representation(instance)
        request = self.context.get("request")
        private = request and (request.user.pk == instance.author_id or request.auth is None and can_moderate(request.user))
        if not private:
            data["tags"] = ", ".join(instance.public_tag_list)
        return data

    def validate_content_type(self, value):
        if self.instance and self.instance.content_type_id != value.pk and self.instance.releases.exists():
            from pathlib import Path
            if any(Path(r.original_filename).suffix.lower() not in value.allowed_extensions for r in self.instance.releases.all()):
                raise serializers.ValidationError("This type does not support all existing release files.")
        return value

    class Meta:
        model = Item
        fields = ["id", "title", "summary", "description", "content_type", "author", "tags", "status", "publish_after_validation", "is_demo", "is_hidden", "hidden_reason", "deleted_at", "featured_at", "downloads", "collection_count", "created_at", "updated_at", "releases", "screenshots"]
        read_only_fields = ["id", "publish_after_validation", "is_demo", "is_hidden", "hidden_reason", "deleted_at", "featured_at", "downloads", "created_at", "updated_at"]


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
