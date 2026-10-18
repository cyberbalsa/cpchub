import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { DomUtils, parseDocument } from "htmlparser2";
import { fixture } from "./helpers/app";
import { staffFixture } from "./helpers/staff";
import { cachedCatalogHTML } from "../src/cache";
import { hash, uuid, type App } from "../src/env";

import { fragmentCache } from "./helpers/cache";

void test("cached HTMX results isolate sessions, skip catalog queries and work inside the page wrapper", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  const draft = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
    status: "draft",
    title: "Author draft",
  });
  for (const [token, user, csrf] of [
    ["second-session", 2, "second-csrf"],
    ["another-session", 1, "another-csrf"],
  ] as const)
    f.insert("worker_session", {
      digest: await hash(token),
      user_id: user,
      csrf,
      expires_at: Date.now() + 60000,
    });
  const { entries } = fragmentCache(t);
  const queries: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  const path =
    "/catalog/results/?sort=saved&type=blueprints&min_collection_count=0";
  const first = await f.request(path, "GET", undefined, "anonymous");
  assert.equal(first.headers.get("X-Cache"), "MISS");
  assert.equal(first.headers.get("Set-Cookie"), null);
  assert(!(await first.text()).includes(draft.title));
  queries.length = 0;
  const hit = await f.request(
    "/catalog/results/?min_collection_count=0&type=blueprints&sort=saved",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(hit.headers.get("X-Cache"), "HIT");
  assert.equal(hit.headers.get("Cache-Control"), "private, no-store");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /FROM worker_cache_revision/);
  const own = await f.request(path);
  assert.equal(own.headers.get("X-Cache"), "MISS");
  assert((await own.text()).includes(draft.title));
  queries.length = 0;
  const ownHit = await f.request(path);
  assert.equal(ownHit.headers.get("X-Cache"), "HIT");
  assert.equal(ownHit.headers.get("Cache-Control"), "private, no-store");
  assert.equal(
    queries.length,
    3,
    "Only session, account and revision reads remain",
  );
  assert(
    queries.every((sql) =>
      /FROM worker_session|FROM auth_user u|FROM worker_cache_revision/.test(
        sql,
      ),
    ),
  );
  const other = await f.rawRequest(path, {
    headers: { Cookie: "cpc_session=second-session" },
  });
  assert.equal(other.headers.get("X-Cache"), "MISS");
  assert(!(await other.text()).includes(draft.title));
  const anotherSession = await f.rawRequest(path, {
    headers: { Cookie: "cpc_session=another-session" },
  });
  assert.equal(anotherSession.headers.get("X-Cache"), "MISS");
  assert((await anotherSession.text()).includes(draft.title));
  for (const key of entries.keys()) {
    assert.equal(new URL(key).searchParams.get("__page_size"), "50");
    assert(!key.includes("test-session") && !key.includes("test-csrf"));
    assert(!key.includes("another-session") && !key.includes("another-csrf"));
  }
  const inline = await f.request(
    "/?sort=saved&type=blueprints&min_collection_count=0&render=full",
  );
  assert.equal(inline.headers.get("X-Catalog-Cache"), "MISS");
  const page = parseDocument(await inline.text());
  assert.equal(
    DomUtils.getElementsByTagName("div", page.children).filter(
      (el) => el.attribs.id === "results",
    ).length,
    1,
  );
  assert.equal(
    DomUtils.getElementsByTagName("section", page.children).filter(
      (el) => el.attribs.id === "category-filters",
    ).length,
    1,
  );
  assert.equal(
    (
      await f.request(
        "/?sort=saved&type=blueprints&min_collection_count=0&render=full",
      )
    ).headers.get("X-Catalog-Cache"),
    "HIT",
  );
  assert.equal(
    (
      await f.rawRequest(
        "/?sort=saved&type=blueprints&min_collection_count=0&render=full",
        {
          headers: { Cookie: "cpc_session=test-session", "HX-Request": "true" },
        },
      )
    ).headers.get("X-Cache"),
    "HIT",
  );
  f.role("Reviewer");
  assert.equal(
    (await f.request(path)).headers.get("X-Cache"),
    "MISS",
    "Role changes select a different cache entry",
  );
  f.sqlite.prepare("DELETE FROM worker_session WHERE user_id=1").run();
  const revoked = await f.request(path);
  assert.equal(revoked.headers.get("X-Cache"), "BYPASS");
  assert(!(await revoked.text()).includes(draft.title));
});

