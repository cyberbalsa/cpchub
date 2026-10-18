# Migration verification — 18 October 2026 UTC

Production: https://cpchub.net

Main Worker version: `c4a77ce9-7750-4095-b17a-102d86740d9f`.
Native validator version: `84f7cd07-1bdb-4c44-b94c-f59b84668869`.
Image validator version: `87cec68b-0d17-4b27-a12a-2fdb174cbefc`.

These versions and checks describe the migration baseline. The subsequent [Pro hardening and authenticated rate-limit rollout](cloudflare-pro.md) deployed main Worker version `b117ef83-38d2-4ed4-b29e-bf214e3a5db2` and records the later zone policy.

The production database, exported over SSH from `cpchub-app`, supplied four accounts, four creations, four release files, and eight screenshots. Balsa (ID 4) retains Admin and both social-provider links. No development admin or synthetic test accounts remain in production. Usable passwords were stripped during export and password authentication code was removed.

Verification completed:

- TypeScript check, template build, and eight validator/billing tests.
- Local Worker integration: native/image validation, publication, immediate cache invalidation, scoped API keys, author boundaries, downloads, self-delete/restore, and page rendering.
- Local security integration: CSRF, cross-origin protection, browser/admin boundaries, API-key prohibition on account-linking routes, PKCE verifier rejection, code replay rejection, refresh rotation, and revocation.
- Deployed queue/upload test using the actual Tron file: both private validators passed, resulting file remained private, download byte length matched. Temporary test accounts and stored objects were removed.
- Live-domain smoke checks: catalog, account/profile, keys, moderation, Balsa user management, admin-only activity, site settings, all four release HEAD responses, and all eight public screenshot URLs.
- Live anonymous API MISS → HIT; authenticated response BYPASS; uncached download HEAD.
- Steam and Discord initiation redirects point to the correct provider and `https://cpchub.net` callback. Full interactive provider sign-in was not automated.
- Billing-only secret fetched the current account invoice total, displayed as Monthly Costs: $41.86 for October 2026.
- Main catalog CSS SHA-256 matches the source exactly. Browser-based visual inspection was unavailable in the session; HTML routes and assets were checked over HTTP.
- Source snapshot imported into an in-memory SQLite database with all migrations; foreign-key verification and full user-deletion cascade passed. Remote foreign-key check also passed.

The live zone's existing browser challenges remain enabled. The preconfigured private automated-test User-Agent was used only on the site's own protected routes, without changing WAF policy. Public API caching was also verified with a normal curl User-Agent.

Source ingress, upload collector, cleanup, sitemap, and storage-usage writers were stopped for final export. Source application/database containers, original R2 bucket, tunnel/DNS, and backups remain for rollback. Retaining the old VM means its existing hosting cost continues until separately retired. Do not rerun the pre-cutover import now that the Worker can accept new writes.
