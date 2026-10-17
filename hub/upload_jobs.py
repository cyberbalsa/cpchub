"""Submit opaque files to the separate validator and collect its bounded results."""
import hashlib
import os
import tempfile
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.files import File
from django.core.files.base import ContentFile
from django.db import connection, transaction
from django.utils import timezone
from sandbox.protocol import PACKET, decode_stats

from .activity import record_activity
from .models import AccountActivity, Item, Release, Screenshot, UploadJob
from .upload_limits import upload_slot
from .validators import clean_screenshot, validate_version

REQUEST_MAGIC = b'CPCVAL1\x00'
RESULT_MAGIC = b'CPCRES1\x00'
MAX_RESULT = 8 * 1024 * 1024


def incoming_path(job_id, suffix='input'):
    return Path(settings.UPLOAD_QUEUE_ROOT) / 'incoming' / f'{job_id.hex}.{suffix}'


def discard_job_files(job_id):
    # The validator owns results. An acknowledgement asks it to remove both sides.
    try:
        incoming_path(job_id, 'ack').touch(mode=0o640)
    except OSError:
        pass  # The worker also expires abandoned inputs/results after 24 hours.


def _admit(user, slots=1):
    get_user_model().objects.select_for_update(no_key=True).get(pk=user.pk)
    if connection.vendor == 'postgresql':
        # Serialize queue admission across accounts without holding a global table lock.
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(182819247)')
    if UploadJob.objects.filter(submitted_by=user, status='pending').count() + slots > 32 or UploadJob.objects.filter(status='pending').count() + slots > 64:
        raise ValidationError('The file-check queue is full. Try again after the current checks finish.')


def _native_kind(item, upload):
    expected = {'blueprints': ('.cpbp', 1), 'scenarios': ('.cpcs', 2)}.get(item.content_type.slug)
    if not item.content_type.uploads_enabled or expected is None:
        raise ValidationError('Uploads for this file type are disabled.')
    suffix = Path(upload.name).suffix.lower()
    if suffix != expected[0] or suffix not in item.content_type.allowed_extensions:
        raise ValidationError(f'Upload a raw {expected[0]} game file for this type. ZIP and JSON uploads are disabled.')
    from .upload_settings import max_game_file_bytes
    limit = max_game_file_bytes()
    if not 0 < upload.size <= limit:
        raise ValidationError(f'Upload a non-empty game file up to {limit // 1024 // 1024} MB.')
    return expected[1]


def _submit(item, user, upload, kind, metadata, *, existing_release=None):
    job = UploadJob(item=item, submitted_by=user, kind='stats' if existing_release else 'screenshot' if kind == 3 else 'release', release=existing_release,
                    original_filename=Path(upload.name).name[:255], size=upload.size, metadata=metadata)
    temporary, target = incoming_path(job.pk, 'tmp'), incoming_path(job.pk)
    digest, written = hashlib.sha256(), 0
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(fd, 'wb') as output:
            output.write(REQUEST_MAGIC + bytes([kind]) + upload.size.to_bytes(8, 'big'))
            for chunk in upload.chunks():
                written += len(chunk)
                if written > upload.size:
                    raise ValidationError('The uploaded file changed size. Try again.')
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if written != upload.size:
            raise ValidationError('The upload was incomplete. Try again.')
        job.sha256 = digest.hexdigest()
        job.save()
        os.replace(temporary, target)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise ValidationError('File checks are temporarily unavailable. Try again shortly.') from exc
    finally:
        temporary.unlink(missing_ok=True)
        upload.seek(0)
    return job


def _hold_draft(item):
    item.publish_after_validation |= item.status == Item.Status.PUBLISHED
    item.status = Item.Status.DRAFT
    item.save(update_fields=['status', 'publish_after_validation'])


def _release_job(item, user, file, version, game_version='', changelog=''):
    kind = _native_kind(item, file)
    validate_version(version)
    if item.releases.filter(version=version).exists() or item.upload_jobs.filter(kind='release', status='pending', metadata__version=version).exists():
        raise ValidationError('This version already exists or is being checked. Use a new version.')
    return _submit(item, user, file, kind, {'version': version, 'game_version': game_version, 'changelog': changelog})


