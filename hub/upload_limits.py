from contextlib import contextmanager
from datetime import timedelta
from math import ceil

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .access import can_moderate
from .models import UploadEvent


UPLOAD_LIMIT = 16
UPLOAD_WINDOW = timedelta(hours=1)


class UploadLimitExceeded(Exception):
    def __init__(self, retry_after):
        self.retry_after = max(1, ceil(retry_after))
        self.message = f"You’ve reached the limit of {UPLOAD_LIMIT} uploads per hour."
        minutes = ceil(self.retry_after / 60)
        super().__init__(f"{self.message} Try again in {minutes} minute{'s' if minutes != 1 else ''}.")


@contextmanager
def upload_slot(user):
    """Reserve one account-wide slot, rolling it back if the upload fails."""
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().get(pk=user.pk)
        if can_moderate(user):
            yield
            return
        now = timezone.now()
        recent = list(UploadEvent.objects.filter(user=user, created_at__gt=now - UPLOAD_WINDOW)
                      .order_by("created_at").values_list("created_at", flat=True)[:UPLOAD_LIMIT])
        if len(recent) >= UPLOAD_LIMIT:
            raise UploadLimitExceeded((recent[0] + UPLOAD_WINDOW - now).total_seconds())
        UploadEvent.objects.create(user=user, created_at=now)
        yield
