import type { MiddlewareHandler } from "hono";
import { App, one } from "./env";
const publicPath =
  /^\/api\/v1\/(?:items\/(?:[0-9a-f-]+\/)?|types\/(?:[a-z-]+\/)?|tags\/)$/;
const allowed = new Set([
  "page",
  "q",
  "type",
  "sort",
  "tag",
  "mine",
  "view",
  "author",
  ...[
    "width",
    "depth",
    "height",
    "footprint_tiles",
    "objects",
    "object_types",
    "parking_spaces",
    "golf_cart_spaces",
    "entrances",
    "exits",
    "maps",
    "entities",
    "format_version",
  ].flatMap((k) => ["min_" + k, "max_" + k]),
]);
export const edgeCache: MiddlewareHandler<App> = async (c, next) => {
  const url = new URL(c.req.url);
  if (
    c.req.method !== "GET" ||
    c.req.header("Authorization") ||
    /(?:^|;\s*)cpc_session=/.test(c.req.header("Cookie") || "") ||
    c.get("user") ||
    !publicPath.test(url.pathname) ||
    url.search.length > 1000 ||
    [...url.searchParams.keys()].some((k) => !allowed.has(k)) ||
    url.searchParams.get("mine") === "true" ||
    ["mine", "saved"].includes(url.searchParams.get("view") || "")
  ) {
    await next();
    c.header("Cache-Control", "private, no-store");
    c.header("X-Cache", "BYPASS");
    return;
  }
  // One indexed row read maintains immediate privacy invalidation across every PoP.
  const revision = await one(
    c.env.DB,
    "SELECT revision FROM worker_cache_revision WHERE id=1",
  );
  url.searchParams.sort();
  url.searchParams.set("__revision", String(revision?.revision || 0));
  // A new presentation policy must never reuse an older unfiltered response.
  url.searchParams.set("__text_filter", "hearts-v1");
  url.searchParams.set("__tag_categories", "v1");
  const key = new Request(url.href, { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Cache", "HIT");
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    c.res = new Response(hit.body, { status: hit.status, headers });
    return;
  }
  await next();
  c.header("X-Cache", "MISS");
  if (c.res.status === 200 && !c.res.headers.has("Set-Cookie")) {
    const headers = new Headers(c.res.headers);
    headers.set("Cache-Control", "public, max-age=60");
    headers.delete("X-Cache");
    c.executionCtx.waitUntil(
      cache.put(
        key,
        new Response(c.res.clone().body, { status: 200, headers }),
      ),
    );
    c.header("Cache-Control", "public, max-age=0, must-revalidate");
  } else c.header("Cache-Control", "private, no-store");
};
