from urllib.parse import urlparse
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from oauth2_provider.models import Application


class Command(BaseCommand):
    help = "Register a public mod-manager OAuth client (authorization code with mandatory S256 PKCE)."

    def add_arguments(self, parser):
        parser.add_argument("name")
        parser.add_argument("redirect_uri")
        parser.add_argument("--owner", required=True, help="Site operator's username")

    def handle(self, *args, **options):
        uri = urlparse(options["redirect_uri"])
        if uri.fragment or uri.username or not uri.hostname or not (uri.scheme == "https" or uri.scheme == "http" and uri.hostname in {"127.0.0.1", "::1"}):
            raise CommandError("Use an HTTPS callback or http://127.0.0.1:<port>/callback with no fragment or credentials.")
        try:
            owner = get_user_model().objects.get(username=options["owner"], is_staff=True)
        except get_user_model().DoesNotExist:
            raise CommandError("Owner must be a staff user.")
        app, created = Application.objects.get_or_create(name=options["name"], user=owner, defaults={
            "client_type": Application.CLIENT_PUBLIC, "authorization_grant_type": Application.GRANT_AUTHORIZATION_CODE,
            "redirect_uris": options["redirect_uri"], "skip_authorization": False,
        })
        if not created and app.redirect_uris != options["redirect_uri"]:
            raise CommandError("A manager with this name already exists with a different callback.")
        self.stdout.write(f"Client ID: {app.client_id}\nCallback: {app.redirect_uris}\nPublic client: do not ship a client secret.")
