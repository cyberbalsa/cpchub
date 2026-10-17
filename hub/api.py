from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
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

from .models import APIKey, AccountActivity, ContentType, Item, Release, UploadJob
from .activity import record_activity
from .permissions import CatalogPermission, KeyPermission, token_scopes
from .serializers import (ContentTypeSerializer, ErrorSerializer, FileStatsFilterSerializer, IssuedKeySerializer, ItemSerializer,
                          KeyCreateSerializer, KeySerializer, ProfileSerializer, ReleaseSerializer,
                          ReleaseUploadSerializer, RevisionSerializer, ScreenshotSerializer, ScreenshotUploadSerializer, TagSerializer, TagSuggestionSerializer, UploadJobSerializer)
from .services import add_release, add_screenshot, record_revision, remove_screenshot, validate_publication
from .file_delivery import file_response
from .download_counts import count_download
from .access import accessible_items, can_edit_item, can_moderate, item_query, visible_items
from .tags import filter_tags, normalize_tag, public_tags, suggested_tags
from .file_stats import FileStatsFilterForm, filter_file_stats


@extend_schema_view(list=extend_schema(description="Public tags with counts of visible, published creations. Tags need 11 creations by default; Admins can change this threshold. Drafts, hidden, deleted, shadow-banned and demo creations do not count.", parameters=[OpenApiParameter("q", str, description="Find tag names containing this text.")]))
class TagViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = TagSerializer

    def get_queryset(self):
        tags = public_tags().order_by("-item_count", "name")
        return tags.filter(name__icontains=normalize_tag(self.request.query_params.get("q", "")[:200]))

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    @extend_schema(description="Existing tag suggestions for signed-in editors, including uncommon tags on public creations and tags on their own private creations. Other users' private tags are excluded. Returns up to 20 names; accepts the q substring filter.", parameters=[OpenApiParameter("q", str)], responses={200: TagSuggestionSerializer(many=True)})
    @action(detail=False, methods=["get"], permission_classes=[IsAuthenticated, CatalogPermission], pagination_class=None)
    def suggest(self, request):
        tags = suggested_tags(request.user).filter(name__icontains=normalize_tag(request.query_params.get("q", "")[:200]))[:20]
        return Response(TagSuggestionSerializer(tags, many=True).data)


class ContentTypeViewSet(viewsets.ReadOnlyModelViewSet):
    """Discover enabled upload types and their accepted extensions."""
    queryset = ContentType.objects.filter(uploads_enabled=True)
    serializer_class = ContentTypeSerializer
    lookup_field = "slug"
    pagination_class = None