void test("saves invalidate only the saver while popularity expires in a minute and moderation invalidates immediately", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  f.sqlite
    .prepare("UPDATE hub_item SET downloads=10 WHERE id=?")
    .run(f.item.id);
  const other = f.insert("hub_item", {
    id: uuid(),
    author_id: 2,
    content_type_id: 1,
    status: "published",
    title: "Other creation",
    downloads: 1,
  });
  f.insert("hub_bookmark", { item_id: other.id, user_id: 2 });
  f.insert("worker_session", {
    digest: await hash("second-session"),
    user_id: 2,
    csrf: "second-csrf",
    expires_at: Date.now() + 60000,
  });
  const { expire } = fragmentCache(t);
  const saved = "/catalog/results/?min_collection_count=1&sort=saved";
  const popular = "/catalog/results/";
  const personal = "/catalog/results/?view=saved";
  const anonymous = (path: string) =>
    f.request(path, "GET", undefined, "anonymous");
  const otherSession = (path: string) =>
    f.rawRequest(path, { headers: { Cookie: "cpc_session=second-session" } });
  await anonymous(saved);
  const initial = await (await anonymous(popular)).text();
  assert(initial.indexOf(f.item.title) < initial.indexOf(other.title));
  await f.request(saved);
  await f.request(personal);
  await otherSession(saved);
  const revision = () =>
    f.sqlite
      .prepare("SELECT revision FROM worker_cache_revision WHERE id=1")
      .get()!.revision;
  const before = revision();
  assert.equal(
    (await f.request(`/items/${f.item.id}/save/`, "POST", {})).status,
    302,
  );
  assert.equal(
    revision(),
    before,
    "Saving does not evict everyone else's results",
  );
  const own = await f.request(saved);
  assert.equal(own.headers.get("X-Cache"), "MISS");
  assert((await own.text()).includes(f.item.title));
  const ownCollection = await f.request(personal);
  assert.equal(ownCollection.headers.get("X-Cache"), "MISS");
  assert((await ownCollection.text()).includes(f.item.title));
  assert.equal((await otherSession(saved)).headers.get("X-Cache"), "HIT");
  const stale = await anonymous(saved);
  assert.equal(stale.headers.get("X-Cache"), "HIT");
  assert(!(await stale.text()).includes(f.item.title));
  f.sqlite.prepare("UPDATE hub_item SET downloads=20 WHERE id=?").run(other.id);
  assert.equal(revision(), before);
  assert.equal((await anonymous(popular)).headers.get("X-Cache"), "HIT");
  expire();
  const refreshed = await anonymous(saved);
  assert.equal(refreshed.headers.get("X-Cache"), "MISS");
  assert((await refreshed.text()).includes(f.item.title));
  const reordered = await (await anonymous(popular)).text();
  assert(reordered.indexOf(other.title) < reordered.indexOf(f.item.title));
  await f.request(`/items/${f.item.id}/save/`, "POST", {});
  const unsaved = await f.request(personal);
  assert.equal(unsaved.headers.get("X-Cache"), "MISS");
  assert(!(await unsaved.text()).includes(f.item.title));
  await f.request(saved);
  f.sqlite
    .prepare(
      "UPDATE hub_item SET is_hidden=1,hidden_reason='Review' WHERE id=?",
    )
    .run(other.id);
  for (const request of [anonymous, (path: string) => f.request(path)]) {
    const hidden = await request(saved);
    assert.equal(hidden.headers.get("X-Cache"), "MISS");
    assert(!(await hidden.text()).includes(other.title));
  }
  f.sqlite
    .prepare("UPDATE hub_bookmark SET user_id=1 WHERE item_id=?")
    .run(other.id);
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT revision FROM worker_collection_revision WHERE user_id=2",
      )
      .get()!.revision,
    2,
  );
  f.sqlite.exec("PRAGMA foreign_keys=ON; DELETE FROM auth_user WHERE id=1");
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM worker_collection_revision WHERE user_id=1",
      )
      .get()!.n,
    0,
  );
});

