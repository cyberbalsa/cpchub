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
