# CPC Hub

A community catalog for **Car Park Capital**, built for **cpchub.net** with Python 3.14, Django 5.2 LTS, HTMX, Bootstrap 5's responsive grid, 98.css, PostgreSQL, and Docker. All browser assets are served locally.

The interface takes its cues from RCT and Car Park Capital: beveled tool buttons, orange and teal window frames, pixel icons, a town viewport, and parchment-colored file panels. The illustrations and icons are original SVGs; game assets are not included.

## Included

- Searchable catalog with categories, sorting, pagination, saved creations, and an author’s uploads.
- Regular accounts, password reset, and Steam/Discord login and account linking through django-allauth. Email verification is disabled; accounts can sign in, publish, and create API keys immediately.
- Author-only edits with metadata snapshots; immutable versioned releases with changelogs, game-version labels, sizes, SHA-256 checksums, and historical downloads.
- Up to eight screenshots per item; PNG/JPEG/WebP inputs are resized and re-encoded to WebP, with metadata removed.
- Configurable categories and file extensions. Initial types: blueprints, blueprint packs, scenarios, and other mods. Accepts native `.cpbp`/`.cpcs`, ZIPs, and JSON as appropriate. ZIPs are stored without extracting their contents. New types/extensions can be added in Django admin.
- Drafts visible only to the author; authenticated file delivery checks the same permissions as the catalog.
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
docker compose exec web python manage.py createsuperuser
```

Open **http://127.0.0.1:8000/**. The database and uploads use named persistent volumes. Migrations run in a one-shot service before the web service starts. No admin account or demo data is created automatically.

Optional illustrative catalog:

```bash
docker compose exec web python manage.py seed_demo
```

Demo listings are labeled, have an inactive author, and contain sample JSON, **not playable game exports**. Their illustrations are original SVGs, not redistributed game assets. Production should start with a clean database or remove these demo listings through admin.

## Run with Podman

With Podman and `podman-compose` installed, prepare `.env` as above, then run:

```bash
podman-compose -f compose.yaml up --build -d
podman-compose -f compose.yaml exec web python manage.py createsuperuser
```

The site runs at **http://127.0.0.1:8000/**. To rebuild the web service after source changes:

```bash
podman-compose -f compose.yaml up --build --force-recreate --no-deps -d web
```

This replaces the web container and keeps the database and upload volumes.

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

1. Point `cpchub.net` and `www.cpchub.net` DNS at your server, allow inbound 80/443, and install Docker + Compose.
2. Set production values in `.env`: `DEBUG=0`, `PUBLIC_URL=https://cpchub.net`, `ALLOWED_HOSTS=cpchub.net,www.cpchub.net,127.0.0.1`, `CSRF_TRUSTED_ORIGINS=https://cpchub.net`, strong secrets, SMTP for password resets, and social-provider credentials.
3. Run `docker compose -f compose.yaml -f compose.production.yaml up --build -d`.
4. Create an admin using the same Compose files with `exec web python manage.py createsuperuser`.
5. Confirm `/health/`, registration/login, password-reset email delivery, provider callbacks, and an upload/download. Caddy obtains certificates and redirects `www` to the apex domain. Only Caddy is externally exposed; the database has no published port.

Set `TRUST_PROXY=1` only behind a proxy that replaces forwarded protocol headers (the included production config does this). Apply database migrations once per deployment before serving the new application version; back up the database and media volume before upgrades. Run `python manage.py cleartokens` regularly to prune expired OAuth records.

The app’s built-in rate limits use a process-local cache and are **not a global abuse quota**. Before a public launch, configure edge rate limits for login, OAuth and uploads; decide upload moderation/malware-scanning policy and storage quotas. Native game files remain opaque, ZIP validation checks archive metadata/paths/declared sizes, and this implementation does not certify content as safe or game-compatible. Configure reliable backups for both database and uploads. Do not serve the private media volume directly from Caddy/CDN.

## Social login setup

**Discord:** create an application in the [Discord developer portal](https://discord.com/developers/applications), set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, and register:

```text
https://cpchub.net/accounts/discord/login/callback/
```

For local development, register `http://127.0.0.1:8000/accounts/discord/login/callback/` separately. Requested scopes are `identify email`.

**Steam:** obtain a [Steam Web API key](https://steamcommunity.com/dev/apikey) for `cpchub.net`, set `STEAM_API_KEY`, and restart. allauth's Steam provider uses OpenID 2.0; the API key is supplied as both provider client ID and secret as required by its documentation. Steam does not supply email: users enter one during signup, with no verification step. Local and social identities are connected explicitly from `/accounts/3rdparty/`; matching email addresses do not silently link accounts.

Unconfigured providers are disabled in the sign-in UI. Complete live provider callback testing after real credentials are installed; local tests do not contact Steam or Discord.

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
DEBUG=1 .venv/bin/python manage.py test tests
DEBUG=1 .venv/bin/python manage.py spectacular --file docs/openapi.yaml --validate --fail-on-warn
DEBUG=1 .venv/bin/python manage.py collectstatic --noinput
```

Run the same test command with a PostgreSQL `DATABASE_URL` to test the production engine. CI uses PostgreSQL. `docs/openapi.yaml` is the checked-in API contract; regenerate it when the API changes.

Frontend vendor versions and licenses live in `static/vendor/`. `scripts/fetch_vendor.py` refreshes the pinned files; `scripts/create_art.py` regenerates original illustrations.

Validation covers catalog rendering, uploads, version history, screenshot processing, author permissions, API keys, and the OAuth flow. CI runs against PostgreSQL 17 and checks that the OpenAPI schema matches the source. The local Podman stack has also been checked in Firefox for layout, search, login, and file-detail navigation.
