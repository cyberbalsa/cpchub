import io
import struct
import zlib

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from hub.models import Bookmark, ContentType, Item, Release, TagSettings, UserModeration
from sandbox.protocol import PACKET, decode_stats, encode_stats
from . import test_validation as fixtures


def stats(**changes):
    values = {'kind': 1, 'format_version': 3, 'width': 10, 'height': 16, 'depth': 12,
              'footprint_tiles': 120, 'objects': 100, 'object_types': 4, 'parking_spaces': 69,
              'golf_cart_spaces': 0, 'entrances': 1, 'exits': 1, **changes}
    return decode_stats(encode_stats(values), values['kind'])


class DecodedStatsTests(SimpleTestCase):
    def test_blueprint_stats_use_actual_dimensions_and_count_placements(self):
        metadata = fixtures.cbor({'name': 'Test', 'size': [10, 16, 12], 'tileMapSize': [32, 32, 32],
                                 'placedTemplates': {'ParkingBay': [0] * 69, 'ParkingEntrance': [0], 'ParkingExit': [0], 'GolfCartBay': [0, 0], 'Unused': []}})
        data = struct.pack('<II', 3, len(metadata)) + metadata + bytes(2 + 3 * 32**3 + 32**2)
        result = decode_stats(fixtures.guest.evaluate(1, io.BytesIO(data), len(data)), 1)
        self.assertEqual((result['width'], result['depth'], result['height']), (10, 12, 16))
        self.assertEqual(result['footprint_tiles'], 120)
        self.assertEqual(result['parking_spaces'], 69)
        self.assertEqual(result['golf_cart_spaces'], 2)
        self.assertEqual(result['objects'], 73)
        self.assertEqual(result['object_types'], 4)
        self.assertIsNone(result['maps'])

    def test_scenario_stats_aggregate_maps_and_only_count_placed_objects(self):
        metadata = fixtures.cbor({'rooms': [
            {'entities': [{'template': 'ParkingBay', 'components': {'Placed': {}}}, {'template': 'Car', 'components': {}}], 'scenario': [], 'tileMapSize': [32, 32, 64]},
            {'entities': {'1': {'template': 'ParkingBay', 'components': {'Placed': {}}}, '2': {'template': 'GolfCartBay', 'components': {'Placed': {}}}}, 'scenario': [], 'tileMapSize': [64, 64, 32]},
        ]})
        raw = len(metadata).to_bytes(8, 'little') + metadata + bytes(10 + 3 * 32 * 32 * 64 + 2 * 32 * 64) + bytes(10 + 3 * 64 * 64 * 32 + 2 * 64 * 32)
        data = zlib.compress(raw) + len(raw).to_bytes(4, 'little')
        result = decode_stats(fixtures.guest.evaluate(2, io.BytesIO(data), len(data)), 2)
        self.assertEqual((result['width'], result['depth'], result['height']), (64, 64, 64))
        self.assertEqual((result['maps'], result['entities'], result['objects']), (2, 4, 3))
        self.assertEqual(result['footprint_tiles'], 4096)
        self.assertEqual(result['parking_spaces'], 2)
        self.assertEqual(result['golf_cart_spaces'], 1)
        self.assertIsNone(result['format_version'])

    def test_unknown_object_metadata_is_not_reported_as_zero(self):
        metadata = fixtures.cbor({'name': 'Test', 'size': [1, 1, 1], 'tileMapSize': [32, 32, 32], 'placedTemplates': {'FutureType': {}}})
        data = struct.pack('<II', 3, len(metadata)) + metadata + bytes(2 + 3 * 32**3 + 32**2)
        result = decode_stats(fixtures.guest.evaluate(1, io.BytesIO(data), len(data)), 1)
        self.assertIsNone(result['objects'])
        self.assertIsNone(result['parking_spaces'])
        self.assertEqual(result['width'], 1)

    def test_protocol_rejects_wrong_kind_truncation_extras_and_impossible_values(self):
        packet = fixtures.guest.evaluate(1, io.BytesIO(fixtures.blueprint()), len(fixtures.blueprint()))
        self.assertEqual(len(packet), 120)
        for invalid in [packet[:-1], packet + b'x', b'x' * PACKET.size]:
            with self.assertRaises(ValueError):
                decode_stats(invalid, 1)
        with self.assertRaises(ValueError):
            decode_stats(packet, 2)
        for change in [{'width': 2049}, {'objects': -2}, {'parking_spaces': 101}, {'maps': 2}, {'footprint_tiles': 999}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                stats(**change)


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False)
class FileStatsCatalogTests(TestCase):
    def setUp(self):
        self.author = get_user_model().objects.create_user('stats-author')
        self.other = get_user_model().objects.create_user('stats-other')
        self.category = ContentType.objects.get(slug='blueprints')
        self.api = APIClient()
        TagSettings.objects.update_or_create(pk=1, defaults={'minimum_items': 1})

    def creation(self, values=None, **changes):
        item = Item.objects.create(author=self.author, content_type=self.category, title='Garage', summary='A garage', tags='parking', **changes)
        release = Release.objects.create(item=item, version='1', original_filename='garage.cpbp', size=100, file_stats=stats() if values is None else values)
        return item, release

    def ids(self, params):
        response = self.api.get('/api/v1/items/', params)
        self.assertEqual(response.status_code, 200)
        return [row['id'] for row in response.data['results']]

    def test_stats_table_and_api_show_zero_counts_and_version_specific_stats(self):
        item, old = self.creation()
        latest = Release.objects.create(item=item, version='2', original_filename='<old>.cpbp', size=200, file_stats=stats(parking_spaces=70))
        response = self.client.get(item.get_absolute_url())
        self.assertContains(response, 'File stats')
        self.assertContains(response, 'Car parking spaces')
        self.assertContains(response, '>70<')
        self.assertContains(response, '>69<')
        self.assertContains(response, 'Golf cart spaces')
        self.assertContains(response, '>0<')
        self.assertContains(response, '&lt;old&gt;.cpbp')
        data = self.api.get(f'/api/v1/items/{item.pk}/').data['releases']
        self.assertEqual([r['file_stats']['parking_spaces'] for r in data], [70, 69])
        self.assertEqual(data[0]['file_stats']['schema_version'], 1)

    def test_every_numeric_stat_supports_inclusive_minimum_and_maximum(self):
        item, release = self.creation()
        for key, value in release.file_stats.items():
            if key in {'schema_version', 'kind'} or value is None:
                continue
            with self.subTest(key=key):
                self.assertEqual(self.ids({f'min_{key}': value, f'max_{key}': value}), [str(item.pk)])
                self.assertEqual(self.ids({f'max_{key}': value - 1}) if value else self.ids({f'min_{key}': 1}), [])
        item.delete()
        self.category = ContentType.objects.get(slug='scenarios')
        item, release = self.creation(stats(kind=2, format_version=None, maps=2, entities=120))
        self.assertEqual(self.ids({'min_maps': 2, 'max_entities': 120}), [str(item.pk)])
        self.assertEqual(self.ids({'max_maps': 1}), [])

    def test_filters_use_latest_release_and_never_mix_stats_from_different_versions(self):
        item, old = self.creation()
        latest = Release.objects.create(item=item, version='2', size=100, file_stats=stats(parking_spaces=2, width=20, footprint_tiles=240))
        self.assertEqual(self.ids({'min_parking_spaces': 10}), [])
        self.assertEqual(self.ids({'max_parking_spaces': 2, 'max_width': 10}), [])
        self.assertEqual(self.ids({'max_parking_spaces': 2, 'min_width': 20}), [str(item.pk)])
        latest.delete()
        self.assertEqual(self.ids({'min_parking_spaces': 10}), [str(item.pk)])

    def test_unknown_missing_and_uninspected_latest_stats_never_match_zero(self):
        zero, release = self.creation(stats(parking_spaces=0))
        self.creation({})
        self.creation(stats(parking_spaces=None))
        old, release = self.creation(stats(parking_spaces=0))
        Release.objects.create(item=old, version='2', size=100)
        self.assertEqual(self.ids({'max_parking_spaces': 0}), [str(zero.pk)])
        self.assertEqual(self.ids({'min_parking_spaces': 0}), [str(zero.pk)])
        self.assertEqual(self.client.get('/', {'max_parking_spaces': 0}).context['page_obj'].paginator.count, 1)

    def test_filters_keep_visibility_tag_type_collection_and_pagination_rules(self):
        items = [self.creation()[0] for _ in range(13)]
        for item in items:
            Bookmark.objects.create(user=self.author, item=item)
        self.creation(status='draft')
        self.creation(is_hidden=True, hidden_reason='Review')
        self.creation(deleted_at=timezone.now())
        private = Item.objects.create(author=self.other, content_type=self.category, title='Shadow garage')
        Release.objects.create(item=private, version='1', size=1, file_stats=stats())
        UserModeration.objects.create(user=self.other, shadow_banned_at=timezone.now())
        self.client.force_login(self.author)
        params = {'min_parking_spaces': 60, 'type': 'blueprints', 'tag': 'parking', 'view': 'saved'}
        response = self.client.get('/', params, HTTP_HX_REQUEST='true')
        self.assertEqual(response.context['page_obj'].paginator.count, 13)
        self.assertContains(response, 'min_parking_spaces=60')
        self.assertContains(response, 'page=2')
        self.assertNotContains(response, '<!doctype')
        self.assertEqual(len(self.ids({'min_parking_spaces': 60})), 13)
        response = self.client.get('/', {**params, 'page': 2})
        self.assertEqual(len(response.context['page_obj']), 1)
        self.assertNotIn('min_parking_spaces', response.context['clear_stats_url'])
        self.assertIn('tag=parking', response.context['clear_stats_url'])
        self.assertIn('view=saved', response.context['clear_stats_url'])

    def test_bad_ranges_and_non_numeric_values_are_rejected_without_server_errors(self):
        self.creation()
        for query in [{'min_width': 'oops'}, {'max_width': 2049}, {'min_width': -1}, {'min_width': 20, 'max_width': 10}, {'min_objects': '1 OR 1=1'}]:
            with self.subTest(query=query):
                self.assertEqual(self.api.get('/api/v1/items/', query).status_code, 400)
                response = self.client.get('/', query, HTTP_HX_REQUEST='true')
                self.assertContains(response, 'Check the file filters.')
                self.assertEqual(response.context['page_obj'].paginator.count, 0)
