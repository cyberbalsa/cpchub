import re

from gunicorn.glogging import Logger


DOWNLOAD_PATH = re.compile(r"^/(?:api/v1/)?items/[^/]+/releases/[^/]+/download/?$")


class DownloadPrivacyLogger(Logger):
    def atoms(self, resp, req, environ, request_time):
        atoms = super().atoms(resp, req, environ, request_time)
        if DOWNLOAD_PATH.fullmatch(environ.get("PATH_INFO", "")):
            atoms["h"] = "-"
        return atoms
