from datetime import timedelta
from ipaddress import ip_network

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .client_ip import normalize_ip
from .models import DownloadIP, DownloadUser, Item, Release


IP_RETENTION = timedelta(days=14)


def download_network(request):
    # The middleware accepts forwarded addresses only from our trusted proxy.
    address = normalize_ip(getattr(request, "client_ip", request.META.get("REMOTE_ADDR", "")))
    # /32 is one IPv4 address, or the requested IPv6 subnet.
    return str(ip_network(f"{address}/32", strict=False)) if address else None


@transaction.atomic
def count_download(request, release):
    """Count successful link issuance once per account or unexpired network marker."""
    user_id = request.user.pk if request.user.is_authenticated else None
    network = download_network(request)
    if not user_id and not network:
        return

    # Match upload/account-deletion lock order before locking the creation.
    if user_id:
        if not get_user_model().objects.select_for_update().filter(pk=user_id).first():
            return
    # Serialize every version of this creation, including simultaneous first downloads.
    item = Item.objects.select_for_update().only("pk").get(pk=release.item_id)
    now = timezone.now()
    for release_id in (None, release.pk):
        scope = {"item_id": item.pk, "release_id": release_id}
        seen_user = seen_ip = False
        if user_id:
            _, created = DownloadUser.objects.get_or_create(**scope, user_id=user_id)
            seen_user = not created
        if network:
            marker = DownloadIP.objects.filter(**scope, network=network).first()
            seen_ip = marker is not None and marker.expires_at > now
            # Record both identities even when either one already suppressed the count.
            # Each observed address expires 14 days after its last download.
            DownloadIP.objects.update_or_create(
                **scope, network=network, defaults={"expires_at": now + IP_RETENTION},
            )
        if not (seen_user or seen_ip):
            target = Release.objects.filter(pk=release_id) if release_id else Item.objects.filter(pk=item.pk)
            target.update(downloads=F("downloads") + 1)


def purge_download_ips():
    return DownloadIP.objects.filter(expires_at__lte=timezone.now()).delete()[0]
