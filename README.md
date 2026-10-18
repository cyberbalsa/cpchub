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

The homepage and category lists default to most downloaded, with most saved, newest and recently updated sorts available. Advanced searching accepts inclusive `min_collection_count` and `max_collection_count` bounds alongside file statistics. Counts represent people currently saving a creation, not cumulative save actions.

Catalog results load through HTMX from `/catalog/results/` on the initial page visit and on search changes. Item details load their gallery, description, file stats and version history from `/items/:id/content/`. Both page wrappers offer a `?render=full` fallback that embeds the cached HTML for browsing without JavaScript; normal form submissions and pagination also support this fallback. Item headings, permissions, save controls and download-warning preferences remain outside the cache. Cloudflare's Cache API stores rendered HTML for 60 seconds, keyed by search parameters, visibility revision, rendering variant and a hashed session identity for signed-in users. The page wrapper remains request-specific. Browser responses stay `private, no-store`; only the explicit, isolated edge-cache copies get `public, max-age=60`. Warm catalog and item fragments skip content queries: anonymous requests read one revision row; signed-in requests additionally validate the session and account. Migration `0015_collection_cache.sql` invalidates only the saver's personal cache on bookmark changes, while public save/download rankings refresh within a minute. Content and moderation changes still invalidate immediately. No R2 storage is used for fragments.

[API docs](https://cpchub.net/api/docs/) · [Hosting costs](docs/costs.md) · [Migration notes](docs/deployment-status.md) · [Cleanup and input handling](docs/cleanup-audit.md)
