# Implementation decisions and research

Research date: 2026-10-16. This is an independent fan project for Car Park Capital, hosted at `cpchub.net` when deployed. The supplied local game assets were inspected read-only; they are not included in the source tree or Docker image.

## UI library choice

| Library | Findings | Decision |
| --- | --- | --- |
| [98.css](https://98css.jdan.vercel.app/) | CSS-only Windows 98 components using semantic HTML; no frontend framework dependency. | Use for windows, title bars, controls and beveled surfaces. Vendor version 0.1.21 with fonts and license. |
| [Bootstrap 5 grid](https://getbootstrap.com/docs/5.3/layout/grid/) | Responsive layout independent of the Bootstrap component appearance. | Use the grid-only distribution, version 5.3.8, to avoid conflicting button/input resets. |
| [Windows 95 UI Kit](https://github.com/themesberg/windows-95-ui-kit) | Bootstrap-based retro theme using Bootstrap 4. | Useful reference; a less direct fit for Windows 98 and a current Bootstrap grid. |
| [OS-GUI.js](https://os-gui.js.org/) | Windows 98 desktop-style menus and movable windows. | More desktop behavior than this catalog needs. Avoid draggable windows on mobile. |

[HTMX](https://htmx.org/docs/) handles search, filtering, pagination and saving. Standard links and forms also work without JavaScript. Django renders the pages and fragments.

The visual design draws from RCT's construction menus and Car Park Capital's UI palette. The game's HUD scripts use asphalt gray, orange, and teal; the catalog adds sand-colored panels, raised controls, recessed previews, and a fixed status bar. 98.css supplies the base controls and pixel font. All icons, terrain textures, and isometric illustrations are original SVGs. The game files were used as a color reference only.

## Authentication and mod-manager access

[django-allauth](https://docs.allauth.org/en/latest/socialaccount/introduction.html) supports ordinary accounts and explicitly linking social identities. Its [Steam provider](https://docs.allauth.org/en/dev/socialaccount/providers/steam.html) uses OpenID and requires the Steam Web API key in both provider credential fields. Its [Discord provider](https://docs.allauth.org/en/latest/socialaccount/providers/discord.html) requires a registered callback URL. Provider configuration uses environment variables rather than secrets committed to source.

The recommended desktop-manager flow is **authorization code with S256 PKCE in the system browser**. [RFC 8252](https://www.rfc-editor.org/info/rfc8252/) recommends an external browser and requires PKCE for public native clients. This lets a user choose normal credentials, Steam or Discord at CPC Hub without handing their password to a manager. Public native apps do not have a meaningful embedded client secret.

[Django OAuth Toolkit](https://django-oauth-toolkit.readthedocs.io/en/latest/tutorial/tutorial_01.html) provides protocol endpoints, consent, tokens, and DRF integration. Its [settings documentation](https://django-oauth-toolkit.readthedocs.io/en/latest/settings.html) covers PKCE, short-lived tokens, rotating refresh tokens, token-reuse protection, and hashed token storage. Version 3.4.1 is pinned and tested with these options. An explicit authorization-view check rejects missing or plain PKCE before consent; a validator limits grants to authorization code/refresh and restricts insecure redirect URLs to loopback IP addresses. Callback matching remains the toolkit's job. Client registration is staff-controlled, and consent is not skipped.

| Method | Intended use |
| --- | --- |
| Browser OAuth + PKCE | Default for desktop mod managers. Short-lived access tokens and rotating refresh tokens. |
| Scoped personal API key | Scripts, manual integration, or managers that need a stable credential. A manager can create its own key after `keys:write` consent. |
| Device authorization grant | A possible future option for devices/CLIs with awkward callbacks. Not exposed in this implementation. |
| Username/password grant or embedded login webview | Not used. A manager should not collect the user's CPC Hub or provider password. |

API keys have a public lookup prefix and 256 bits of random secret material. Only a SHA-256 digest is stored, compared in constant time; because the secret is high entropy this differs from hashing a human password. The secret is returned once in the response body, never in a URL. Keys do not expire by default. Clients can omit `days` or send `null`; a value from 1 to 90 adds an expiry. Existing expiry dates are preserved. All keys can be revoked, and keys cannot create other keys. OAuth clients can create only a subset of their approved read/write scopes and can list/revoke only keys bound to their client. A browser user can revoke everything for a manager. Responses containing credentials are marked `no-store`.

The chosen scopes are `read`, `write`, and OAuth-only `keys:write`. Email verification is disabled in every environment, as requested by the site owner. Users can sign in, publish, and create keys without verification; Steam users supply their email during signup with no confirmation step. Provider-email matching never silently links accounts. Token storage and session security are separate: browser sessions use HTTP-only secure cookies and CSRF, while API clients send an Authorization header.

## Strong API contract

[Django REST Framework](https://www.django-rest-framework.org/api-guide/serializers/) serializers validate payloads. [drf-spectacular](https://drf-spectacular.readthedocs.io/en/stable/readme.html) produces OpenAPI 3.1 with separate multipart request/file responses, explicit scopes, pagination, types, enums, UUID paths, error envelopes, and downloadable binaries. A project extension documents the custom API-key scheme and the required OAuth scope per operation. The schema is validated without warnings and committed at `docs/openapi.yaml`; CI detects drift.

## Game file inspection and extensibility

Observed in the local Car Park Capital installation's `assets/` directory:

- `blueprints/**` contains `.cpbp` files, including `small_parking_garages/bubble_garage.cpbp`.
- `scenarios/` contains `.cpcs` files, including `Florida.cpcs`, `City.cpcs`, and `Egypt.cpcs`.
- A scenario sample begins with zlib-compressed binary data; a bounded exploratory decode showed structured binary content, not plain JSON.
- Blueprint samples have a different binary header. The exact format is not assumed or reverse-engineered for server validation.
- `default_level.lvl` exists, but is not enabled by default because its suitability as a shared user export has not been established. An operator can add it to a relevant category later.

The files are stored unchanged, with original download names, byte counts and SHA-256. This supports ZIP packs, raw scenarios and future mods without introducing guessed parsers. Category definitions in the database decide accepted extensions; `/api/v1/types/` is the discoverable contract. Blueprint packs accept both native file formats as well as ZIP/JSON. Only blueprints, blueprint packs, and scenarios currently accept uploads. The other-mod category and new categories have uploads disabled until an administrator enables them.

ZIP metadata is checked for traversal, absolute paths, symlinks, encryption, excessive entry counts, excessive declared expanded size and compression ratios. Archives are never extracted or executed. Native binary validation, antivirus scanning and game compatibility checking are not implemented. The mod manager must inspect archive paths again before installation, avoid writing outside its chosen game-content directory, and verify downloads against the returned checksum. Screenshots are decoded, pixel-limited, resized and re-encoded to remove metadata and active payloads.

## Author edits and versioning

An item is stable metadata with a UUID. Each author edit records a metadata snapshot. Releases are append-only and have unique version labels per item; duplicate versions cannot replace older files. Downloads address a release UUID. New releases update the item's modification time; metadata edits do not mutate release content. An author can unpublish an item to hide all its release files and screenshots from other users. The API starts items as drafts and requires a release and at least two screenshots before publishing. The web form accepts the first release and two to eight screenshots together. Published creations must keep at least two screenshots; add a replacement or save as a draft before removing one of the last two.

Screenshot removal is an author action; previous screenshots are not retained as part of metadata snapshots. Administrators retain moderation ability. Metadata history shows snapshots, not a one-click rollback UI.

## Deployment boundary

Docker Compose runs PostgreSQL 17, a one-shot migration service, and Gunicorn. The production override adds Caddy with HTTPS for cpchub.net and removes the published application port. Static assets are served by WhiteNoise. The Python/Django/PostgreSQL stack uses container deployment.

## Private upload storage

Uploaded releases and screenshots use [django-storages' S3 backend](https://django-storages.readthedocs.io/en/latest/backends/amazon-S3.html), configured for the bucket's [Wasabi regional endpoint](https://docs.wasabi.com/docs/service-urls-for-wasabis-storage-regions). Site artwork, CSS, JavaScript, and fonts stay local. All upload types share the same release storage path, so future mod categories use Wasabi without a new backend.

The application uses its own IAM user. Its policy permits access to `ugc/releases/*` and `ugc/screenshots/*` in the configured bucket, plus bucket listing and region lookup. Listing is needed for S3 to distinguish missing objects from access-denied responses. Root keys are used only by the provisioning script against [Wasabi's IAM endpoint](https://docs.wasabi.com/docs/service-url-endpoints); they are excluded from Git and container images.

File endpoints check catalog visibility and API scopes before returning a 302 redirect to a five-minute [Signature V4 presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html). This keeps expiring URLs out of catalog metadata and gives lazy-loaded screenshots a fresh link on demand. Downloads retain the original filename through a signed Content-Disposition override. Both redirects and object responses use `private, no-store`.

Presigned URLs remain usable until expiry even after an item is hidden or a manager key is revoked. Clients must request a fresh URL through CPC Hub and must not forward CPC Hub credentials across the redirect. Download counters record GET links issued, while HEAD requests leave counts unchanged. Missing objects return 404; provider failures return 503 without provider diagnostics.

The migration command copies only files referenced by releases and screenshots, verifies their checksums, and leaves the local source intact. It never uploads site assets. Database backups and a separate object-backup/retention policy are still required; release history does not protect against bucket deletion.

Real provider sign-ins, DNS, SMTP and public TLS require operator credentials/infrastructure. Local integration tests cover OAuth consent/code exchange/refresh/key issuance; they do not assert that external Steam or Discord configuration is already working.