void test("collection inputs, HTMX navigation and reset links preserve the other search controls", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const query =
    "min_collection_count=1&max_collection_count=3&min_width=5&q=garage&type=blueprints&tag=parking+garages&sort=saved&page=4";
  const page = parseDocument(await (await f.request("/?" + query)).text());
  const controls = DomUtils.getElementsByTagName("input", page.children);
  assert.equal(
    controls.find((el) => el.attribs.name === "min_collection_count")!.attribs
      .value,
    "1",
  );
  assert.equal(
    controls.find((el) => el.attribs.name === "max_collection_count")!.attribs
      .value,
    "3",
  );
  assert.equal(
    DomUtils.getElementsByTagName("form", page.children)[0]!.attribs["hx-get"],
    "/catalog/results/",
  );
  assert(
    Object.hasOwn(
      DomUtils.getElementsByTagName("details", page.children)[0]!.attribs,
      "open",
    ),
  );
  const response = await f.request("/catalog/results/?" + query);
  assert.equal(response.headers.get("HX-Push-Url"), "/?" + query);
  const fragment = parseDocument(await response.text());
  assert.equal(
    DomUtils.getElementsByTagName("html", fragment.children).length,
    0,
  );
  const actions = DomUtils.getElementById(
    "numeric-filter-actions",
    fragment.children,
  )!;
  assert.equal(actions.attribs["hx-swap-oob"], "outerHTML");
  const reset = new URL(
    DomUtils.getElementsByTagName("a", actions.children)[0]!.attribs.href!,
    "https://cpchub.net",
  );
  assert.deepEqual(
    [...reset.searchParams],
    [
      ["q", "garage"],
      ["type", "blueprints"],
      ["tag", "parking garages"],
      ["sort", "saved"],
    ],
  );
  const stock = parseDocument(
    await (await f.request("/?type=scenarios")).text(),
  );
  assert.equal(
    DomUtils.getElementsByTagName("option", stock.children).find(
      (el) => el.attribs.value === "popular",
    )!.attribs.selected,
    "",
  );
  assert(
    !Object.hasOwn(
      DomUtils.getElementsByTagName("details", stock.children)[0]!.attribs,
      "open",
    ),
  );
  assert.equal((await f.request("/?max_collection_count=0")).status, 200);
});

void test("fragment cache bypasses unsupported URLs and refuses failed or cookie-setting responses", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { entries } = fragmentCache(t);
  for (const query of ["unknown=yes", "q=" + "x".repeat(1001)]) {
    const response = await f.request("/catalog/results/?" + query);
    assert.equal(response.headers.get("X-Cache"), "BYPASS");
  }
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", null);
    await next();
  });
  app.get("/", (c) =>
    cachedCatalogHTML(c, new URLSearchParams(), "inline", async () =>
      c.req.header("X-Test-Cookie")
        ? new Response("cookie", { headers: { "Set-Cookie": "test=1" } })
        : new Response("failed", { status: 503 }),
    ),
  );
  for (const headers of [{}, { "X-Test-Cookie": "yes" }]) {
    const response = await app.request(
      "https://cpchub.net/",
      { headers },
      f.env,
      f.context,
    );
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(entries.size, 0);
  }
  f.sqlite.exec("DELETE FROM worker_cache_revision");
  assert.equal((await f.request("/catalog/results/")).status, 200);
  assert.equal(
    (await f.request("/catalog/results/", "GET", undefined, "anonymous"))
      .status,
    200,
  );
});
