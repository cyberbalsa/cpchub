import hashlib
import io
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from botocore.exceptions import ClientError
from botocore.stub import Stubber
from django.contrib.auth import get_user_model
from django.core.files.storage import storages
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from hub.models import APIKey, ContentType, Item, Release, Screenshot


WASABI_OPTIONS = {
    "access_key": "test-access-key", "secret_key": "test-secret-key",
    "bucket_name": "test-cpchub", "region_name": "us-east-1",
    "endpoint_url": "https://s3.us-east-1.wasabisys.com", "querystring_expire": 300,
}
TEST_STORAGES = {
    "default": {"BACKEND": "hub.storage.WasabiMediaStorage", "OPTIONS": WASABI_OPTIONS},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}


@override_settings(ASYNC_UPLOAD_VALIDATION=False, DEBUG=True, SECURE_SSL_REDIRECT=False, STORAGES=TEST_STORAGES)
class WasabiDeliveryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = get_user_model().objects.create_user("storage-author")
        cls.other = get_user_model().objects.create_user("storage-other")
        cls.item = Item.objects.create(author=cls.author, content_type=ContentType.objects.get(slug="blueprints"),
                                       title="Storage test", summary="Storage test", description="Storage test")
        cls.release = Release.objects.create(item=cls.item, version="1", file="releases/item/test.cpbp",
            original_filename="Parking plan é.cpbp", size=4, sha256=hashlib.sha256(b"test").hexdigest())
        cls.shot = Screenshot.objects.create(item=cls.item, image="screenshots/item/test.webp")
        Screenshot.objects.create(item=cls.item, image="screenshots/item/second.webp")

    def setUp(self):
        self.api = APIClient()
        self.storage = storages["default"]
        self.download = f"/api/v1/items/{self.item.pk}/releases/{self.release.pk}/download/"
        self.image = f"/api/v1/items/{self.item.pk}/screenshots/{self.shot.pk}/image/"

    def head_params(self, name):
        return {"Bucket": "test-cpchub", "Key": "ugc/" + name}

    def test_release_redirect_is_signed_private_and_preserves_filename(self):
        # Only HEAD is stubbed: opening/streaming the remote file would fail this test.
        with Stubber(self.storage.connection.meta.client) as stub:
            stub.add_response("head_object", {"ContentLength": 4}, self.head_params(self.release.file.name))
            result = self.api.get(self.download)
        self.assertEqual(result.status_code, 302)
        target = urlsplit(result["Location"])
        params = parse_qs(target.query)
        self.assertEqual(target.scheme, "https")
        self.assertEqual(target.netloc, "s3.us-east-1.wasabisys.com")
        self.assertEqual(target.path, "/test-cpchub/ugc/releases/item/test.cpbp")
        self.assertEqual(params["X-Amz-Algorithm"], ["AWS4-HMAC-SHA256"])
        self.assertEqual(params["X-Amz-Expires"], ["300"])
        self.assertIn("X-Amz-Signature", params)
        self.assertIn("filename*=utf-8''Parking%20plan%20%C3%A9.cpbp", params["response-content-disposition"][0])
        self.assertEqual(params["response-content-type"], ["application/octet-stream"])
        self.assertEqual(params["response-cache-control"], ["private, no-store"])
        self.assertEqual(result["Cache-Control"], "private, no-store")
        self.assertEqual(result["Referrer-Policy"], "no-referrer")
        self.assertEqual(result["X-Content-SHA256"], self.release.sha256)
        self.item.refresh_from_db()
        self.release.refresh_from_db()
        self.assertEqual(self.item.downloads, 1)
        self.assertEqual(self.release.downloads, 1)

    def test_screenshots_redirect_inline_and_static_assets_stay_local(self):
        with Stubber(self.storage.connection.meta.client) as stub:
            stub.add_response("head_object", {"ContentLength": 20}, self.head_params(self.shot.image.name))
            response = self.api.get(self.image)
        self.assertEqual(response.status_code, 302)
        params = parse_qs(urlsplit(response["Location"]).query)
        self.assertEqual(params["response-content-type"], ["image/webp"])
        self.assertEqual(params["response-content-disposition"], ["inline"])
        self.assertTrue(storages["staticfiles"].url("css/hub.css").startswith("/static/"))
        for prefix, mime, disposition in [("screenshots", "image/webp", "inline"), ("releases", "application/octet-stream", "attachment")]:
            metadata = self.storage.get_object_parameters(f"ugc/{prefix}/file")
            self.assertEqual(metadata, {"CacheControl": "private, no-store", "ContentType": mime, "ContentDisposition": disposition})

    def test_head_uses_head_signature_without_counting_a_download(self):
        with Stubber(self.storage.connection.meta.client) as stub, patch.object(self.storage, "signed_download_url", wraps=self.storage.signed_download_url) as sign:
            stub.add_response("head_object", {"ContentLength": 4}, self.head_params(self.release.file.name))
            response = self.api.head(self.download)
            self.assertEqual(sign.call_args.kwargs["method"], "HEAD")
        self.assertEqual(response.status_code, 302)
        self.item.refresh_from_db()
        self.release.refresh_from_db()
        self.assertEqual(self.item.downloads, 0)
        self.assertEqual(self.release.downloads, 0)

    def test_drafts_and_read_scopes_are_checked_before_contacting_storage(self):
        self.item.status = "draft"
        self.item.save()
        with Stubber(self.storage.connection.meta.client):
            for user in [None, self.other]:
                if user:
                    self.api.force_login(user)
                for url in [self.download, self.image]:
                    response = self.api.get(url)
                    self.assertEqual(response.status_code, 404)
                    self.assertNotIn("Location", response)
        self.api.force_login(self.author)
        with Stubber(self.storage.connection.meta.client) as stub:
            stub.add_response("head_object", {"ContentLength": 4}, self.head_params(self.release.file.name))
            self.assertEqual(self.api.get(self.download).status_code, 302)
        self.api.logout()
        _, key = APIKey.issue(user=self.author, name="Write only", scopes=["write"])
        self.api.credentials(HTTP_AUTHORIZATION="ApiKey " + key)
        with Stubber(self.storage.connection.meta.client):
            self.assertEqual(self.api.get(self.download).status_code, 403)
            self.assertEqual(self.api.get(self.image).status_code, 403)

    def test_missing_object_and_provider_failure_do_not_issue_links_or_count(self):
        for provider_code, http_status, expected in [("404", 404, 404), ("AccessDenied", 403, 503)]:
            with Stubber(self.storage.connection.meta.client) as stub:
                stub.add_client_error("head_object", service_error_code=provider_code, http_status_code=http_status,
                    service_message="Provider diagnostic that must stay private", expected_params=self.head_params(self.release.file.name))
                response = self.api.get(self.download)
            self.assertEqual(response.status_code, expected)
            self.assertNotIn("Location", response)
            self.assertNotIn(b"Provider diagnostic", response.content)
        self.release.refresh_from_db()
        self.assertEqual(self.release.downloads, 0)

    def test_upload_failure_returns_safe_error_and_rolls_back(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.api.force_login(self.author)
        failure = ClientError({"Error": {"Code": "AccessDenied", "Message": "Private diagnostic"}}, "PutObject")
        with patch.object(self.storage, "save", side_effect=failure):
            response = self.api.post(f"/api/v1/items/{self.item.pk}/releases/", {
                "version": "2", "file": SimpleUploadedFile("file.cpbp", b"native blueprint"),
            }, format="multipart")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(b"Private diagnostic", response.content)
        self.assertFalse(self.item.releases.filter(version="2").exists())


@override_settings(ASYNC_UPLOAD_VALIDATION=False, DEBUG=True, SECURE_SSL_REDIRECT=False)
class UploadMigrationTests(TestCase):
    def test_dry_run_copy_restart_and_conflicting_remote_file(self):
        user = get_user_model().objects.create_user("migrating-author")
        item = Item.objects.create(author=user, content_type=ContentType.objects.get(slug="blueprints"), title="Migrate", summary="Migrate", description="Migrate")
        data = b"original bytes"
        Release.objects.create(item=item, version="1", file="releases/test.cpbp", original_filename="test.cpbp", size=len(data), sha256=hashlib.sha256(data).hexdigest())
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as remote:
            source = Path(local) / "releases/test.cpbp"
            source.parent.mkdir()
            source.write_bytes(data)
            destination = Path(remote) / "releases/test.cpbp"
            with override_settings(STORAGES={"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
                "wasabi": {"BACKEND": "django.core.files.storage.FileSystemStorage", "OPTIONS": {"location": remote}}}):
                call_command("migrate_uploads_to_wasabi", source=local, stdout=io.StringIO())
                self.assertFalse(destination.exists())
                call_command("migrate_uploads_to_wasabi", source=local, apply=True, stdout=io.StringIO())
                self.assertEqual(destination.read_bytes(), data)
                self.assertEqual(source.read_bytes(), data)
                call_command("migrate_uploads_to_wasabi", source=local, apply=True, stdout=io.StringIO())
                self.assertEqual(len(list(Path(remote).rglob("*.cpbp"))), 1)
                destination.write_bytes(b"different remote content")
                with self.assertRaises(CommandError):
                    call_command("migrate_uploads_to_wasabi", source=local, apply=True, stdout=io.StringIO())
                self.assertEqual(destination.read_bytes(), b"different remote content")
