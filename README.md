# CPC Hub

[CPC Hub](https://cpchub.net) is a community catalog for Car Park Capital blueprints and scenarios, with a Windows 98-style interface.

- Find creations by type, tag, or game-file statistics, and save your favorites.
- Share versioned releases with screenshots, changelogs, and automatic file checks.
- Sign in with Steam or Discord to manage uploads and your creator profile.
- Connect mod managers through the API, scoped API keys, and OAuth with PKCE.

Built with TypeScript, Hono, and Nunjucks on Cloudflare Workers. D1 stores the catalog, R2 stores files and screenshots, and Queues send uploads to private validation Workers.

## Run locally

Set `PUBLIC_URL=http://localhost:8787` in `.dev.vars`, then run:

```sh
npm ci
npm run db:local
npm run dev -- --port 8787
```

Open [localhost:8787](http://localhost:8787).

To check types, run tests, and build templates:

```sh
npm run check && npm test && npm run build
```

[API docs](https://cpchub.net/api/docs/) · [Hosting costs](docs/costs.md) · [Migration notes](docs/deployment-status.md)

Tests require Node.js 22.13+ (Node.js 24 recommended) for the built-in SQLite test database.
`npm test` rebuilds templates and the local API explorer, validates the OpenAPI 3.1 document,
checks every registered API/OAuth operation and schema datatype, and exercises the request
handlers against all SQL migrations. R2, Queues, and cache use test doubles; these tests do
not replace deployed Workers/service integration checks.

API clients should use `Authorization: Bearer <API_KEY_OR_ACCESS_TOKEN>`; the legacy
`ApiKey` and `Api-Key` prefixes remain supported. Tokens are stored as SHA-256 digests;
CSRF and login-state comparisons use constant-time crypto operations, following
[Cloudflare's timing-safe authentication guidance](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
and its supported [Node.js crypto API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
