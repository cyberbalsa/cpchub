# CPC Hub

A community catalog for **Car Park Capital**, built for **cpchub.net** with Python 3.14, Django 5.2 LTS, HTMX, Bootstrap 5's responsive grid, 98.css, PostgreSQL, and Docker. All browser assets are served locally.

The interface takes its cues from RCT and Car Park Capital: beveled tool buttons, orange and teal window frames, pixel icons, a town viewport, and parchment-colored file panels. The illustrations and icons are original SVGs; game assets are not included.

## Included

- Searchable catalog with categories, sorting, pagination, saved creations, and an author’s uploads.
- Steam and Discord sign-in through django-allauth. Profiles let users link additional accounts and unlink all but their last login. Password login, password resets, and local registration are disabled. Email is not required.
- Author-only edits with metadata snapshots; immutable versioned releases with changelogs, game-version labels, sizes, SHA-256 checksums, and historical downloads.
- Up to eight screenshots per item; PNG/JPEG/WebP inputs are resized and re-encoded to WebP, with metadata removed.
- Configurable categories and file extensions. Initial types: blueprints, blueprint packs, scenarios, and other mods. Accepts native `.cpbp`/`.cpcs`, ZIPs, and JSON as appropriate. ZIPs are stored without extracting their contents. New types/extensions can be added in Django admin.
- Drafts visible only to the author; file delivery checks the same permissions as the catalog.
- Private Wasabi storage for uploaded releases and screenshots, with five-minute signed download URLs. CSS, JavaScript, fonts, and site artwork stay local.
- Named, hashed API keys with read/write scopes, expiration (1–90 days), revocation, and a one-time secret display.
- Mod-manager sign-in through OAuth authorization code + **S256 PKCE**, explicit consent, 15-minute access tokens, rotating refresh tokens, and optional per-manager API-key creation. Keys cannot create additional keys. OAuth clients cannot grant broader permissions or manage another client’s keys.
- OpenAPI **3.1**, Swagger UI, ReDoc, request/response serializers, multipart upload schemas, authentication scopes, and a consistent API error envelope.
- Django admin, health endpoint, pinned Python dependencies, Docker Compose, and a Caddy HTTPS configuration for cpchub.net.

## Run with Docker

Docker Compose 2.24.4+ is required for the production override's `!reset` syntax.

```bash
cp .env.example .env
# Fill SECRET_KEY and POSTGRES_PASSWORD with independent random values.
# A generator: python -c 'import secrets; print(secrets.token_hex(32))'
docker compose up --build -d
```

Open **http://127.0.0.1:8000/**. The database and uploads use named persistent volumes. Migrations run in a one-shot service before the web service starts. No admin account or demo data is created automatically. Configure a social provider before signing in. To grant an existing social account administrator access, follow the [account access instructions](docs/deployment.md#backups-and-account-access).

Optional illustrative catalog:

```bash
docker compose exec web python manage.py seed_demo
```

Demo listings are labeled, have an inactive author, and contain sample JSON, **not playable game exports**. Their illustrations are original SVGs, not redistributed game assets. Production should start with a clean database or remove these demo listings through admin.

## Run with Podman

With Podman and `podman-compose` installed, prepare `.env` as above, then run:

```bash
podman-compose -f compose.yaml up --build -d
```

The site runs at **http://127.0.0.1:8000/**. To rebuild the web service after source changes:

```bash
podman-compose -f compose.yaml up --build --force-recreate --no-deps -d web
```

This replaces the web container and keeps the database and upload volumes.

## Wasabi upload storage

Only user-generated content goes to Wasabi: release files, ZIP packs, and screenshots. The app validates uploads and converts screenshots to WebP before storing them under `ugc/releases/` and `ugc/screenshots/`. Site assets continue to use WhiteNoise.

Create a private bucket in Wasabi. Use `deploy/wasabi-ugc-policy.json` as the application user's policy, replacing `__BUCKET__` with the bucket name. It allows listing that bucket and reading, writing, and deleting objects in those two prefixes. It grants no IAM, ACL, or bucket-configuration permissions.

The optional provisioning script creates the application user, attaches that policy, and writes restricted access keys to a mode-0600 `.env` file. Supply an ignored local file with `access-key=...`, `secret-key=...`, and `bucket=...` entries. Root keys are used only for provisioning:

