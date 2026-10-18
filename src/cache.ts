import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { NUMERIC_FILTERS } from "./catalog";
import { App, hash, one } from "./env";
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
  ...NUMERIC_FILTERS.flatMap((k) => ["min_" + k, "max_" + k]),
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
  url.searchParams.set("__catalog", "popularity-v1");
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

// Page wrappers stay request-specific. Rendered fragments have separate entries
// for each authenticated session, content/visibility revision and HTML variant.
export async function cachedFragment(
  c: Context<App>,
  url: URL,
  load: () => Promise<Response>,
) {
  const user = c.get("user");
  if (!user && getCookie(c, "cpc_session")) {
    const response = await load();
    response.headers.set("X-Cache", "BYPASS");
    return response;
  }
  const revision = await one<{ revision: number; collection_revision: number }>(
    c.env.DB,
    "SELECT revision,COALESCE((SELECT revision FROM worker_collection_revision WHERE user_id=?),0) collection_revision FROM worker_cache_revision WHERE id=1",
    user?.id || -1,
  );
  url.searchParams.sort();
  url.searchParams.set("__revision", String(revision?.revision || 0));
  if (user) {
    url.searchParams.set(
      "__session",
      await hash(
        JSON.stringify([
          getCookie(c, "cpc_session"),
          user.id,
          user.role,
          user.csrf,
        ]),
      ),
    );
    url.searchParams.set(
      "__collections",
      String(revision?.collection_revision || 0),
    );
  }
  const key = new Request(url.href),
    cache = caches.default,
    hit = await cache.match(key);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set("X-Cache", "HIT");
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const response = await load();
  if (response.status === 200 && !response.headers.has("Set-Cookie")) {
    const cached = new Response(response.clone().body, response);
    cached.headers.set("Cache-Control", "public, max-age=60");
    c.executionCtx.waitUntil(cache.put(key, cached));
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Cache", "MISS");
  return response;
}

export async function cachedCatalogFragment(
  c: Context<App>,
  params: URLSearchParams,
  oob: boolean,
  load: () => Promise<Response>,
) {
  if (
    params.toString().length > 1000 ||
    [...params.keys()].some((k) => !allowed.has(k))
  ) {
    const response = await load();
    response.headers.set("X-Cache", "BYPASS");
    return response;
  }
  const url = new URL("/catalog/results/", c.req.url);
  url.search = params.toString();
  url.searchParams.set("__fragment", oob ? "oob-v1" : "inline-v1");
  return cachedFragment(c, url, load);
}
