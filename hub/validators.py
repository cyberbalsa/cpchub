import io
import json
import re
import stat
import warnings
import zipfile
from pathlib import PurePosixPath

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from PIL import Image, ImageOps


def validate_version(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,39}", value):
        raise ValidationError("Use up to 40 letters, numbers, dots, dashes, + or underscores.")


def validate_package(upload, content_type):
    from .upload_settings import max_game_file_bytes
    suffix = PurePosixPath(upload.name).suffix.lower()
    if suffix not in content_type.allowed_extensions:
        raise ValidationError("Supported files for this type: " + ", ".join(content_type.allowed_extensions))
    limit = max_game_file_bytes()
    if upload.size == 0 or upload.size > limit:
        raise ValidationError(f"Upload a non-empty file up to {limit // 1024 // 1024} MB.")
    try:
        if suffix == ".json":
            if upload.size > 10 * 1024 * 1024:
                raise ValidationError("JSON files are limited to 10 MB; ZIP larger files.")
            json.load(upload)
        elif suffix == ".zip":
            with zipfile.ZipFile(upload) as archive:
                entries = archive.infolist()
                if not entries or len(entries) > 2000:
                    raise ValidationError("ZIP must contain 1–2,000 entries.")
                if sum(x.file_size for x in entries) > 500 * 1024 * 1024:
                    raise ValidationError("ZIP expands beyond 500 MB.")
                for entry in entries:
                    path = PurePosixPath(entry.filename.replace("\\", "/"))
                    if path.is_absolute() or ".." in path.parts or ":" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                        raise ValidationError("ZIP contains an unsafe path or symbolic link.")
                    if entry.flag_bits & 1 or entry.file_size > max(entry.compress_size, 1) * 200:
                        raise ValidationError("Encrypted or excessively compressed ZIP files are unsupported.")
        # Native .cpbp/.cpcs and future formats remain opaque; do not execute or decompress them.
    except (ValueError, UnicodeDecodeError, zipfile.BadZipFile, RecursionError, NotImplementedError) as exc:
        raise ValidationError("The file is not valid JSON or ZIP data.") from exc
    finally:
        upload.seek(0)


def clean_screenshot(upload):
    if not upload.size or upload.size > 10 * 1024 * 1024:
        raise ValidationError("Screenshots must be under 10 MB.")
    if settings.ASYNC_UPLOAD_VALIDATION:
        return upload  # Decode and re-encode only inside the validation microVM.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(upload) as source:
                if source.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValidationError("Upload a PNG, JPEG or WebP screenshot.")
                if source.width * source.height > 20_000_000:
                    raise ValidationError("Screenshots must be at most 20 megapixels.")
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((1920, 1080))
                output = io.BytesIO()
                image.save(output, "WEBP", quality=88)
                return ContentFile(output.getvalue(), name="screenshot.webp")
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValidationError("This image could not be read safely.") from exc
