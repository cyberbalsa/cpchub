# CPC Hub

[CPC Hub](https://cpchub.net) is a community catalog for Car Park Capital blueprints and scenarios. Share creations, save favorites, and connect mod managers through the API.

Built with TypeScript on Cloudflare Workers, D1, R2, and Queues.

## Development

Use Node.js 24. Set `PUBLIC_URL=http://localhost:8787` in `.dev.vars`, then run:

```sh
npm ci
npm run db:local
npm run dev -- --port 8787 --local-upstream localhost:8787
```

Run `npm run verify` for type checks, lint, and tests. CI requires 100% coverage for authored runtime code across the site and both validators.

The catalog includes 48 curated category tags for blueprints, scenarios, and themes, seeded by `0014_category_tags.sql`. Categories stay visible and suggested at zero uses; community tags still follow the moderation threshold. The seed is based on the game's build catalog, shipped blueprints and scenarios, scenario-editor objectives, and local saved creations. The migration records the research sources and preserves existing tag assignments. Apply it with `npm run db:local` for development, or `npx wrangler d1 migrations apply cpc-hub-catalog --remote` before deploying the updated Worker.

[API docs](https://cpchub.net/api/docs/) · [Hosting costs](docs/costs.md) · [Migration notes](docs/deployment-status.md) · [Cleanup and input handling](docs/cleanup-audit.md)
