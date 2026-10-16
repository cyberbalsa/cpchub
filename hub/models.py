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

    class Meta:
        ordering = ["position", "name"]

    def __str__(self):
        return self.name


class Item(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft (only you)"
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
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["status", "-updated_at"]), models.Index(fields=["content_type", "status"])]

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


class APIKey(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="api_keys")
    application = models.ForeignKey("oauth2_provider.Application", null=True, blank=True, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=16, unique=True)
    digest = models.CharField(max_length=64)
    scopes = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    last_used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def issue(cls, *, user, name, scopes, days=90, application=None):
        prefix = secrets.token_hex(6)
        raw = f"cpc_{prefix}_{secrets.token_urlsafe(32)}"
        key = cls.objects.create(user=user, name=name, prefix=prefix,
                                 digest=hashlib.sha256(raw.encode()).hexdigest(), scopes=scopes,
                                 expires_at=timezone.now() + timedelta(days=days), application=application)
        return key, raw

    @property
    def active(self):
        return self.revoked_at is None and self.expires_at > timezone.now()
