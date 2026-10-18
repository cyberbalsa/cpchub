import test from "node:test";
import assert from "node:assert/strict";
import { DomUtils, parseDocument } from "htmlparser2";
import { staffFixture } from "./helpers/staff";
import { fragmentCache } from "./helpers/cache";
import { hash, publicId } from "../src/env";

void test("initial pages request their fragments separately and offer a complete server-rendered fallback", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  fragmentCache(t);
  const queries: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  const query = "type=blueprints&sort=saved&min_collection_count=0";
  const response = await f.request("/?" + query);
  assert.equal(response.headers.get("X-Catalog-Cache"), "DEFERRED");
  const html = await response.text();
  assert(!html.includes(f.item.title));
  const doc = parseDocument(html);
  const placeholder = DomUtils.getElementById("results", doc.children)!;
  assert.equal(placeholder.attribs["hx-get"], "/catalog/results/?" + query);
  assert.equal(placeholder.attribs["hx-trigger"], "load");
  assert.equal(placeholder.attribs["hx-sync"], "#catalog-filter:replace");
  assert.equal(response.headers.get("X-Cache"), "MISS");
  const fragment = await f.rawRequest(placeholder.attribs["hx-get"]!, {
    headers: {
      Cookie: "cpc_session=test-session",
      "HX-Request": "true",
      "HX-Trigger": "results",
    },
  });
  assert.equal(
    fragment.headers.get("HX-Push-Url"),
    "false",
    "Initial loading must not create another browser history entry",
  );
  assert((await fragment.text()).includes(f.item.title));
  const fallback = DomUtils.getElementsByTagName("a", placeholder.children)[0]!
    .attribs.href!;
  const full = await f.request(fallback);
  assert.equal(full.headers.get("X-Catalog-Cache"), "MISS");
  const fullHTML = await full.text();
  assert(fullHTML.includes(f.item.title));
  assert(!fullHTML.includes('hx-trigger="load"'));
  const filtered = await f.request(
    "/catalog/results/?" + query + "&render=full",
  );
  assert.equal(filtered.headers.get("X-Cache"), "HIT");
  assert.equal(filtered.headers.get("HX-Push-Url"), "/?" + query);

  queries.length = 0;
  const path = `/items/${publicId(f.item.id)}/`;
  const detail = await f.request(path);
  assert.equal(detail.headers.get("X-Item-Cache"), "DEFERRED");
  const detailHTML = await detail.text();
  assert(detailHTML.includes(f.item.title));
  assert(!detailHTML.includes("About this creation"));
  assert(detailHTML.includes('id="download-warning"'));
  assert(detailHTML.includes('id="bookmark-control"'));
  assert(
    detailHTML.includes(
      `content="https://cpchub.net/api/v1/items/${publicId(f.item.id)}/screenshots/${publicId(f.screenshot.id)}/image/"`,
    ),
  );
  assert(!queries.some((sql) => /SELECT \* FROM hub_release/.test(sql)));
  const content = DomUtils.getElementById(
    "item-content",
    parseDocument(detailHTML).children,
  )!;
  assert.equal(content.attribs["hx-get"], path + "content/");
  assert.equal(content.attribs["hx-trigger"], "load");
  const loaded = await f.request(content.attribs["hx-get"]!);
  assert.equal(loaded.headers.get("X-Cache"), "MISS");
  const fallbackDetail = await f.request(path + "?render=full");
  assert.equal(fallbackDetail.headers.get("X-Item-Cache"), "HIT");
  const detailFullHTML = await fallbackDetail.text();
  assert(detailFullHTML.includes("About this creation"));
  assert(detailFullHTML.includes(f.item.description));
  assert(!detailFullHTML.includes('hx-trigger="load"'));
});

