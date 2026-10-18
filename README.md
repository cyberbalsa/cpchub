# CPC Hub

[CPC Hub](https://cpchub.net) is a community catalog for Car Park Capital blueprints and scenarios, with a Windows 98-style interface.

- Find creations by type, tag, or game-file statistics, and save your favorites.
- Share versioned releases with screenshots, changelogs, and automatic file checks.
- Sign in with a passkey, Steam, or Discord to manage uploads and your creator profile.
- Connect mod managers through the API, scoped API keys, and OAuth with PKCE.

Built with TypeScript, Hono, and Nunjucks on Cloudflare Workers. D1 stores the catalog, R2 stores files and screenshots, and Queues send uploads to private validation Workers.

## Run locally

Set `PUBLIC_URL=http://localhost:8787` in `.dev.vars`, then run:

```sh
npm ci
npm run db:local
npm run dev -- --port 8787 --local-upstream localhost:8787
```

Open [localhost:8787](http://localhost:8787).

Passkeys work on HTTPS or localhost. `PUBLIC_URL` must match the browser's exact origin;
its hostname is the WebAuthn relying party ID. Local and production passkeys are separate.
The local upstream flag keeps Wrangler from rewriting the request origin to the production route.
New users choose **Create an account with a passkey**, confirm creation, and enter a public
name. Existing users can add or remove passkeys in account settings. At least one passkey
or linked social account must remain. Add a backup sign-in method before losing access to
a passkey; there is no email/password recovery.

Apply all migrations through `0013_durable_file_cleanup.sql` to the target D1 database before deploying.
Migration 0012 adds public credential storage, an opaque user handle, and expiring, single-use challenges;
0013 adds transactional storage deletion queues, retry tracking, and lease-aware cleanup.
Passkey verification uses [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server);
browser helpers are copied locally during the build to respect the site's CSP.

To build, check strict types, lint, and enforce full runtime test coverage:

```sh
npm run verify
```

[API docs](https://cpchub.net/api/docs/) · [Hosting costs](docs/costs.md) · [Migration notes](docs/deployment-status.md) · [Cleanup and input audit](docs/cleanup-audit.md)

Tests require Node.js 24. `npm test` rebuilds templates, typed browser bundles and the local API explorer, validates the OpenAPI 3.1 document,
checks every registered API/OAuth operation and schema datatype, and exercises the request
handlers against all SQL migrations. R2, Queues, and cache use test doubles; these tests do
not replace deployed Workers/service integration checks.

CI runs `npm run verify` and requires 100% statements, branches, functions and lines **per file**
for authored runtime code in `src/`, `browser/`, and both validation Workers. Generated declarations,
compiled templates, and vendor bundles are excluded; rendered HTML and browser behavior are exercised
through their callers. Reports are in `coverage/index.html` and uploaded as a CI artifact.
Coverage suppression comments, explicit `any`, unsafe operations, and unhandled promises fail lint.
The strict TypeScript checks include unchecked indexing, exact optional properties, exhaustive switches,
and unused declarations. `npm run types:db` regenerates database types from the real SQLite migrations;
CI rejects a stale generated schema.

API clients should use `Authorization: Bearer <API_KEY_OR_ACCESS_TOKEN>`; the legacy
`ApiKey` and `Api-Key` prefixes remain supported. Tokens are stored as SHA-256 digests;
CSRF and login-state comparisons use constant-time crypto operations, following
[Cloudflare's timing-safe authentication guidance](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
and its supported [Node.js crypto API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
