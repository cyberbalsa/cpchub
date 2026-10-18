# CPC Hub on Cloudflare

TypeScript migration of the Django CPC Hub, retaining its templates, CSS, catalog, upload editor, profiles, manager API, and moderation pages. Production data comes from `ssh cpchub`, **not** the local development containers or `db.sqlite3`.

Live at https://cpchub.net, cut over 18 October 2026 UTC. The main Worker uses the `cpchub.net/*` route; workers.dev and preview URLs are disabled. All four production users, four creations/releases, and eight screenshots were imported. The old server’s ingress and background writers are stopped; its data and original bucket remain for rollback.

The active codebase is maintained in this repository’s `main` branch. The former Django implementation and deployment notes are preserved on [`dead-code`](https://github.com/cyberbalsa/cpchub/tree/dead-code).

## Runtime

- `cpc-hub-serverless`: Hono app, compiled Nunjucks templates, static assets, API, social sign-in, download counting, moderation, and scheduled cleanup/billing.
- `cpc-hub-validator`: private service-bound Worker, streaming native blueprint/scenario validation and statistics. No database, bucket, or account credentials.
- `cpc-hub-image-validator`: private service-bound Worker using the Images binding to inspect and re-encode static PNG/JPEG/WebP screenshots. No storage or account credentials.
- D1 `cpc-hub-catalog`: catalog metadata, accounts, sessions, scopes, counters, audit history, queue outbox, and billing total.
- Private R2 `cpc-hub-files`: approved game files. Private R2 `cpc-hub-quarantine`: incoming files, with one-day expiration.
- Public R2 `cpc-hub-public-screenshots`: direct delivery through `screenshots.cpchub.net`. Object names are random UUIDv4 + `-` + the last 16 SHA-512 hex characters + `.webp`.
- Queues deliver validation work, with retries, leases, a dead-letter queue, and a D1 outbox recovered by the five-minute cron.

The application never holds the Cloudflare admin token. Its only Cloudflare API credential is a non-expiring **Billing Read** token held as a Worker secret. Steam/Discord secrets are also Worker secrets.

## Caching and cost choices

Anonymous successful catalog, item, tag, and type API responses use the Workers Cache API for 60 seconds. A single indexed D1 revision read per request prevents previously cached private/hidden/deleted content from being served after moderation or publication changes. Authenticated requests bypass this cache. Cache hits still invoke the app Worker, but skip catalog assembly and its database queries. Static assets use Workers Static Assets delivery.

Downloads always go through the app Worker and private R2 so counting and visibility checks run. HEAD requests do not count. Downloads deduplicate by account and IPv4/IPv6 /32 network; network records expire after 14 days. Screenshots go directly to R2's custom-domain CDN, outside the app Worker.

Public screenshots are bearer links: **anyone who has a URL can fetch it**, including draft images and images from subsequently hidden items. There is no bucket listing endpoint. Random names prevent practical enumeration; they are not authentication. Deleting an image removes the R2 object, but an existing CDN copy may remain for up to one day. This is the public-link model requested for this migration.

Pricing was checked against Cloudflare documentation on 17 October 2026. Workers Paid is account-wide, so this project shares existing allowances rather than adding a server subscription. At modest traffic, incremental cost can fit inside those allowances; this is not a guarantee of a zero bill. See [docs/costs.md](docs/costs.md) for rates and examples.

## Validation limits

The measured Tron file has SHA-256 `2962085be81234eb4018e342e38200c58021a3c44d238c7bdf83b5dae9e1ac03`, 556,944 compressed bytes, 81,940,241 expanded bytes, 5,918,463 metadata bytes, and 1,104,164 CBOR nodes. [docs/tron-baseline.json](docs/tron-baseline.json) records these inputs.

The validator rejects inputs exceeding twice Tron's expanded size (163,880,482 bytes), metadata size (11,836,926 bytes), or node count (2,208,328). Nesting is capped at 32. Expansion is streamed and counted; the expanded file is never allocated as a single buffer. The platform's 128 MiB isolate memory limit still applies. These are explicit structural/allocation limits derived from Tron, **not a configurable 156 MiB Worker heap**. CPU is capped at 12 seconds for native validation and 1 second for the app/image Worker.

Screenshots are limited to 10 MiB input, 20 million pixels, dimensions from 320×180 up to 8192 per side, and aspect ratio 1:6–6:1. Animated files are rejected. Outputs fit within 1920×1080, WebP quality 88, at most 8 MiB. Files stream into R2 using 5 MiB multipart buffers. Request metadata is limited to 64 KiB; a multipart request is limited to 100 MiB, subject also to the zone's HTTP upload limit. File-size settings may impose a lower limit.

## Authentication and administrators

Steam and Discord only. There is no password login, reset, or local signup. Imported password fields are set to Django's unusable marker. Balsa's production user ID 4, Admin role, and existing Steam/Discord links are preserved. The development-only `admin` account is not imported.

Browser sessions last 30 days and require CSRF for mutations. Legacy API-key digests/scopes/expiry remain supported. Manager clients use authorization-code OAuth with S256 PKCE, one-use codes, and rotating refresh tokens. Old Django browser sessions and old OAuth tokens are not accepted: sign in again / reconnect the manager. API keys remain valid.

Admins register manager clients and edit supported file-type settings at `/admin/settings`. Moderation retains account roles, shadow bans, reviews, hide/restore, highlighting, file metadata/deletion, upload/tag limits, and 14-day account activity. Balsa signs in through the normal social login page to access these controls.

## Monthly Costs

The website displays one label: **Monthly Costs**. A scheduled refresh reads the entire Cloudflare account's billing history every six hours, sums current-calendar-month USD invoices once, and caches only the total in D1. It excludes payments and void/draft invoices. The display is an invoiced account total, including other services and domain purchases billed that month; it is not a live unbilled usage estimate or an amortized recurring-cost projection. Failed refreshes retain the previous total, displayed for at most three days before `Unavailable`. Admins can request a refresh in Site settings.

## Develop and verify

```sh
npm ci
npm run build
npm run check
npm test
npm run db:local
npm run dev -- --port 8787
```

`npm run dev` starts the app and both private validators with local bindings. `.dev.vars` can override `PUBLIC_URL=http://localhost:8787`; never commit secrets. In a second terminal, `python scripts/seed-local.py` creates local-only test identities. `npx tsx scripts/integration.ts` tests publication, validation queues, cache invalidation, and API scopes; it currently uses the local Tron file and `/tmp/cpc-test-image.png`. `npx tsx scripts/security-integration.ts` tests CSRF, admin authorization, and OAuth replay/rotation. These test sessions are never installed in remote D1.

`npx wrangler types src/worker-bindings.d.ts --env-interface CloudflareBindings --include-runtime false --strict-vars false` regenerates app binding types after config changes.

## Deployment and migration operations

Use project-local Wrangler. The profile credential is in `~/.config/cloudflare/credentials.env`; source that file in non-interactive shells if necessary. Never put it in `.dev.vars` or Worker secrets. `scripts/cloudflare.py` is a local provisioning helper and does not ship in a Worker.

```sh
. ~/.config/cloudflare/credentials.env
npm run check && npm test && npm run build
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply cpc-hub-catalog --remote
npx wrangler deploy -c workers/validator/wrangler.jsonc
npx wrangler deploy -c workers/images/wrangler.jsonc
npx wrangler deploy
```

On first deployment, pass `--secrets-file .env.worker-secrets.json` containing `DISCORD_CLIENT_SECRET`, `STEAM_API_KEY`, and `CF_BILLING_TOKEN`. That file must be mode 0600 and ignored. Subsequent deployments retain the installed secrets.

For a new production snapshot, export over SSH with the source Django runtime. Redirect stdout into private files: it contains user/account records. `scripts/export-django.py` opens a read-only repeatable-read transaction and strips usable passwords. `scripts/export-files.py` verifies release SHA-256 and byte lengths. Prepare `migration-data/production.sql` and `migration-data/production-files.tar.gz`, then run `python scripts/import-production.py`. **This replaces target records; do not run it after accepting new writes on Workers.** It validates foreign keys locally before modifying D1 and restores upload guards after import. Screenshot mappings persist in `migration-data/screenshot-keys.json` to keep URLs stable across repeated pre-cutover copies.

For final cutover, stop production writes and background upload/cleanup processes, take a fresh source snapshot, repeat the verified import, then install the `cpchub.net/*` Worker route. Preserve the original tunnel/DNS and source database for recovery. Leave the API/download Cache Rule bypass in place: the Worker explicitly owns API cache policy, and downloads must never be cached or converted from HEAD to GET by a generic cache rule.

Rollback before new Worker writes can remove the Worker route and resume the previous app. **After new writes, routing back alone loses new uploads/accounts/changes**: reconcile D1 and R2 back into the source database first. D1 Time Travel protects database state; it does not roll back R2 files. Retain source backups and avoid deleting the original R2 bucket during migration.
