from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import F, Q
from django.http import FileResponse
from rest_framework.generics import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, OpenApiTypes, extend_schema, extend_schema_view
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import APIKey, ContentType, Item, Release
from .permissions import CatalogPermission, KeyPermission, token_scopes
from .serializers import (ContentTypeSerializer, ErrorSerializer, IssuedKeySerializer, ItemSerializer,
                          KeyCreateSerializer, KeySerializer, ProfileSerializer, ReleaseSerializer,
                          ReleaseUploadSerializer, RevisionSerializer, ScreenshotSerializer, ScreenshotUploadSerializer)
from .services import add_release, add_screenshot, record_revision


def visible_items(user):
    query = Q(status=Item.Status.PUBLISHED)
    if user.is_authenticated:
        query |= Q(author=user)
    return Item.objects.filter(query).select_related("author", "content_type").prefetch_related("releases", "screenshots")


class ContentTypeViewSet(viewsets.ReadOnlyModelViewSet):
    """Discover supported types and extensions, including future mod categories."""
    queryset = ContentType.objects.all()
    serializer_class = ContentTypeSerializer
    lookup_field = "slug"
    pagination_class = None


@extend_schema_view(
    list=extend_schema(parameters=[OpenApiParameter("q", str, description="Search titles, descriptions and tags"), OpenApiParameter("type", str, description="Content type slug"), OpenApiParameter("sort", str, enum=["newest", "popular", "updated"]), OpenApiParameter("mine", bool, description="Only your uploads")]),
    create=extend_schema(description="Create item metadata, then POST an immutable release and screenshots. Items start as drafts through the API; PATCH status to published after uploading a release.", responses={201: ItemSerializer, 400: ErrorSerializer, 403: ErrorSerializer}),
    partial_update=extend_schema(description="Author-only metadata edit. Records a revision; files and previous releases are immutable.", responses={200: ItemSerializer, 400: ErrorSerializer, 403: ErrorSerializer, 404: ErrorSerializer}),
)
class ItemViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                  mixins.UpdateModelMixin, viewsets.GenericViewSet):
    serializer_class = ItemSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Item.objects.none()
        qs = visible_items(self.request.user)
        if self.action == "list":
            params = self.request.query_params
            if params.get("q"):
                qs = qs.filter(Q(title__icontains=params["q"]) | Q(description__icontains=params["q"]) | Q(tags__icontains=params["q"]))
            if params.get("type"):
                qs = qs.filter(content_type__slug=params["type"])
            if params.get("mine") == "true":
                qs = qs.filter(author=self.request.user) if self.request.user.is_authenticated else qs.none()
            qs = qs.order_by({"newest": "-created_at", "popular": "-downloads"}.get(params.get("sort"), "-updated_at"), "id")
        return qs

    @transaction.atomic
    def perform_create(self, serializer):
        item = serializer.save(author=self.request.user, status=Item.Status.DRAFT)
        record_revision(item, self.request.user)

    @transaction.atomic
    def perform_update(self, serializer):
        Item.objects.select_for_update().get(pk=serializer.instance.pk)
        if serializer.validated_data.get("status") == Item.Status.PUBLISHED and not serializer.instance.releases.exists():
            raise ValidationError({"status": "Upload a release before publishing."})
        item = serializer.save()
        record_revision(item, self.request.user)

    @extend_schema(request=ReleaseUploadSerializer, responses={201: ReleaseSerializer, 400: ErrorSerializer, 403: ErrorSerializer}, description="Author-only upload. Version strings are unique per item. Existing releases cannot be overwritten.")
    @action(detail=True, methods=["post"], url_path="releases", parser_classes=[MultiPartParser, FormParser])
    def release_upload(self, request, pk=None):
        item = self.get_object()
        serializer = ReleaseUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            release = add_release(item, **serializer.validated_data)
        except DjangoValidationError as exc:
            raise ValidationError({"file": exc.messages})
        return Response(ReleaseSerializer(release, context={"request": request}).data, status=201)

    @extend_schema(responses={(200, "application/octet-stream"): OpenApiTypes.BINARY, 404: ErrorSerializer}, description="Download the exact immutable release. SHA-256 and size are in release metadata. Downloads are counted per request, not unique users.", parameters=[OpenApiParameter("release_id", OpenApiTypes.UUID, OpenApiParameter.PATH)])
    @action(detail=True, methods=["get"], url_path=r"releases/(?P<release_id>[0-9a-f-]+)/download")
    def download(self, request, pk=None, release_id=None):
        item = self.get_object()
        release = get_object_or_404(item.releases, pk=release_id)
        try:
            handle = release.file.open("rb")
        except FileNotFoundError:
            from rest_framework.exceptions import NotFound
            raise NotFound("This release file is unavailable.")
        Item.objects.filter(pk=item.pk).update(downloads=F("downloads") + 1)
        Release.objects.filter(pk=release.pk).update(downloads=F("downloads") + 1)
        response = FileResponse(handle, as_attachment=True, filename=release.original_filename, content_type="application/octet-stream")
        response["X-Content-SHA256"] = release.sha256
        response["Cache-Control"] = "private, no-store"
        return response

    @extend_schema(request=ScreenshotUploadSerializer, responses={201: ScreenshotSerializer, 400: ErrorSerializer, 403: ErrorSerializer})
    @action(detail=True, methods=["post"], url_path="screenshots", parser_classes=[MultiPartParser, FormParser])
    def screenshot_upload(self, request, pk=None):
        item = self.get_object()
        serializer = ScreenshotUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            screenshot = add_screenshot(item, **serializer.validated_data)
        except DjangoValidationError as exc:
            raise ValidationError({"image": exc.messages})
        return Response(ScreenshotSerializer(screenshot, context={"request": request}).data, status=201)

    @extend_schema(responses={(200, "image/webp"): OpenApiTypes.BINARY, 404: ErrorSerializer}, parameters=[OpenApiParameter("screenshot_id", OpenApiTypes.UUID, OpenApiParameter.PATH)])
    @action(detail=True, methods=["get"], url_path=r"screenshots/(?P<screenshot_id>[0-9a-f-]+)/image")
    def screenshot_image(self, request, pk=None, screenshot_id=None):
        screenshot = get_object_or_404(self.get_object().screenshots, pk=screenshot_id)
        try:
            handle = screenshot.image.open("rb")
        except FileNotFoundError:
            from rest_framework.exceptions import NotFound
            raise NotFound("This screenshot is unavailable.")
        response = FileResponse(handle, content_type="image/webp")
        response["Cache-Control"] = "private, no-store"
        return response

    @extend_schema(responses={204: None, 403: ErrorSerializer, 404: ErrorSerializer}, parameters=[OpenApiParameter("screenshot_id", OpenApiTypes.UUID, OpenApiParameter.PATH)])
    @action(detail=True, methods=["delete"], url_path=r"screenshots/(?P<screenshot_id>[0-9a-f-]+)")
    def screenshot_delete(self, request, pk=None, screenshot_id=None):
        screenshot = get_object_or_404(self.get_object().screenshots, pk=screenshot_id)
        storage, filename = screenshot.image.storage, screenshot.image.name
        screenshot.delete()
        transaction.on_commit(lambda: storage.delete(filename))
        return Response(status=204)

    @extend_schema(responses=RevisionSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="history", pagination_class=None)
    def history(self, request, pk=None):
        item = self.get_object()
        if item.author_id != request.user.pk:
            raise PermissionDenied("Only the author can view metadata history.")
        return Response(RevisionSerializer(item.revisions.all()[:100], many=True).data)


class KeyViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    permission_classes = [KeyPermission]
    serializer_class = KeySerializer
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False) or not self.request.user.is_authenticated:
            return APIKey.objects.none()
        qs = APIKey.objects.filter(user=self.request.user)
        if self.request.auth is not None:
            qs = qs.filter(application=self.request.auth.application)
        return qs

    @extend_schema(request=KeyCreateSerializer, responses={201: IssuedKeySerializer, 400: ErrorSerializer, 403: ErrorSerializer}, description="Session or OAuth keys:write scope required. OAuth clients may mint only read/write scopes they hold, and manage only their own keys. API keys cannot mint more keys. The secret is returned once; expires within 90 days.")
    @transaction.atomic
    def create(self, request, *args, **kwargs):
        from django.contrib.auth import get_user_model
        get_user_model().objects.select_for_update().get(pk=request.user.pk)
        serializer = KeyCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        scopes = token_scopes(request)
        if scopes is not None and not set(serializer.validated_data["scopes"]).issubset(scopes):
            raise PermissionDenied("Requested key scopes exceed the permissions you approved for this manager.")
        if APIKey.objects.filter(user=request.user, revoked_at=None, expires_at__gt=timezone.now()).count() >= 20:
            raise ValidationError("Revoke an existing key before creating another (20 active keys maximum).")
        key, raw = APIKey.issue(user=request.user, application=getattr(request.auth, "application", None), **serializer.validated_data)
        data = KeySerializer(key).data
        data["key"] = raw
        return Response(data, status=201, headers={"Cache-Control": "no-store"})

    @extend_schema(responses={204: None, 403: ErrorSerializer, 404: ErrorSerializer}, description="Revoke a key immediately. The audit record is retained.")
    def destroy(self, request, *args, **kwargs):
        key = self.get_object()
        key.revoked_at = timezone.now()
        key.save(update_fields=["revoked_at"])
        return Response(status=204)


class ProfileView(APIView):
    permission_classes = [IsAuthenticated, CatalogPermission]

    @extend_schema(responses={200: ProfileSerializer, 401: ErrorSerializer, 403: ErrorSerializer}, description="Minimal profile for the signed-in mod manager; no email or provider secrets.")
    def get(self, request):
        return Response({"id": request.user.pk, "username": request.user.username})
