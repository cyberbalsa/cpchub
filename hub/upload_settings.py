from django.conf import settings

from .models import UploadSettings


def max_game_file_bytes():
    megabytes = UploadSettings.objects.filter(pk=1).values_list("max_file_mb", flat=True).first() or 15
    return min(megabytes * 1024 * 1024, settings.MAX_UPLOAD_BYTES, 100 * 1024 * 1024)
