# CPC Hub

A community catalog for **Car Park Capital**, built for **cpchub.net** with Python 3.14, Django 5.2 LTS, HTMX, Bootstrap 5's responsive grid, 98.css, PostgreSQL, and Docker. All browser assets are served locally.

The interface takes its cues from RCT and Car Park Capital: beveled tool buttons, orange and teal window frames, pixel icons, and parchment-colored file panels. Illustrations and interface icons are original SVGs; files from the game installation are not included. Sign-in buttons use [Steam and Discord's official brand assets](static/vendor/brands/README.md).

## Included

- Searchable catalog with categories, sorting, pagination, saved creations, and an author’s uploads.
- Steam and Discord sign-in through django-allauth. Profiles let users link additional accounts and unlink all but their last login. Password login, password resets, and local registration are disabled. Email is not required.
- Author edits with metadata snapshots; versioned files with changelogs, game-version labels, sizes, SHA-256 checksums, and historical downloads. Admins and Moderators can edit other creators’ metadata and add releases or screenshots. Uploaded file bytes are immutable; staff can correct release labels and notes.
- Descriptions and release changelogs accept basic Markdown: bold, italics, lists, quotes, code, small headings, and HTTP(S) links. The API returns the original Markdown. Raw HTML and embedded images are disabled, following [markdown-it-py's security guidance](https://markdown-it-py.readthedocs.io/en/latest/security.html). Off-site links show a destination confirmation, with a full-page fallback for new tabs or browsers without JavaScript.
- Open Graph and large-image social cards for public creations, creator profiles, and the main pages; canonical URLs, descriptions, and JSON-LD describe each page. Shared screenshots use stable public-only application URLs that issue fresh signed Wasabi links. Account pages, drafts, hidden/deleted content, demos, and search/filter combinations are not indexable.
- A daily sitemap snapshot at `/sitemap.xml`, split into `/sitemap-1.xml`, `/sitemap-2.xml`, and further pages of 1,000 URLs. Visibility is checked when serving each page, so moderation changes take effect immediately. See [search and sharing](docs/search-and-sharing.md).
- Website downloads show a fan-content warning. “Don’t show this again” saves a signed one-year browser cookie and a profile preference when signed in. Users can restore the warning from their profile. A confirmation page works without JavaScript; API downloads keep their file/redirect response for mod managers.
- One to eight screenshots per published item; PNG/JPEG/WebP inputs are resized and re-encoded to WebP, with metadata removed.
- Exact tag filtering (`?tag=parking`) and existing-tag suggestions on upload/edit forms. Tags appear publicly at 11 visible, published creations by default; Admins can change this under Moderation → Tag settings. Drafts, hidden/deleted items, shadow-banned authors, and demos do not count. Editing suggestions include uncommon public tags and your own private tags.
- Isolated upload checks in disposable Firecracker VMs, with a dedicated worker user and a private job queue. Creations stay draft until checks pass. Game files default to 15 MiB each (Admin-adjustable); screenshots have separate size and dimension limits. See [upload validation](docs/upload-validation.md) for host setup.
- Decoded file stats on each release: dimensions, footprint, objects, parking bays, entrances, exits, and scenario map/entity counts. Catalog and API filters support inclusive minimum/maximum values against the latest release. Existing native files can be queued for stats without reuploading them.
- Configurable categories and file extensions. Enabled uploads: raw `.cpbp` blueprints and `.cpcs` scenarios only. Blueprint packs, ZIPs, JSON, and other mod uploads are disabled. Existing files remain downloadable. New types/extensions can be added in Django admin; new types start with uploads disabled.
- Uploads limited to 16 creation files or new releases per rolling hour per account, shared across browser sessions, API keys, and OAuth tokens. Admins, Moderators, and Reviewers are exempt. Screenshots do not use slots. Files accepted into the validation queue use a slot even if their checks later fail.
- Drafts visible to the author and staff; file delivery checks the same permissions as the catalog.
- Three staff roles, required hide reasons, front-page highlights, shadow bans, user management, and a private moderation log. Authors can unpublish or self-delete creations, with 14 days to restore them.
- Private Wasabi storage for uploaded releases and screenshots, with five-minute signed download URLs. CSS, JavaScript, fonts, and site artwork stay local.
- Named, hashed API keys with read/write scopes, no expiry by default, optional expiration (1–90 days), revocation, and a one-time secret display.
- Mod-manager sign-in through OAuth authorization code + **S256 PKCE**, explicit consent, 15-minute access tokens, rotating refresh tokens, and optional per-manager API-key creation. Keys cannot create additional keys. OAuth clients cannot grant broader permissions or manage another client’s keys.
- OpenAPI **3.1**, Swagger UI, ReDoc, request/response serializers, multipart upload schemas, authentication scopes, and a consistent API error envelope.
- Django admin, health endpoint, pinned Python dependencies, Docker Compose, and a Caddy HTTPS configuration for cpchub.net.

## Run with Docker

Docker Compose 2.24.4+ is required for the production override's `!reset` syntax.
Install the [host validation worker](docs/upload-validation.md#installation) before starting the app. Uploads stay private if the worker is unavailable. The Docker container UID needs access to the private queue as described there.

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

With Podman and `podman-compose` installed, prepare `.env` as above and install the [host validation worker](docs/upload-validation.md#installation) for your host account, then run:

```bash
podman-compose -f compose.yaml -f compose.podman.yaml up --build -d
```

The site runs at **http://127.0.0.1:8000/**. To rebuild the web service after source changes:

```bash
podman-compose -f compose.yaml -f compose.podman.yaml up --build --force-recreate --no-deps -d web uploads cleanup
```

This replaces the application containers and keeps the database and upload volumes.

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

API and HTML links keep their application URLs. Each request checks item visibility and token permissions, then returns a non-cacheable 302 redirect to a signed Wasabi URL. Screenshots load inline; releases download with their original filename. HEAD requests get a HEAD signature and do not increment download counts. Successful GETs count download links issued, not completed transfers. Both creation and release counters deduplicate by account and IP; a match on either suppresses the count. A new release can receive its first count without increasing the creation’s count again. Account markers persist until the account or creation is purged. IPv4 uses one address; IPv6 uses the /32 subnet, so visitors sharing that subnet share its IP allowance. IP markers expire 14 days after their last download and are removed by the cleanup service. Existing totals stay in place; deduplication starts when this feature is deployed. Repeated downloads still receive fresh signed URLs.

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

Set `TRUST_PROXY=1` only behind a proxy that replaces forwarded protocol and IP headers, and set `TRUSTED_PROXY_CIDRS` to its private subnet plus loopback for container health checks. See [visitor IP and activity setup](docs/deployment.md#visitor-ips-and-account-activity). Apply database migrations once per deployment before serving the new application version; back up the database and upload storage before upgrades. Run `python manage.py cleartokens` regularly to prune expired OAuth records.

The app’s built-in rate limits use a process-local cache. Configure edge rate limits for login, OAuth and uploads before public launch. Native game files receive structural checks inside Firecracker; screenshots are decoded and sanitized there. These checks do not guarantee game compatibility or replace malware scanning. See `docs/upload-validation.md`. Back up the database and upload storage. Keep the Wasabi bucket private and do not serve local media directly from Caddy.

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
- `/api/v1/items/{id}/` — read, PATCH metadata, or DELETE your own creation with a 14-day restoration period.
- `/api/v1/items/{id}/restore/` — POST to restore your self-deleted creation within 14 days.
- `/api/v1/items/{id}/releases/` — POST multipart file, unique version, changelog, optional game version.
- `/api/v1/items/{id}/releases/{release_id}/download/` — download the exact version.
- `/api/v1/items/{id}/screenshots/` — POST a screenshot.
- `/api/v1/items/{id}/history/` — author's metadata snapshots (latest 100).
- `/api/v1/me/` — minimal authenticated user identity.
- `/api/v1/keys/` — create/list/revoke scoped keys.
- `/api/schema/`, `/api/docs/`, `/api/redoc/` — schema and API documentation.

Use `Authorization: ApiKey cpc_...` for API keys or `Authorization: Bearer ...` for OAuth. Session-based mutations require CSRF. The API creates drafts first: upload a release and at least one screenshot, then PATCH `{"status":"published"}`. Release ordering is creation time, so always compare immutable release IDs/checksums; version strings are labels, not necessarily SemVer.

API keys and OAuth tokens keep their owner-only write permissions, even when the owner has a staff role. Admin and Moderator browser sessions can edit other creators’ content. Staff moderation and user management require a browser session and CSRF protection.

## Moderation and deletion

Usernames link to creator profiles at `/creators/<user-id>/`. Visitors see published creations. The creator and staff can also see drafts, hidden creations, and self-deleted uploads. Shadow-banned profiles return 404 to other visitors. Profile links keep working when a username changes. Social login connections and other account settings remain private at `/account/profile/`.

Open `/moderation/` from the toolbar after signing in with a staff account. `/moderation/users/` lets Admins assign roles, rename users, suspend or reactivate accounts, revoke sessions and keys, and purge accounts. The last active Admin cannot be demoted, suspended, or purged.

| Role | Permissions |
| --- | --- |
| Admin | Manage users and roles; edit and add content; hide, restore, highlight, and permanently delete; shadow ban or purge users. |
| Moderator | Edit and add content; hide, restore, and highlight creations; shadow ban members with a private reason. |
| Reviewer | Hide creations with a reason; add or remove front-page highlights. |

An item hide requires a reason visible to visitors on its direct link and to its author in their profile and editor. It removes the item from browsing and highlights and blocks new public download and screenshot links. Authors can edit a hidden creation, but cannot lift the restriction. Moderation actions are recorded with the staff member and time.

All three staff roles can use `/moderation/reviews/` to review published creations, including hidden uploads. Open a creation, check its details and files, then choose **Mark as seen**. An optional note stays private to staff. The review history records who saw each version and when; marking something as seen leaves its visibility unchanged.

Metadata edits, release uploads, screenshot additions or removals, and staff edits or deletions of files return a creation to the queue. Earlier reviews remain in its history. Drafts and self-deleted creations stay out of the queue until published or restored. If the creation changes while a review page is open, staff must reload and check the changes before marking it as seen. Existing uploads start awaiting review when migration 0010 runs.

Shadow bans require a staff-only reason. Existing and future creations are accessible only to the creator and staff, including direct links, downloads, screenshots, and API responses. Public catalog counts and highlights exclude them. Moderators cannot shadow ban staff accounts. Removing a shadow ban also requires a private reason.

Authors can unpublish a creation as a draft or delete it from the editor. Self-deleted creations remain visible only to the creator and staff for 14 days; the creator can restore them from My uploads. Restoring does not lift moderator hides or shadow bans. Repeating deletion does not extend the deadline. The cleanup service permanently deletes expired creations and their files every five minutes.

Admin purges require the exact account name and a staff-only reason. They remove the user, their creations and stored files, social logins, API/OAuth access, bookmarks, sessions, and authored edit/moderation history. One staff-only purge record remains with the target username and reason. Other users’ creations are retained. Database backups keep their existing 14-day retention; they are not rewritten by a purge.

File deletion runs after the database transaction commits. A durable queue retains failed storage deletions for automatic retry. Docker Compose runs the `cleanup` service; the dedicated host uses `cpchub-cleanup.timer`. To run it manually, use `python manage.py cleanup_deleted_files`. The current Wasabi bucket has never had versioning enabled, so deleting an object removes its stored bytes rather than creating a versioned delete marker. If enabling bucket versioning later, extend cleanup to purge object versions first.

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