```bash
.venv/bin/python scripts/provision_wasabi.py --credentials-file wasabis3.txt
```

Alternatively, set the `WASABI_*` values in `.env` with an existing restricted key. Use the endpoint for the bucket's region. `WASABI_SIGNED_URL_SECONDS` defaults to 300 and accepts 60–900 seconds.

For an existing installation, pause uploads while switching storage. With the new image built and Wasabi configured, copy the files before enabling the backend:

```bash
podman-compose -f compose.yaml build web
podman-compose -f compose.yaml stop web
podman-compose -f compose.yaml run --rm --no-deps web python manage.py migrate_uploads_to_wasabi
podman-compose -f compose.yaml run --rm --no-deps web python manage.py migrate_uploads_to_wasabi --apply
# Set MEDIA_STORAGE=wasabi in .env after verification succeeds.
podman-compose -f compose.yaml up --force-recreate --no-deps -d web
```

The migration verifies SHA-256 checksums, preserves object names and releases, refuses to overwrite conflicting remote content, and keeps the local originals. It can be rerun. If it fails, leave `MEDIA_STORAGE=local` and restart the web service. New installations with no uploads can enable Wasabi directly.

API and HTML links keep their application URLs. Each request checks item visibility and token permissions, then returns a non-cacheable 302 redirect to a signed Wasabi URL. Screenshots load inline; releases download with their original filename. HEAD requests get a HEAD signature and do not increment download counts. GET counts a download link issued, not proof of a completed transfer.

Clients should keep the application URL, follow redirects, and avoid forwarding CPC Hub Authorization headers to Wasabi. A signed URL grants access to its holder until expiry, so hiding an item or revoking a key stops new links but does not cancel a link already issued. Request the application URL again when a signed link expires. The secret access key stays on the server.

## Local Python development

```bash
python3.14 -m venv .venv
.venv/bin/pip install -r requirements.txt
export DEBUG=1
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_demo
.venv/bin/python manage.py runserver
```

SQLite is a local fallback only. Production refuses to start without a PostgreSQL `DATABASE_URL`. A local PostgreSQL URL can also be supplied. Local commands do not automatically load `.env`; Docker Compose does.

## Deploy cpchub.net

The current host uses Cloudflare Tunnel and rootless Podman under the dedicated `cpchub` account. See [the remote deployment guide](docs/deployment.md) for service commands, updates, and database backups. Cloudflared connects to `127.0.0.1:8080`; the app and database have no public ports.

For a host using direct HTTPS with Caddy instead:

1. Point `cpchub.net` and `www.cpchub.net` DNS at your server, allow inbound 80/443, and install Docker + Compose.
2. Set production values in `.env`: `DEBUG=0`, `PUBLIC_URL=https://cpchub.net`, `ALLOWED_HOSTS=cpchub.net,www.cpchub.net,127.0.0.1`, `CSRF_TRUSTED_ORIGINS=https://cpchub.net`, strong secrets, and social-provider credentials.
3. Run `docker compose -f compose.yaml -f compose.production.yaml up --build -d`.
4. Sign in with Steam or Discord, then grant that account staff and superuser permissions from the Django shell. Administrator sign-in also uses the social providers.
5. Confirm `/health/`, social sign-in, profile linking, provider callbacks, and an upload/download. Caddy obtains certificates and redirects `www` to the apex domain. Only Caddy is externally exposed; the database has no published port.

Set `TRUST_PROXY=1` only behind a proxy that replaces forwarded protocol headers (the included production config does this). Apply database migrations once per deployment before serving the new application version; back up the database and upload storage before upgrades. Run `python manage.py cleartokens` regularly to prune expired OAuth records.

The app’s built-in rate limits use a process-local cache. Configure edge rate limits for login, OAuth and uploads before public launch. Native game files remain opaque; ZIP validation checks archive metadata, paths, and declared sizes. Game compatibility and malware scanning require separate checks. Back up the database and upload storage. Keep the Wasabi bucket private and do not serve local media directly from Caddy.

## Social login setup

