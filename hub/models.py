import hashlib
import secrets
import uuid
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import models
from django.urls import reverse
from django.utils import timezone


def release_path(instance, filename):
    return f"releases/{instance.item_id}/{uuid.uuid4().hex}{Path(filename).suffix.lower()}"


def screenshot_path(instance, filename):
    return f"screenshots/{instance.item_id}/{uuid.uuid4().hex}.webp"


class ContentType(models.Model):
    """Catalog categories are data so new mod types don't require a deployment."""
    name = models.CharField(max_length=50)
    slug = models.SlugField(unique=True)
    description = models.CharField(max_length=200, blank=True)
    allowed_extensions = models.JSONField(default=list, help_text='Lowercase extensions, e.g. [".zip", ".cpbp", ".json"]. ZIP contents are not executed or extracted.')
    position = models.PositiveIntegerField(default=0)
    uploads_enabled = models.BooleanField(default=False, help_text="Allow new creations and releases for this type.")

    class Meta:
        ordering = ["position", "name"]

    def __str__(self):
        return self.name


class Item(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft (private)"
        PUBLISHED = "published", "Published"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="items")
    content_type = models.ForeignKey(ContentType, on_delete=models.PROTECT, related_name="items")
    title = models.CharField(max_length=100)
    summary = models.CharField(max_length=180)
    description = models.TextField(max_length=20000)
    tags = models.CharField(max_length=200, blank=True, help_text="Comma-separated tags")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PUBLISHED)
    is_demo = models.BooleanField(default=False, editable=False)
    artwork = models.PositiveSmallIntegerField(default=0, editable=False)
    downloads = models.PositiveIntegerField(default=0, editable=False)
    is_hidden = models.BooleanField(default=False, db_index=True, editable=False)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True, editable=False)
    hidden_reason = models.TextField(max_length=2000, blank=True, editable=False)
    hidden_at = models.DateTimeField(null=True, blank=True, editable=False)
    hidden_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="hidden_creations", editable=False)
    featured_at = models.DateTimeField(null=True, blank=True, db_index=True, editable=False)
    featured_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="featured_creations", editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["status", "-updated_at"]), models.Index(fields=["content_type", "status"])]
        constraints = [models.CheckConstraint(condition=models.Q(is_hidden=False) | ~models.Q(hidden_reason=""), name="hidden_item_requires_reason")]

    def __str__(self):
        return self.title

    def get_absolute_url(self):
        return reverse("item-detail", args=[self.pk])

    @property
    def artwork_path(self):
        return f"art/lot-{self.artwork}.svg"

    @property
    def tag_list(self):
        return [tag.strip() for tag in self.tags.split(",") if tag.strip()][:10]

    @property
    def latest_release(self):
        return next(iter(self.releases.all()), None)

    @property
    def collection_count(self):
        if hasattr(self, "_collection_count"):
            return self._collection_count
        return self.bookmarks.count()

    @property
    def delete_after(self):
        return self.deleted_at + timedelta(days=14) if self.deleted_at else None

    @property
    def can_restore(self):
        return self.deleted_at is not None and timezone.now() < self.delete_after


class Release(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="releases")
    version = models.CharField(max_length=40)
    game_version = models.CharField(max_length=40, blank=True)
    changelog = models.TextField(max_length=10000, blank=True)
    file = models.FileField(upload_to=release_path)
    original_filename = models.CharField(max_length=255)
    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    downloads = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["item", "version"], name="unique_item_release_version")]


class Screenshot(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="screenshots")
    image = models.ImageField(upload_to=screenshot_path)
    caption = models.CharField(max_length=180, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class Revision(models.Model):
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="revisions")
    editor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Bookmark(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="bookmarks")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "item"], name="unique_bookmark")]


class UserPreferences(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="hub_preferences")
    ugc_warning_version = models.PositiveSmallIntegerField(default=0)
    ugc_warning_acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name_plural = "User preferences"


class ModerationLog(models.Model):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="moderation_actions")
    item = models.ForeignKey(Item, null=True, blank=True, on_delete=models.SET_NULL)
    item_title = models.CharField(max_length=100, blank=True)
    target_user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="moderation_history")
    username = models.CharField(max_length=150, blank=True)
    action = models.CharField(max_length=40)
    reason = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-pk"]


class FileDeletion(models.Model):
    """Keep failed storage deletions available for retry after a database commit."""
    name = models.CharField(max_length=1024, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)


class UserModeration(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="moderation_state")
    shadow_banned_at = models.DateTimeField(null=True, blank=True)
    shadow_banned_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="shadow_bans")


class AccountActivity(models.Model):
    class Action(models.TextChoices):
        LOGIN = "login", "Signed in"
        CREATE = "create", "Created a creation"
        PUBLISH = "publish", "Published a creation"
        RELEASE = "release", "Uploaded a release"
        SCREENSHOT = "screenshot", "Uploaded a screenshot"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="account_activity")
    item = models.ForeignKey(Item, null=True, blank=True, on_delete=models.SET_NULL)
    item_title = models.CharField(max_length=100, blank=True)
    action = models.CharField(max_length=20, choices=Action.choices)
    ip_address = models.GenericIPAddressField(null=True, blank=True, unpack_ipv4=True, db_index=True)
    ip_source = models.CharField(max_length=12, choices=[("proxy", "Trusted proxy"), ("direct", "Direct connection"), ("unknown", "Unavailable")])
    user_agent = models.CharField(max_length=1024, blank=True)
    accept_language = models.CharField(max_length=256, blank=True)
    auth_method = models.CharField(max_length=32)
    provider_uid = models.CharField(max_length=255, blank=True)
    request_path = models.CharField(max_length=255)
    cf_ray = models.CharField(max_length=80, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-pk"]
        indexes = [models.Index(fields=["user", "-created_at"])]
        verbose_name_plural = "Account activity"


class APIKeyQuerySet(models.QuerySet):
    def active(self):
        return self.filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=timezone.now()), revoked_at__isnull=True)


class APIKey(models.Model):
    objects = APIKeyQuerySet.as_manager()
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="api_keys")
    application = models.ForeignKey("oauth2_provider.Application", null=True, blank=True, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=16, unique=True)
    digest = models.CharField(max_length=64)
    scopes = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True, default=None)
    last_used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def issue(cls, *, user, name, scopes, days=None, application=None):
        prefix = secrets.token_hex(6)
        raw = f"cpc_{prefix}_{secrets.token_urlsafe(32)}"
        key = cls.objects.create(user=user, name=name, prefix=prefix,
                                 digest=hashlib.sha256(raw.encode()).hexdigest(), scopes=scopes,
                                 expires_at=timezone.now() + timedelta(days=days) if days is not None else None, application=application)
        return key, raw

    @property
    def active(self):
        return self.revoked_at is None and (self.expires_at is None or self.expires_at > timezone.now())
