from botocore.exceptions import BotoCoreError, ClientError
from rest_framework.views import exception_handler as drf_exception_handler


def exception_handler(exc, context):
    if isinstance(exc, (BotoCoreError, ClientError)):
        from .file_delivery import StorageUnavailable
        exc = StorageUnavailable()
    response = drf_exception_handler(exc, context)
    if response is not None:
        response.data = {"status": response.status_code, "errors": response.data}
        response["Cache-Control"] = "private, no-store"
    return response