**Discord:** create an application in the [Discord developer portal](https://discord.com/developers/applications), set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, and register:

```text
https://cpchub.net/accounts/discord/login/callback/
```

For local development, register `http://127.0.0.1:8000/accounts/discord/login/callback/` separately. The requested scope is `identify`; Discord email access is not requested.

**Steam:** obtain a [Steam Web API key](https://steamcommunity.com/dev/apikey) for `cpchub.net`, set `STEAM_API_KEY`, and restart. allauth's Steam provider uses OpenID 2.0; the API key is supplied as both provider client ID and secret as required by its documentation. Steam does not supply email, and CPC Hub does not require one. Users link additional identities from `/account/profile/` while signed in. Matching email addresses do not silently link accounts. Linking an identity already owned by another CPC Hub user is rejected.

Only configured providers appear in the sign-in UI. At least one provider is needed to sign in. Password authentication is disabled on both the public site and Django admin. The first person to register is not automatically an administrator. Complete live provider callback testing after real credentials are installed; local tests do not contact Steam or Discord.

## API and mod managers

- `/api/v1/types/` — discover supported categories and file extensions.
- `/api/v1/items/` — list/search/create draft metadata.
- `/api/v1/items/{id}/` — read or author-only PATCH.
- `/api/v1/items/{id}/releases/` — POST multipart file, unique version, changelog, optional game version.
- `/api/v1/items/{id}/releases/{release_id}/download/` — download the exact version.
- `/api/v1/items/{id}/screenshots/` — POST a screenshot.
- `/api/v1/items/{id}/history/` — author's metadata snapshots (latest 100).
- `/api/v1/me/` — minimal authenticated user identity.
- `/api/v1/keys/` — create/list/revoke scoped keys.
- `/api/schema/`, `/api/docs/`, `/api/redoc/` — schema and API documentation.

Use `Authorization: ApiKey cpc_...` for API keys or `Authorization: Bearer ...` for OAuth. Session-based mutations require CSRF. The API creates drafts first: upload a release, then PATCH `{"status":"published"}`. Release ordering is creation time, so always compare immutable release IDs/checksums; version strings are labels, not necessarily SemVer.

Register a manager as a staff operator:

```bash
DEBUG=1 .venv/bin/python manage.py register_manager "My Manager" \
  http://127.0.0.1:8765/callback --owner YOUR_ADMIN_USERNAME
```

Run the reference desktop flow with the returned public client ID:

```bash
.venv/bin/python examples/connect_manager.py \
  --base-url http://127.0.0.1:8000 --client-id PUBLIC_CLIENT_ID --mint-key
```

The example opens the system browser, validates state, exchanges the PKCE code, reads `/me/`, and optionally creates an API key for the manager. It keeps credentials in memory and prints the new key once. A real manager must store secrets in its OS credential store and handle rotating refresh tokens atomically. Users revoke a manager and all its keys together at `/account/keys/`.

Use the canonical `PUBLIC_URL` as the client base URL; the example also validates the authorization response's issuer. `manage.py check --deploy` intentionally reports the toolkit's HTTP-redirect warning: our validator permits HTTP only for native-app loopback IP callbacks, as required by RFC 8252, while all other callbacks require HTTPS.

Read [the authentication and UI research](docs/decisions.md) for standards, alternatives, and the native-format findings.

## Validation

```bash
DEBUG=1 .venv/bin/python manage.py check
DEBUG=1 .venv/bin/python manage.py collectstatic --noinput
DEBUG=1 .venv/bin/python manage.py test tests
DEBUG=1 .venv/bin/python manage.py spectacular --file docs/openapi.yaml --validate --fail-on-warn
```

Run the same test command with a PostgreSQL `DATABASE_URL` to test the production engine. CI uses PostgreSQL. `docs/openapi.yaml` is the checked-in API contract; regenerate it when the API changes.

Frontend vendor versions and licenses live in `static/vendor/`. `scripts/fetch_vendor.py` refreshes the pinned files; `scripts/create_art.py` regenerates original illustrations.

Validation covers catalog rendering, uploads, version history, screenshot processing, author permissions, API keys, and the OAuth flow. Storage tests check signed links, draft permissions, provider failures, and migration checksums without contacting Wasabi. CI runs against PostgreSQL 17 and checks that the OpenAPI schema matches the source. The local Podman stack has also been checked in Firefox for layout, search, login, file details, and screenshots delivered through Wasabi.
