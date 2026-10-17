import hashlib
import importlib.util
import io
import struct
import tempfile
import zlib
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from PIL import Image, PngImagePlugin
from rest_framework.test import APIClient

from hub.models import ContentType, Item, ModerationLog, Release, Screenshot, UploadJob, UploadSettings
from hub.upload_jobs import RESULT_MAGIC, collect_job, incoming_path

spec = importlib.util.spec_from_file_location('validation_guest', Path(__file__).resolve().parents[1] / 'sandbox/guest.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def cbor(value):
    def head(major, n):
        return bytes([major * 32 + n]) if n < 24 else bytes([major * 32 + 24, n])
    if isinstance(value, int):
        return head(0, value)
    if isinstance(value, str):
        data = value.encode()
        return head(3, len(data)) + data
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(cbor(v) for v in value)
    return head(5, len(value)) + b''.join(cbor(k) + cbor(v) for k, v in value.items())


def blueprint():
    metadata = cbor({'name': 'Test', 'placedTemplates': {}, 'size': [1, 1, 1], 'tileMapSize': [32, 32, 32]})
    return struct.pack('<II', 3, len(metadata)) + metadata + bytes(2 + 3 * 32**3 + 32**2)


def scenario():
    metadata = cbor({'rooms': [{'entities': [], 'scenario': [], 'tileMapSize': [32, 32, 32]}]})
    data = len(metadata).to_bytes(8, 'little') + metadata + bytes(10 + 3 * 32**3 + 2 * 32**2)
    return zlib.compress(data) + len(data).to_bytes(4, 'little')


def picture(width=640, height=360, format='PNG', **kwargs):
    output = io.BytesIO()
    Image.new('RGB', (width, height), (65, 110, 70)).save(output, format, **kwargs)
    return output.getvalue()


class GuestValidationTests(SimpleTestCase):
    def test_native_headers_metadata_lengths_and_compression_are_checked(self):
        for kind, data in [(1, blueprint()), (2, scenario())]:
            guest.evaluate(kind, io.BytesIO(data), len(data))
            for bad in [b'not a game file', data[:10], data[:-1], data + b'junk']:
                with self.subTest(kind=kind, size=len(bad)), self.assertRaises((ValueError, zlib.error)):
                    guest.evaluate(kind, io.BytesIO(bad), len(bad))
        with self.assertRaises(ValueError):
            guest.evaluate(1, io.BytesIO(scenario()), len(scenario()))
        with self.assertRaises(ValueError):
            guest.evaluate(1, io.BytesIO(struct.pack('<II', 999, 10) + b'x' * 10), 18)

    def test_metadata_nesting_and_expansion_have_bounded_limits(self):
        with self.assertRaises(ValueError):
            guest.metadata(b'\x81' * 40 + b'\x00')
        with patch.object(guest, 'MAX_EXPANDED', 1000), self.assertRaises(ValueError):
            guest.evaluate(2, io.BytesIO(scenario()), len(scenario()))
        with self.assertRaises(ValueError):
            guest.metadata(b'\xa2\x61a\x01\x61a\x02')

    def test_images_are_decoded_resized_and_stripped_of_metadata(self):
        info = PngImagePlugin.PngInfo()
        info.add_text('Author', 'Private camera data')
        data = picture(2400, 1350, pnginfo=info)
        result = guest.evaluate(3, io.BytesIO(data), len(data))
        with Image.open(io.BytesIO(result)) as image:
            self.assertEqual(image.format, 'WEBP')
            self.assertEqual(image.size, (1920, 1080))
            self.assertNotIn('Author', image.info)
            self.assertFalse(image.getexif())

    def test_screenshot_bounds_animation_and_broken_files_are_rejected(self):
        for width, height in [(319, 180), (320, 179), (8193, 180), (2400, 180), (320, 2000), (5000, 4100)]:
            data = picture(width, height)
            with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                guest.evaluate(3, io.BytesIO(data), len(data))
        for data in [b'<svg/>', picture()[:50], picture(format='JPEG')[:-30], picture(format='GIF')]:
            with self.assertRaises((ValueError, OSError, SyntaxError)):
                guest.evaluate(3, io.BytesIO(data), len(data))
        output = io.BytesIO()
        Image.new('RGB', (640, 360), 'red').save(output, 'PNG', save_all=True, append_images=[Image.new('RGB', (640, 360), 'blue')], duration=100)
        data = output.getvalue()
        with self.assertRaises(ValueError):
            guest.evaluate(3, io.BytesIO(data), len(data))


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, ASYNC_UPLOAD_VALIDATION=True, STORAGES={
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'},
})
class UploadValidationTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for name in ['incoming', 'results', 'media']:
            (self.root / name).mkdir()
        settings = override_settings(UPLOAD_QUEUE_ROOT=self.root, MEDIA_ROOT=self.root / 'media')
        settings.enable()
        self.addCleanup(settings.disable)
        self.author = get_user_model().objects.create_user('validation-author')
        self.other = get_user_model().objects.create_user('validation-other')
        self.admin = get_user_model().objects.create_user('validation-admin')
        self.admin.groups.add(Group.objects.get(name='Admin'))
        self.category = ContentType.objects.get(slug='blueprints')
        self.client.force_login(self.author)
        self.api = APIClient()
        self.api.force_login(self.author)
        self.data = {'title': 'Checked lot', 'summary': 'A lot', 'description': 'Details', 'tags': 'parking',
                     'content_type': self.category.pk, 'status': 'published', 'version': '1'}

    def create(self, **changes):
        data = {**self.data, 'file': SimpleUploadedFile('lot.cpbp', blueprint()),
                'screenshots': [SimpleUploadedFile('lot.png', picture())], **changes}
        with patch('PIL.Image.open', side_effect=AssertionError('The application must not decode uploads')):
            response = self.client.post('/upload/', data)
        self.assertEqual(response.status_code, 302)
        return Item.objects.get()

    def result(self, job, code=0, digest=None):
        payload = b''
        if code == 0:
            payload = guest.clean_image(io.BytesIO(picture()), len(picture())) if job.kind == 'screenshot' else guest.evaluate(1, io.BytesIO(blueprint()), len(blueprint()))
        data = RESULT_MAGIC + bytes([code]) + len(payload).to_bytes(4, 'big') + (digest or bytes.fromhex(job.sha256)) + payload
        (self.root / 'results' / f'{job.pk.hex}.result').write_bytes(data)
        with self.captureOnCommitCallbacks(execute=True), patch('PIL.Image.open', side_effect=AssertionError('The collector must not decode uploads')):
            collect_job(job.pk)

    def test_web_upload_stays_private_until_every_file_passes(self):
        item = self.create()
        self.assertEqual(item.status, 'draft')
        self.assertTrue(item.publish_after_validation)
        self.assertEqual(item.upload_jobs.count(), 2)
        self.assertFalse(Release.objects.exists())
        self.assertFalse(Screenshot.objects.exists())
        self.assertFalse(list((self.root / 'media').rglob('*.*')))
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(item.get_absolute_url()).status_code, 404)
        jobs = list(item.upload_jobs.order_by('created_at'))
        self.result(jobs[0])
        item.refresh_from_db()
        self.assertEqual(item.status, 'draft')
        self.result(jobs[1])
        item.refresh_from_db()
        self.assertEqual(item.status, 'published')
        self.assertEqual(item.releases.count(), 1)
        self.assertEqual(item.screenshots.count(), 1)
        self.assertEqual(item.releases.get().file.read(), blueprint())
        self.assertEqual(self.client.get(item.get_absolute_url()).status_code, 200)
        self.assertFalse(item.publish_after_validation)

    def test_failed_checks_keep_item_draft_and_store_no_rejected_file(self):
        item = self.create()
        self.result(item.upload_jobs.get(kind='release'), code=1)
        self.result(item.upload_jobs.get(kind='screenshot'))
        item.refresh_from_db()
        self.assertEqual(item.status, 'draft')
        self.assertFalse(item.publish_after_validation)
        self.assertFalse(item.releases.exists())
        self.assertContains(self.client.get(reverse('item-edit', args=[item.pk])), 'did not pass validation')
        self.assertEqual(item.upload_jobs.get(kind='release').status, 'failed')

    def test_api_returns_jobs_allows_publish_intent_and_restricts_job_visibility(self):
        item = Item.objects.create(author=self.author, content_type=self.category, title='API lot', status='draft')
        url = f'/api/v1/items/{item.pk}/'
        response = self.api.post(url + 'releases/', {'version': '1', 'file': SimpleUploadedFile('lot.cpbp', blueprint())}, format='multipart')
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data['status'], 'pending')
        response = self.api.post(url + 'screenshots/', {'image': SimpleUploadedFile('lot.png', picture())}, format='multipart')
        self.assertEqual(response.status_code, 202)
        response = self.api.patch(url, {'status': 'published'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['status'], 'draft')
        self.assertEqual(len(self.api.get(url + 'upload-jobs/').data), 2)
        self.api.force_login(self.other)
        self.assertEqual(self.api.get(url + 'upload-jobs/').status_code, 404)
        self.assertEqual(self.client.get(reverse('upload-checks', args=[item.pk])).status_code, 200)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(reverse('upload-checks', args=[item.pk])).status_code, 404)
        for job in item.upload_jobs.all():
            self.result(job)
        item.refresh_from_db()
        self.assertEqual(item.status, 'published')
        self.assertEqual(self.api.get(url + 'upload-jobs/').status_code, 403)

    def test_manual_draft_or_deletion_prevents_automatic_publication(self):
        for delete in [False, True]:
            with self.subTest(delete=delete):
                item = self.create()
                if delete:
                    self.client.post(reverse('item-self-delete', args=[item.pk]))
                else:
                    self.client.post(reverse('item-unpublish', args=[item.pk]))
                for job in item.upload_jobs.all():
                    self.result(job)
                item.refresh_from_db()
                self.assertEqual(item.status, 'draft')
                if delete:
                    self.assertFalse(item.releases.exists())
                    self.assertFalse(item.screenshots.exists())
                item.delete()

    def test_wrong_digest_timeout_and_missing_or_tampered_inputs_fail_closed(self):
        for mode in ['digest', 'timeout', 'tamper', 'missing']:
            item = self.create()
            job = item.upload_jobs.get(kind='release')
            if mode == 'timeout':
                UploadJob.objects.filter(pk=job.pk).update(created_at=timezone.now() - timedelta(minutes=16))
                collect_job(job.pk)
            else:
                if mode == 'tamper':
                    incoming_path(job.pk).write_bytes(b'changed')
                elif mode == 'missing':
                    incoming_path(job.pk).unlink()
                self.result(job, digest=b'x' * 32 if mode == 'digest' else None)
            job.refresh_from_db()
            self.assertEqual(job.status, 'failed')
            self.assertFalse(item.releases.exists())
            item.delete()

    def test_pending_versions_and_screenshot_slots_cannot_be_duplicated(self):
        item = self.create()
        url = f'/api/v1/items/{item.pk}/'
        self.assertEqual(self.api.post(url + 'releases/', {'version': '1', 'file': SimpleUploadedFile('lot.cpbp', blueprint())}, format='multipart').status_code, 400)
        for index in range(7):
            self.assertEqual(self.api.post(url + 'screenshots/', {'image': SimpleUploadedFile(f'{index}.png', picture())}, format='multipart').status_code, 202)
        self.assertEqual(self.api.post(url + 'screenshots/', {'image': SimpleUploadedFile('extra.png', picture())}, format='multipart').status_code, 400)
        self.assertEqual(self.api.patch(url, {'content_type': 'scenarios'}).status_code, 400)

    def test_queue_admission_reserves_room_for_the_whole_creation(self):
        item = self.create()
        UploadJob.objects.bulk_create([
            UploadJob(item=item, submitted_by=self.author, kind='release', original_filename='queued.cpbp', size=1)
            for _ in range(29)
        ])
        response = self.client.post('/upload/', {**self.data, 'file': SimpleUploadedFile('next.cpbp', blueprint()),
                                               'screenshots': [SimpleUploadedFile('next.png', picture())]})
        self.assertContains(response, 'file-check queue is full')
        self.assertEqual(Item.objects.count(), 1)
        self.assertEqual(UploadJob.objects.count(), 31)

    def test_version_conflicts_are_rejected_before_storing_another_file(self):
        from hub.moderation import ReleaseMetadataForm
        item = self.create()
        existing = Release.objects.create(item=item, version='old', file=SimpleUploadedFile('old.cpbp', blueprint()),
                                          original_filename='old.cpbp', size=len(blueprint()), sha256='a' * 64)
        form = ReleaseMetadataForm({'version': '1', 'game_version': '', 'changelog': ''}, instance=existing)
        self.assertFalse(form.is_valid())
        self.assertIn('being checked', form.errors['version'][0])
        existing.version = '1'
        existing.save(update_fields=['version'])
        files_before = set((self.root / 'media').rglob('*.*'))
        job = item.upload_jobs.get(kind='release')
        self.result(job)
        job.refresh_from_db()
        self.assertEqual(job.status, 'failed')
        self.assertEqual(item.releases.count(), 1)
        self.assertEqual(set((self.root / 'media').rglob('*.*')), files_before)

    def test_decoded_stats_are_saved_and_backfilled_without_reupload_or_republication(self):
        from hub.upload_jobs import queue_release_stats
        item = self.create()
        for job in item.upload_jobs.all():
            self.result(job)
        item.refresh_from_db()
        release = item.releases.get()
        self.assertEqual(release.file_stats['width'], 1)
        self.assertEqual(release.file_stats['parking_spaces'], 0)
        Release.objects.filter(pk=release.pk).update(file_stats={})
        before = (item.status, item.updated_at, item.content_revision, item.downloads, release.file.name)
        files_before = set((self.root / 'media').rglob('*.*'))
        job = queue_release_stats(release)
        self.assertIsNone(queue_release_stats(release))
        self.result(job)
        item.refresh_from_db()
        release.refresh_from_db()
        self.assertEqual(release.file_stats['footprint_tiles'], 1)
        self.assertEqual((item.status, item.updated_at, item.content_revision, item.downloads, release.file.name), before)
        self.assertEqual(set((self.root / 'media').rglob('*.*')), files_before)
        self.assertEqual(item.releases.count(), 1)
        job = queue_release_stats(release)
        self.result(job, code=1)
        item.refresh_from_db()
        self.assertEqual(item.status, 'published')
        release.refresh_from_db()
        self.assertEqual(release.file_stats['width'], 1)

    def test_invalid_native_stats_never_create_a_release(self):
        from sandbox.protocol import encode_stats
        for payload in [b'x' * 120, encode_stats({'kind': 2, 'width': 32, 'height': 32, 'depth': 32,
                                               'footprint_tiles': 1024, 'maps': 1, 'entities': 0})]:
            item = self.create()
            job = item.upload_jobs.get(kind='release')
            result = RESULT_MAGIC + b'\x00' + len(payload).to_bytes(4, 'big') + bytes.fromhex(job.sha256) + payload
            (self.root / 'results' / f'{job.pk.hex}.result').write_bytes(result)
            collect_job(job.pk)
            job.refresh_from_db()
            self.assertEqual(job.status, 'failed')
            self.assertFalse(item.releases.exists())
            item.delete()

    def test_game_file_limit_defaults_to_fifteen_mb_and_is_admin_adjustable(self):
        response = self.client.post('/upload/', {**self.data, 'file': SimpleUploadedFile('huge.cpbp', bytes(15 * 1024 * 1024 + 1)), 'screenshots': [SimpleUploadedFile('lot.png', picture())]})
        self.assertContains(response, 'up to 15 MB')
        self.assertFalse(UploadJob.objects.exists())
        url = reverse('moderation-upload-settings')
        self.assertEqual(self.client.post(url, {'max_file_mb': 20}).status_code, 403)
        self.client.force_login(self.admin)
        self.assertEqual(self.client.post(url, {'max_file_mb': 20}).status_code, 302)
        self.assertEqual(UploadSettings.objects.get(pk=1).max_file_mb, 20)
        self.assertTrue(ModerationLog.objects.filter(action='change upload limit').exists())
        self.assertContains(self.client.get('/upload/'), '20 MB per game file')
        for invalid in [0, 101, '']:
            self.assertEqual(self.client.post(url, {'max_file_mb': invalid}).status_code, 200)
        self.assertEqual(UploadSettings.objects.get(pk=1).max_file_mb, 20)

    def test_zip_json_packs_and_mismatched_native_files_are_rejected_before_queue(self):
        for filename, content_type in [('a.zip', self.category.pk), ('a.json', self.category.pk), ('a.cpcs', self.category.pk), ('a.cpbp', ContentType.objects.get(slug='blueprint-packs').pk)]:
            response = self.client.post('/upload/', {**self.data, 'content_type': content_type, 'file': SimpleUploadedFile(filename, b'x'), 'screenshots': [SimpleUploadedFile('lot.png', picture())]})
            self.assertEqual(response.status_code, 200)
            self.assertFalse(UploadJob.objects.exists())