void test("warm item fragments skip content queries, isolate sessions and contain no personal controls or cookies", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  const { entries } = fragmentCache(t);
  const queries: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  const path = `/items/${f.item.id}/content/`;
  const anonymous = () => f.request(path, "GET", undefined, "anonymous");
  const cold = await anonymous();
  assert.equal(cold.headers.get("X-Cache"), "MISS");
  assert.equal(cold.headers.get("Set-Cookie"), null);
  const html = await cold.text();
  assert(html.includes("About this creation"));
  assert(html.includes("Version history"));
  assert(html.includes("data-screenshot-gallery"));
  for (const personal of [
    "<html",
    "<form",
    "csrfmiddlewaretoken",
    "bookmark-control",
    "download-warning",
    "Edit creation",
    "Moderation tools",
  ])
    assert(!html.includes(personal), personal);
  queries.length = 0;
  const hit = await anonymous();
  assert.equal(hit.headers.get("X-Cache"), "HIT");
  assert.equal(hit.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await hit.text(), html);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /FROM worker_cache_revision/);
  assert.equal((await f.request(path)).headers.get("X-Cache"), "MISS");
  queries.length = 0;
  const own = await f.request(`/items/${publicId(f.item.id)}/content/`);
  assert.equal(
    own.headers.get("X-Cache"),
    "HIT",
    "Compact and hyphenated IDs share a canonical cache key",
  );
  assert.equal(queries.length, 3);
  assert(
    queries.every((sql) =>
      /FROM worker_session|FROM auth_user u|FROM worker_cache_revision/.test(
        sql,
      ),
    ),
  );
  assert.equal(entries.size, 2);
  for (const [key, value] of entries) {
    assert(!key.includes("test-session") && !key.includes("test-csrf"));
    assert(!(await value.response.clone().text()).includes("test-csrf"));
  }
  const full = await f.request(`/items/${f.item.id}/?render=full`);
  assert.equal(full.headers.get("X-Item-Cache"), "HIT");
  const fresh = await full.text();
  assert(fresh.includes("test-csrf"));
  assert(fresh.includes('id="bookmark-control"'));
});

void test("item counters expire in a minute while content edits and visibility changes invalidate immediately", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  f.sqlite.prepare("UPDATE hub_item SET downloads=7 WHERE id=?").run(f.item.id);
  const { expire, entries } = fragmentCache(t);
  const path = `/items/${f.item.id}/content/`;
  const anonymous = () => f.request(path, "GET", undefined, "anonymous");
  assert((await (await anonymous()).text()).includes("<dd>7</dd>"));
  f.sqlite
    .prepare("UPDATE hub_item SET downloads=99 WHERE id=?")
    .run(f.item.id);
  const stale = await anonymous();
  assert.equal(stale.headers.get("X-Cache"), "HIT");
  assert((await stale.text()).includes("<dd>7</dd>"));
  expire();
  const refreshed = await anonymous();
  assert.equal(refreshed.headers.get("X-Cache"), "MISS");
  assert((await refreshed.text()).includes("<dd>99</dd>"));
  for (const [sql, id, text] of [
    [
      "UPDATE hub_item SET description='Edited description' WHERE id=?",
      f.item.id,
      "Edited description",
    ],
    ["UPDATE hub_release SET version='2.0' WHERE id=?", f.release.id, "v2.0"],
    [
      "UPDATE hub_screenshot SET caption='New caption' WHERE id=?",
      f.screenshot.id,
      "New caption",
    ],
  ]) {
    f.sqlite.prepare(sql!).run(id!);
    const edited = await anonymous();
    assert.equal(edited.headers.get("X-Cache"), "MISS");
    assert((await edited.text()).includes(text!));
  }
  const before = entries.size;
  f.sqlite
    .prepare(
      "UPDATE hub_item SET is_hidden=1,hidden_reason='Review' WHERE id=?",
    )
    .run(f.item.id);
  assert.equal((await anonymous()).status, 403);
  assert.equal((await anonymous()).status, 403);
  assert.equal(
    entries.size,
    before,
    "Denied responses must never populate the cache",
  );
  f.sqlite
    .prepare("UPDATE hub_item SET is_hidden=0,status='draft' WHERE id=?")
    .run(f.item.id);
  assert.equal((await anonymous()).status, 404);
  assert.equal((await f.request(path)).status, 404);
  f.role("Reviewer");
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await f.request(path)).headers.get("X-Cache"), "HIT");
  f.role("");
  assert.equal(
    (await f.request(path)).status,
    404,
    "A former staff member cannot reuse privileged HTML",
  );
  f.insert("worker_session", {
    digest: await hash("author-session"),
    user_id: 2,
    csrf: "author-csrf",
    expires_at: Date.now() + 60000,
  });
  const author = () =>
    f.rawRequest(path, { headers: { Cookie: "cpc_session=author-session" } });
  assert.equal((await author()).headers.get("X-Cache"), "MISS");
  assert.equal((await author()).headers.get("X-Cache"), "HIT");
  f.sqlite.prepare("UPDATE auth_user SET is_active=0 WHERE id=2").run();
  assert.equal(
    (await author()).status,
    404,
    "Disabled accounts cannot reuse private cached content",
  );
  f.sqlite.prepare("UPDATE auth_user SET is_active=1 WHERE id=2").run();
  assert.equal((await author()).status, 200);
  f.sqlite.prepare("DELETE FROM worker_session WHERE user_id=2").run();
  assert.equal(
    (await author()).status,
    404,
    "Revoked sessions cannot reuse private cached content",
  );
});