@extend_schema_view(
    retrieve=extend_schema(description="Read a visible creation. Hidden creations return 403 with the public moderation reason. Shadow-banned and self-deleted creations return 404 to other users; their creator and staff browser sessions retain access. Drafts remain private to the creator and staff.", responses={200: ItemSerializer, 403: ErrorSerializer, 404: ErrorSerializer}),
    list=extend_schema(parameters=[FileStatsFilterSerializer, OpenApiParameter("q", str, description="Search titles, descriptions and public tags (all own tags with mine=true)"), OpenApiParameter("tag", str, description="Exact tag name, ignoring case and extra whitespace. Public tags only, unless mine=true."), OpenApiParameter("type", str, description="Content type slug"), OpenApiParameter("sort", str, enum=["newest", "popular", "updated"]), OpenApiParameter("mine", bool, description="Only your uploads")]),
    create=extend_schema(description="Create metadata for a blueprint or scenario. Pack and mod uploads are disabled. API items start as drafts; upload a raw .cpbp or .cpcs release and at least one screenshot, then PATCH status to published. Each item can have up to eight screenshots.", responses={201: ItemSerializer, 400: ErrorSerializer, 403: ErrorSerializer}),
    partial_update=extend_schema(description="Authors can edit their own metadata. Admin and Moderator browser sessions may edit any creation; API keys and OAuth tokens remain limited to their owner. Publishing requires an enabled file type, a validated release and at least one validated screenshot. Setting status to published while file checks are pending records the intent; the response remains draft until all checks pass. Records a revision; files and previous releases are immutable.", responses={200: ItemSerializer, 400: ErrorSerializer, 403: ErrorSerializer, 404: ErrorSerializer}),
)
class ItemViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                  mixins.UpdateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = ItemSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Item.objects.none()
        qs = accessible_items(self.request.user, staff_access=self.request.auth is None)
        if self.action == "list":
            qs = visible_items(self.request.user)
            params = self.request.query_params
            if params.get("mine") == "true":
                qs = item_query().filter(author=self.request.user) if self.request.user.is_authenticated else qs.none()
            qs = filter_tags(qs, query=params.get("q", "").strip()[:200], tag=params.get("tag", "")[:200], private=params.get("mine") == "true")
            stats_form = FileStatsFilterForm(params)
            if not stats_form.is_valid():
                raise ValidationError(stats_form.errors)
            qs = filter_file_stats(qs, stats_form)
            if params.get("type"):
                qs = qs.filter(content_type__slug=params["type"])
            qs = qs.order_by({"newest": "-created_at", "popular": "-downloads"}.get(params.get("sort"), "-updated_at"), "id")
        return qs

    def get_object(self):
        item = super().get_object()
        staff = self.request.auth is None and can_moderate(self.request.user)
        owner_image = self.action == "screenshot_image" and item.author_id == self.request.user.pk
        if item.is_hidden and self.action in {"retrieve", "download", "screenshot_image"} and not (staff or owner_image):
            raise PermissionDenied({"detail": "This creation is hidden.", "reason": item.hidden_reason})
        return item

    @extend_schema(responses={204: None, 403: ErrorSerializer, 404: ErrorSerializer}, description="Author-only soft deletion. Immediately private to the creator and staff; recoverable for 14 days with POST restore/. After 14 days the creation and stored files are permanently removed.")
    def destroy(self, request, *args, **kwargs):
        from .moderation_services import self_delete_item
        item = self.get_object()
        if item.author_id != request.user.pk:
            raise PermissionDenied("Only the author can self-delete this creation.")
        self_delete_item(request.user, item)
        return Response(status=204)

    @extend_schema(request=None, responses={200: ItemSerializer, 400: ErrorSerializer, 403: ErrorSerializer, 404: ErrorSerializer}, description="Restore your own self-deleted creation within 14 days. Existing draft status and moderation restrictions remain in effect.")
    @action(detail=True, methods=["post"], url_path="restore")
    def restore(self, request, pk=None):
        from .moderation_services import restore_self_deleted_item
        item = self.get_object()
        if item.author_id != request.user.pk:
            raise PermissionDenied("Only the author can restore their own self-deleted creation through the API.")
        try:
            item = restore_self_deleted_item(request.user, item)
        except DjangoValidationError as exc:
            raise ValidationError(exc.messages)
        return Response(ItemSerializer(item, context={"request": request}).data)

    @transaction.atomic
    def perform_create(self, serializer):
        item = serializer.save(author=self.request.user, status=Item.Status.DRAFT)
        record_revision(item, self.request.user)
        record_activity(self.request, AccountActivity.Action.CREATE, item=item)

    @transaction.atomic
    def perform_update(self, serializer):
        item = Item.objects.select_for_update(of=("self",)).select_related("content_type").get(pk=serializer.instance.pk)
        previous_status = item.status
        for field, value in serializer.validated_data.items():
            setattr(item, field, value)
        if "content_type" in serializer.validated_data and item.upload_jobs.filter(status="pending").exists():
            raise ValidationError({"content_type": "Wait for the current file checks before changing the type."})
        if "status" in serializer.validated_data:
            item.publish_after_validation = False
            if item.status == Item.Status.PUBLISHED and item.upload_jobs.filter(status="pending").exists():
                item.status = Item.Status.DRAFT
                item.publish_after_validation = True
                serializer.validated_data["status"] = Item.Status.DRAFT
        if item.status == Item.Status.PUBLISHED and {"status", "content_type"}.intersection(serializer.validated_data):
            try:
                validate_publication(item)
            except DjangoValidationError as exc:
                raise ValidationError({"status": exc.messages})
        serializer.instance = item
        item = serializer.save(publish_after_validation=item.publish_after_validation)
        record_revision(item, self.request.user)
        if previous_status != Item.Status.PUBLISHED and item.status == Item.Status.PUBLISHED:
            record_activity(self.request, AccountActivity.Action.PUBLISH, item=item)

    @extend_schema(request=ReleaseUploadSerializer, responses={202: UploadJobSerializer, 400: ErrorSerializer, 403: ErrorSerializer, 429: ErrorSerializer, 503: ErrorSerializer}, parameters=[OpenApiParameter("Retry-After", OpenApiTypes.INT, OpenApiParameter.HEADER, response=[429], description="Seconds until an upload slot becomes available.")], description="Upload to an owned creation, or use an Admin or Moderator browser session to add a release to any creation. The file type must be enabled. Published items must have at least one screenshot before adding a release. Version strings are unique per item. Existing releases cannot be overwritten. Returns 202 with a validation job. The creation stays draft until isolated checks finish. Poll upload-jobs/ for the result. Submitted creation files and new releases share a rolling limit of 16 uploads per hour per account across sessions, API keys and OAuth tokens. Admins, Moderators and Reviewers are exempt; screenshots do not use slots. A 429 response includes Retry-After in seconds.")
    @action(detail=True, methods=["post"], url_path="releases", parser_classes=[MultiPartParser, FormParser])
    def release_upload(self, request, pk=None):
        item = self.get_object()
        serializer = ReleaseUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            release = add_release(item, **serializer.validated_data, request=request)
        except DjangoValidationError as exc:
            raise ValidationError({"file": exc.messages})
        if isinstance(release, UploadJob):
            return Response(UploadJobSerializer(release).data, status=202)
        return Response(ReleaseSerializer(release, context={"request": request}).data, status=201)

    @extend_schema(
        responses={(200, "application/octet-stream"): OpenApiTypes.BINARY, 302: None, 403: ErrorSerializer, 404: ErrorSerializer, 503: ErrorSerializer},
        description="Checks item visibility, then redirects to a short-lived signed Wasabi URL (302), or streams a local development file (200). Follow redirects without forwarding CPC Hub credentials to the storage host. Successful GETs count link issuance, not completed transfers. Creation and release counters each deduplicate by account and IP: a match on either prevents another count. Account markers persist; IP markers expire 14 days after their last download. IPv4 uses the individual address; IPv6 uses the /32 subnet. HEAD does not count. Signed URLs default to 300 seconds. SHA-256 and size are in release metadata.",
        parameters=[OpenApiParameter("release_id", OpenApiTypes.UUID, OpenApiParameter.PATH),
                    OpenApiParameter("Location", str, OpenApiParameter.HEADER, response=[302], description="Expiring signed URL. Request this endpoint again for a fresh URL."),
                    OpenApiParameter("X-Content-SHA256", str, OpenApiParameter.HEADER, response=[200, 302], description="SHA-256 of the release file.")],
    )
    @action(detail=True, methods=["get"], url_path=r"releases/(?P<release_id>[0-9a-f-]+)/download")
    def download(self, request, pk=None, release_id=None):
        item = self.get_object()
        release = get_object_or_404(item.releases, pk=release_id)
        response = file_response(release.file, method=request.method, filename=release.original_filename)
        if request.method == "GET":
            count_download(request, release)
        response["X-Content-SHA256"] = release.sha256
        return response

    @extend_schema(request=ScreenshotUploadSerializer, responses={202: UploadJobSerializer, 400: ErrorSerializer, 403: ErrorSerializer, 503: ErrorSerializer})
    @action(detail=True, methods=["post"], url_path="screenshots", parser_classes=[MultiPartParser, FormParser])
    def screenshot_upload(self, request, pk=None):
        item = self.get_object()
        serializer = ScreenshotUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            screenshot = add_screenshot(item, **serializer.validated_data, request=request)
        except DjangoValidationError as exc:
            raise ValidationError({"image": exc.messages})
        if isinstance(screenshot, UploadJob):
            return Response(UploadJobSerializer(screenshot).data, status=202)
        return Response(ScreenshotSerializer(screenshot, context={"request": request}).data, status=201)

    @extend_schema(description="File-check status for the author or a staff browser session. Upload endpoints return 202 with a job ID. Files remain private and the creation stays draft until checks finish. A passed job supplies its release or screenshot ID; a failed job supplies a safe error message.", responses=UploadJobSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="upload-jobs", pagination_class=None)
    def upload_jobs(self, request, pk=None):
        item = self.get_object()
        if item.author_id != request.user.pk and not (request.auth is None and can_moderate(request.user)):
            raise PermissionDenied("Only the author and staff can view file checks.")
        return Response(UploadJobSerializer(item.upload_jobs.all()[:50], many=True).data)

    @extend_schema(
        responses={(200, "image/webp"): OpenApiTypes.BINARY, 302: None, 403: ErrorSerializer, 404: ErrorSerializer, 503: ErrorSerializer},
        description="Checks item visibility before redirecting to a short-lived signed screenshot URL. Local development can return image bytes directly. Keep this application URL for future requests; signed URLs expire.",
        parameters=[OpenApiParameter("screenshot_id", OpenApiTypes.UUID, OpenApiParameter.PATH),
                    OpenApiParameter("Location", str, OpenApiParameter.HEADER, response=[302], description="Expiring signed WebP image URL.")],
    )
    @action(detail=True, methods=["get"], url_path=r"screenshots/(?P<screenshot_id>[0-9a-f-]+)/image")
    def screenshot_image(self, request, pk=None, screenshot_id=None):
        screenshot = get_object_or_404(self.get_object().screenshots, pk=screenshot_id)
        return file_response(screenshot.image, method=request.method, content_type="image/webp")

    @extend_schema(responses={204: None, 400: ErrorSerializer, 403: ErrorSerializer, 404: ErrorSerializer}, description="Remove an owned screenshot, or use an Admin browser session to remove any screenshot. Published creations must keep at least one screenshot; add a replacement or save as a draft first.", parameters=[OpenApiParameter("screenshot_id", OpenApiTypes.UUID, OpenApiParameter.PATH)])
    @action(detail=True, methods=["delete"], url_path=r"screenshots/(?P<screenshot_id>[0-9a-f-]+)")
    def screenshot_delete(self, request, pk=None, screenshot_id=None):
        screenshot = get_object_or_404(self.get_object().screenshots, pk=screenshot_id)
        try:
            remove_screenshot(screenshot)
        except DjangoValidationError as exc:
            raise ValidationError({"image": exc.messages})
        return Response(status=204)

    @extend_schema(responses=RevisionSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="history", pagination_class=None)
    def history(self, request, pk=None):
        item = self.get_object()
        if item.author_id != request.user.pk and not (request.auth is None and can_edit_item(request.user, item)):
            raise PermissionDenied("Only the author, an Admin, or a Moderator can view metadata history.")
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

    @extend_schema(request=KeyCreateSerializer, responses={201: IssuedKeySerializer, 400: ErrorSerializer, 403: ErrorSerializer}, description="Session or OAuth keys:write scope required. OAuth clients may mint only read/write scopes they hold, and manage only their own keys. API keys cannot mint more keys. The secret is returned once. Keys do not expire by default; omit days or send null. Set days to 1–90 for an expiring key. All keys can be revoked.")
    @transaction.atomic
    def create(self, request, *args, **kwargs):
        from django.contrib.auth import get_user_model
        get_user_model().objects.select_for_update().get(pk=request.user.pk)
        serializer = KeyCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        scopes = token_scopes(request)
        if scopes is not None and not set(serializer.validated_data["scopes"]).issubset(scopes):
            raise PermissionDenied("Requested key scopes exceed the permissions you approved for this manager.")
        if APIKey.objects.active().filter(user=request.user).count() >= 20:
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