def queue_creation(item, *, release_data, screenshots, request=None):
    user = request.user if request else item.author
    _native_kind(item, release_data['file'])
    if not settings.MIN_SCREENSHOTS <= len(screenshots) <= settings.MAX_SCREENSHOTS:
        raise ValidationError(f'Choose {settings.MIN_SCREENSHOTS}–{settings.MAX_SCREENSHOTS} screenshots.')
    jobs = []
    try:
        with upload_slot(user):
            _admit(user, 1 + len(screenshots))
            item.publish_after_validation = item.status == Item.Status.PUBLISHED
            item.status = Item.Status.DRAFT
            item.save()
            jobs.append(_release_job(item, user, **release_data))
            for image in screenshots:
                jobs.append(_submit(item, user, clean_screenshot(image), 3, {'caption': ''}))
            from .services import record_revision
            record_revision(item, user)
            record_activity(request, AccountActivity.Action.CREATE, item=item)
    except Exception:
        for job in jobs:
            discard_job_files(job.pk)
        raise
    return item


def queue_release(item, *, file, version, game_version='', changelog='', request=None):
    user = request.user if request else item.author
    _native_kind(item, file)
    with upload_slot(user):
        _admit(user)
        item = Item.objects.select_for_update().select_related('content_type').get(pk=item.pk)
        if item.deleted_at:
            raise ValidationError('Restore this creation before adding files.')
        job = _release_job(item, user, file, version, game_version, changelog)
        _hold_draft(item)
        record_activity(request, AccountActivity.Action.RELEASE, item=item)
    return job


@transaction.atomic
def queue_screenshot(item, *, image, caption='', request=None):
    user = request.user if request else item.author
    _admit(user)
    item = Item.objects.select_for_update().get(pk=item.pk)
    if item.deleted_at:
        raise ValidationError('Restore this creation before adding files.')
    pending = item.upload_jobs.filter(kind='screenshot', status='pending').count()
    if item.screenshots.count() + pending >= settings.MAX_SCREENSHOTS:
        raise ValidationError('An item can have up to eight screenshots, including files being checked.')
    job = _submit(item, user, clean_screenshot(image), 3, {'caption': caption})
    _hold_draft(item)
    record_activity(request, AccountActivity.Action.SCREENSHOT, item=item)
    return job


@transaction.atomic
def queue_release_stats(release):
    """Recheck an existing file without changing publication, storage or quotas."""
    user = release.item.author
    _admit(user)
    item = Item.objects.select_for_update().get(pk=release.item_id)
    release = Release.objects.select_for_update().get(pk=release.pk, item=item)
    kind = {'.cpbp': 1, '.cpcs': 2}.get(Path(release.original_filename).suffix.lower())
    if item.deleted_at or item.is_demo or kind is None or not 0 < release.size <= 100 * 1024 * 1024:
        raise ValidationError('This file cannot be queued for statistics.')
    if UploadJob.objects.filter(release=release, kind='stats', status='pending').exists():
        return None
    with release.file.open('rb') as source:
        upload = File(source, name=release.original_filename)
        job = _submit(item, user, upload, kind, {}, existing_release=release)
    if job.sha256 != release.sha256 or job.size != release.size:
        discard_job_files(job.pk)
        raise ValidationError('The stored file does not match its checksum.')
    return job


def _read_result(job):
    path = Path(settings.UPLOAD_QUEUE_ROOT) / 'results' / f'{job.pk.hex}.result'
    try:
        with path.open('rb') as result:
            header = result.read(45)
            if len(header) != 45 or header[:8] != RESULT_MAGIC or header[8] not in (0, 1, 2):
                raise ValueError('Invalid validator response')
            size = int.from_bytes(header[9:13], 'big')
            if size > MAX_RESULT or header[13:45].hex() != job.sha256:
                raise ValueError('Mismatched validator response')
            payload = result.read(size + 1)
            if len(payload) != size or (job.kind != 'screenshot' and size not in (0, PACKET.size)) or (header[8] and size):
                raise ValueError('Invalid validator output')
            if header[8] == 0 and job.kind == 'screenshot' and (len(payload) < 12 or payload[:4] != b'RIFF' or payload[8:12] != b'WEBP'):
                raise ValueError('Missing sanitized screenshot')
            return header[8], payload
    except FileNotFoundError:
        return None


