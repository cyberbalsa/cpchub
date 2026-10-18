from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from botocore.exceptions import EndpointConnectionError
from django.core.management import call_command, CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from hub.costs import running_costs, storage_estimate
from hub.models import StorageUsage


@override_settings(MEDIA_STORAGE='r2', SUPPORT_VPS_YEARLY_USD='71.28', SUPPORT_DOMAIN_YEARLY_USD='12.00')
class SupportCostsTests(TestCase):
    def snapshot(self, size=6_161_873):
        return StorageUsage.objects.create(pk=1, backend='r2', object_count=12, size_bytes=size, measured_at=timezone.now())

    def test_free_tier_and_rounding(self):
        for size, expected in [(0, '0'), (10_000_000_000, '0'), (10_000_000_001, '0.015'), (100_000_000_000, '1.350')]:
            with self.subTest(size=size):
                self.assertEqual(storage_estimate(size), Decimal(expected))
        self.snapshot(100_000_000_000)
        costs = running_costs()
        self.assertEqual(costs['monthly'], Decimal('8.29'))
        self.assertEqual(costs['yearly'], Decimal('99.48'))

    def test_page_reads_snapshot_without_storage_calls(self):
        self.snapshot()
        with patch('hub.management.commands.refresh_storage_usage.storages') as storage:
            response = self.client.get('/donate/')
        storage.__getitem__.assert_not_called()
        self.assertContains(response, '12 files')
        self.assertContains(response, '71.28/year')
        self.assertContains(response, '>6.94</strong>')
        self.assertNotContains(response, 'Wasabi')
        self.assertNotContains(response, '$45')

    def test_unknown_and_stale_are_explicit(self):
        self.assertFalse(running_costs()['complete'])
        self.assertContains(self.client.get('/donate/'), 'Awaiting count')
        usage = self.snapshot()
        usage.measured_at -= timedelta(hours=3)
        usage.save()
        self.assertContains(self.client.get('/donate/'), 'update is delayed')
        with override_settings(SUPPORT_DOMAIN_YEARLY_USD=''):
            self.assertFalse(running_costs()['complete'])
            self.assertContains(self.client.get('/donate/'), 'Awaiting price')
        with override_settings(MEDIA_STORAGE='wasabi'):
            self.assertIsNone(running_costs()['usage'])

    @patch('hub.management.commands.refresh_storage_usage.storages')
    def test_inventory_paginates_and_counts_entire_bucket(self, storages):
        storage = MagicMock(bucket_name='test')
        storages.__getitem__.return_value = storage
        paginator = storage.connection.meta.client.get_paginator.return_value
        paginator.paginate.return_value = [{'Contents': [{'Size': 12}, {'Size': 23}]}, {}, {'Contents': [{'Size': 45}]}]
        call_command('refresh_storage_usage')
        usage = StorageUsage.objects.get(pk=1)
        self.assertEqual((usage.object_count, usage.size_bytes), (3, 80))
        paginator.paginate.assert_called_once_with(Bucket='test')

    @patch('hub.management.commands.refresh_storage_usage.storages')
    def test_failed_inventory_retains_last_success(self, storages):
        previous = self.snapshot()
        def failed_pages():
            yield {'Contents': [{'Size': 100}]}
            raise EndpointConnectionError(endpoint_url='https://private.example')
        storages.__getitem__.return_value.connection.meta.client.get_paginator.return_value.paginate.return_value = failed_pages()
        with self.assertRaisesMessage(CommandError, 'previous storage count was retained'):
            call_command('refresh_storage_usage')
        previous.refresh_from_db()
        self.assertEqual(previous.size_bytes, 6_161_873)
