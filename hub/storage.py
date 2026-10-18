"""Private S3-compatible storage for uploaded releases and screenshots."""
from botocore.config import Config
from django.utils.http import content_disposition_header
from storages.backends.s3 import S3Storage


class PrivateS3MediaStorage(S3Storage):
    def __init__(self, **kwargs):
        # These constraints are part of the storage contract, not operator options.
        kwargs.update(
            location="ugc", default_acl=None, custom_domain=None, querystring_auth=True,
            file_overwrite=False, gzip=False, max_memory_size=2 * 1024 * 1024,
            client_config=Config(
                signature_version="s3v4", s3={"addressing_style": "path"},
                connect_timeout=5, read_timeout=30, retries={"mode": "standard", "max_attempts": 2},
                request_checksum_calculation="when_required", response_checksum_validation="when_required",
            ),
        )
        super().__init__(**kwargs)

    def get_object_parameters(self, name):
        screenshot = name.startswith("ugc/screenshots/")
        return {
            "CacheControl": "private, no-store",
            "ContentType": "image/webp" if screenshot else "application/octet-stream",
            "ContentDisposition": "inline" if screenshot else "attachment",
        }

    def signed_download_url(self, name, *, filename, content_type, method="GET"):
        return self.url(name, http_method=method, parameters={
            "ResponseContentDisposition": content_disposition_header(bool(filename), filename) or "inline",
            "ResponseContentType": content_type,
            "ResponseCacheControl": "private, no-store",
        })


class WasabiMediaStorage(PrivateS3MediaStorage):
    """Retained for existing Wasabi installs and migration sources."""


class R2MediaStorage(PrivateS3MediaStorage):
    def __init__(self, **kwargs):
        kwargs["region_name"] = "auto"
        super().__init__(**kwargs)