def collect_job(job_id):
    with transaction.atomic():
        # Match every other content operation's lock order: item, then job.
        candidate = UploadJob.objects.filter(pk=job_id, status='pending').first()
        if candidate is None:
            return False
        item = Item.objects.select_for_update().get(pk=candidate.item_id)
        job = UploadJob.objects.select_for_update().get(pk=job_id)
        if job.status != 'pending':
            return False
        try:
            result = _read_result(job)
        except (OSError, ValueError):
            result = (2, b'')
        if result is None and job.created_at > timezone.now() - timedelta(minutes=15):
            return False
        code, payload = result if result is not None else (2, b'')
        stats = {}
        if code == 0 and job.kind != 'screenshot' and payload:
            try:
                stats = decode_stats(payload, {'.cpbp': 1, '.cpcs': 2}.get(Path(job.original_filename).suffix.lower()))
            except ValueError:
                code = 2
        if item.deleted_at:
            code = 2
        if code == 0 and job.kind == 'release' and item.releases.filter(version=job.metadata.get('version')).exists():
            # A staff edit may have claimed the version since submission.
            # Reject before writing to storage, rather than retrying a DB conflict.
            code = 2
        if code == 0:
            from .reviews import queue_for_review
            if job.kind == 'stats':
                if not stats or not Release.objects.filter(pk=job.release_id, item=item, sha256=job.sha256, size=job.size).update(file_stats=stats):
                    code = 2
            elif job.kind == 'release':
                with tempfile.TemporaryFile() as temporary:
                    digest, written = hashlib.sha256(), 0
                    try:
                        with incoming_path(job.pk).open('rb') as source:
                            source.seek(17)
                            while chunk := source.read(1024 * 1024):
                                written += len(chunk)
                                if written > job.size:
                                    break
                                digest.update(chunk)
                                temporary.write(chunk)
                    except OSError:
                        code = 2
                    if code != 0 or written != job.size or digest.hexdigest() != job.sha256:
                        code = 2
                    else:
                        temporary.seek(0)
                        job.release = Release.objects.create(item=item, file=File(temporary, name=job.original_filename),
                            original_filename=job.original_filename, size=job.size, sha256=job.sha256, file_stats=stats, **job.metadata)
            else:
                job.screenshot = Screenshot.objects.create(item=item, image=ContentFile(payload, name='screenshot.webp'), caption=job.metadata.get('caption', ''))
            if code == 0 and job.kind != 'stats':
                queue_for_review(item)
                Item.objects.filter(pk=item.pk).update(updated_at=timezone.now())
        job.status = 'passed' if code == 0 else 'failed'
        job.error = '' if code == 0 else ('This file did not pass validation. Export it again from the game and retry.' if code == 1 and job.kind != 'screenshot' else 'This screenshot could not be read safely. Use a still PNG, JPEG or WebP: 320×180 minimum, 8,192 pixels per side maximum, up to 20 megapixels and 10 MB. Avoid extreme aspect ratios.' if code == 1 else 'The file check could not finish. Upload the file again to retry.')
        job.completed_at = timezone.now()
        job.save(update_fields=['status', 'error', 'completed_at', 'release', 'screenshot'])
        if job.kind == 'stats':
            pass  # Recomputing derived stats never changes the creation's publication state.
        elif code != 0:
            item.publish_after_validation = False
            item.save(update_fields=['publish_after_validation'])
        elif item.publish_after_validation and not item.upload_jobs.filter(status='pending').exists():
            from .services import record_revision, validate_publication
            try:
                validate_publication(item)
            except ValidationError:
                item.publish_after_validation = False
            else:
                item.status = Item.Status.PUBLISHED
                item.publish_after_validation = False
            item.save(update_fields=['status', 'publish_after_validation'])
            record_revision(item, job.submitted_by)
        transaction.on_commit(lambda: discard_job_files(job.pk))
        return True
