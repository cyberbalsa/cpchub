from botocore.exceptions import BotoCoreError, ClientError
from django.http import FileResponse, HttpResponseRedirect
from rest_framework.exceptions import APIException, NotFound


class StorageUnavailable(APIException):
    status_code = 503
    default_detail = "File storage is temporarily unavailable. Try again shortly."
    default_code = "storage_unavailable"


def file_response(field, *, method="GET", filename=None, content_type="application/octet-stream"):
    """Call only after checking the parent item's visibility and token scopes."""
    try:
        storage = field.storage
        if hasattr(storage, "signed_download_url"):
            if not storage.exists(field.name):
                raise NotFound("This file is unavailable.")
            response = HttpResponseRedirect(storage.signed_download_url(
                field.name, filename=filename, content_type=content_type, method=method,
            ))
        else:
            response = FileResponse(field.open("rb"), as_attachment=bool(filename),
                                    filename=filename or "", content_type=content_type)
    except FileNotFoundError as exc:
        raise NotFound("This file is unavailable.") from exc
    except (BotoCoreError, ClientError) as exc:
        # Never return provider error details or a signed URL in a failure response.
        raise StorageUnavailable() from exc
    response["Cache-Control"] = "private, no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response
