"""Public running-cost estimates from a scheduled storage inventory."""
from datetime import timedelta
from decimal import Decimal, ROUND_CEILING

from django.conf import settings
from django.utils import timezone

from hub.models import StorageUsage


# R2 Standard USD pricing, checked 2026-10-17: developers.cloudflare.com/r2/pricing/
GB = Decimal(1_000_000_000)
FREE_GB = Decimal(10)
STORAGE_RATE = Decimal('0.015')


def storage_estimate(size_bytes):
    # Cloudflare rounds storage to whole GB-month billing units.
    gb = (Decimal(size_bytes) / GB).to_integral_value(rounding=ROUND_CEILING)
    return max(Decimal(0), gb - FREE_GB) * STORAGE_RATE


def running_costs():
    vps = Decimal(settings.SUPPORT_VPS_YEARLY_USD)
    domain = Decimal(settings.SUPPORT_DOMAIN_YEARLY_USD) if settings.SUPPORT_DOMAIN_YEARLY_USD else None
    usage = StorageUsage.objects.filter(pk=1, backend=settings.MEDIA_STORAGE).first()
    storage = storage_estimate(usage.size_bytes) if usage and usage.backend == 'r2' else None
    fixed = vps + (domain or Decimal(0))
    monthly = fixed / 12 + (storage or Decimal(0))
    return {
        'vps_yearly': vps, 'vps_monthly': vps / 12,
        'domain_yearly': domain, 'domain_monthly': domain / 12 if domain is not None else None,
        'usage': usage, 'storage_monthly': storage,
        'monthly': monthly, 'yearly': monthly * 12,
        'complete': domain is not None and storage is not None,
        'stale': bool(usage and usage.measured_at < timezone.now() - timedelta(hours=2)),
    }