void test("cached item pages immediately refresh the saver's controls and download preferences", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  fragmentCache(t);
  const path = `/items/${f.item.id}/`;
  await f.request(path + "content/");
  const toggle = () =>
    f.rawRequest(path + "save/", {
      method: "POST",
      headers: {
        Cookie: "cpc_session=test-session",
        "X-CSRFToken": "test-csrf",
        "HX-Request": "true",
      },
    });
  const saved = await (await toggle()).text();
  assert(saved.includes("Saved by 1 person"));
  assert(saved.includes("★ Saved"));
  const wrapper = await (await f.request(path)).text();
  assert(wrapper.includes("Saved by 1 person"));
  assert(wrapper.includes('id="download-warning"'));
  assert.equal((await f.request(path)).headers.get("X-Cache"), "HIT");
  const removed = await (await toggle()).text();
  assert(removed.includes("Saved by 0 people"));
  assert(removed.includes("☆ Save creation"));
  const updated = await f.request(path);
  assert.equal(updated.headers.get("X-Cache"), "MISS");
  const updatedHTML = await updated.text();
  assert(updatedHTML.includes("Saved by 0 people"));
  assert(updatedHTML.includes("☆ Save creation"));
  const remembered = await f.rawRequest(path, {
    headers: { Cookie: "cpc_session=test-session; cpc_warning=1" },
  });
  assert(!(await remembered.text()).includes('id="download-warning"'));
  f.insert("hub_userpreferences", { user_id: 1, ugc_warning_version: 1 });
  assert(
    !(await (await f.request(path)).text()).includes('id="download-warning"'),
  );
  f.sqlite
    .prepare(
      "UPDATE hub_userpreferences SET ugc_warning_version=0 WHERE user_id=1",
    )
    .run();
  assert(
    (await (await f.request(path)).text()).includes('id="download-warning"'),
  );
  assert(
    (
      await (await f.request(path, "GET", undefined, "anonymous")).text()
    ).includes('id="download-warning"'),
  );
  f.sqlite.prepare("DELETE FROM hub_release WHERE item_id=?").run(f.item.id);
  f.sqlite.prepare("DELETE FROM hub_screenshot WHERE item_id=?").run(f.item.id);
  const empty = await (
    await f.request(path + "?render=full", "GET", undefined, "anonymous")
  ).text();
  assert(empty.includes("No release available yet."));
  assert(empty.includes("https://cpchub.net/static/art/share-card.png"));
  assert(!empty.includes('id="download-warning"'));
});
