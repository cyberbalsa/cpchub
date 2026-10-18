import test from "node:test";
import assert from "node:assert/strict";
import { DomUtils, parseDocument } from "htmlparser2";
import { staffFixture } from "./helpers/staff";
import { fragmentCache } from "./helpers/cache";
import { hash, publicId, uuid } from "../src/env";

void test("complete home and category pages share anonymous HTML and skip rendering queries on hits", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.sqlite.prepare("UPDATE hub_item SET featured_at=CURRENT_TIMESTAMP").run();
  fragmentCache(t);
  const queries: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  for (const path of [
    "/",
    "/?type=blueprints",
    "/?type=blueprints&render=full",
  ]) {
    queries.length = 0;
    const cold = await f.request(path, "GET", undefined, "anonymous");
    assert.equal(cold.headers.get("X-Cache"), "MISS");
    assert.equal(cold.headers.get("Set-Cookie"), null);
    assert(queries.length > 1);
    const html = await cold.text();
    assert(html.startsWith("\n<!doctype html>"));
    assert(html.includes('aria-label="Main navigation"'));
    assert(html.includes("Advanced searching"));
    assert(html.includes("Sign in"));
    assert(!html.includes("Sign out"));
    queries.length = 0;
    const warm = await f.rawRequest(path, {
      headers: { Cookie: "cpc_csrf=another-browser; cpc_warning=1" },
    });
    assert.equal(warm.headers.get("X-Cache"), "HIT");
    assert.equal(warm.headers.get("Cache-Control"), "private, no-store");
    assert.equal(warm.headers.get("Set-Cookie"), null);
    assert.equal(await warm.text(), html);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM worker_cache_revision/);
  }
  const ignored = await f.request(
    "/?render=ignored",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(ignored.headers.get("X-Cache"), "HIT");
  assert(!(await ignored.text()).includes("render=ignored"));
  f.sqlite
    .prepare("UPDATE hub_item SET is_hidden=1,hidden_reason='Review'")
    .run();
  const hidden = await f.request("/", "GET", undefined, "anonymous");
  assert.equal(hidden.headers.get("X-Cache"), "MISS");
  assert(!(await hidden.text()).includes(f.item.title));
});

void test("complete signed-in pages isolate accounts, sessions, CSRF tokens and revoked permissions", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  const draft = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
    status: "draft",
    title: "Private parking plan",
  });
  for (const [token, user, csrf] of [
    ["another-session", 1, "another-csrf"],
    ["other-session", 2, "other-csrf"],
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
  for (const path of [
    "/?view=mine&render=full",
    `/items/${draft.id}/?render=full`,
  ]) {
    const first = await f.request(path);
    assert.equal(first.headers.get("X-Cache"), "MISS");
    const html = await first.text();
    assert(html.includes(draft.title));
    assert(html.includes("Sign out"));
    queries.length = 0;
    const warm = await f.request(path);
    assert.equal(warm.headers.get("X-Cache"), "HIT");
    assert.equal(await warm.text(), html);
    assert.equal(queries.length, path.startsWith("/items/") ? 4 : 3);
    assert(
      queries.every((sql) =>
        /FROM worker_session|FROM auth_user u|FROM worker_cache_revision|FROM hub_userpreferences/.test(
          sql,
        ),
      ),
    );
    const another = await f.rawRequest(path, {
      headers: { Cookie: "cpc_session=another-session" },
    });
    assert.equal(another.headers.get("X-Cache"), "MISS");
    const anotherHTML = await another.text();
    assert(anotherHTML.includes(draft.title));
    assert(!anotherHTML.includes("test-csrf"));
    if (path.startsWith("/items/")) {
      assert(html.includes("test-csrf"));
      assert(anotherHTML.includes("another-csrf"));
    }
    for (const cookie of ["", "cpc_session=other-session"]) {
      const other = await f.rawRequest(path, { headers: { Cookie: cookie } });
      assert(!(await other.text()).includes(draft.title));
    }
  }
  for (const key of entries.keys()) {
    assert(!key.includes("test-session"));
    assert(!key.includes("test-csrf"));
  }
  const path = `/items/${draft.id}/?render=full`;
  f.role("Reviewer");
  const staff = await f.request(path);
  assert.equal(staff.headers.get("X-Cache"), "MISS");
  assert((await staff.text()).includes("Moderation tools"));
  f.role("");
  assert(!(await (await f.request(path)).text()).includes("Moderation tools"));
  f.sqlite.prepare("DELETE FROM worker_session WHERE user_id=1").run();
  assert.equal((await f.request(path)).status, 404);
  const revoked = await f.request("/?view=mine&render=full");
  assert.equal(revoked.headers.get("X-Cache"), "BYPASS");
  const revokedHTML = await revoked.text();
  assert(!revokedHTML.includes(draft.title));
  assert(!revokedHTML.includes("Sign out"));
});

void test("complete item pages share canonical links, respect warning consent, expire counters and invalidate visibility", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.sqlite.prepare("UPDATE hub_item SET downloads=7 WHERE id=?").run(f.item.id);
  const { expire, entries } = fragmentCache(t);
  const path = `/items/${publicId(f.item.id)}/`;
  const queries: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  for (const variant of ["", "?render=full"]) {
    const cold = await f.rawRequest(path + variant, {
      headers: { Cookie: "cpc_csrf=first-browser" },
    });
    assert.equal(cold.headers.get("X-Cache"), "MISS");
    assert.equal(cold.headers.get("Set-Cookie"), null);
    const html = await cold.text();
    assert(html.includes(f.item.title));
    assert(html.includes('id="download-warning"'));
    assert(!html.includes("first-browser"));
    assert(!html.includes("test-csrf"));
    const csrf = DomUtils.getElementsByTagName(
      "input",
      parseDocument(html).children,
    ).find((el) => el.attribs.name === "csrfmiddlewaretoken")!;
    assert.equal(csrf.attribs.value, "");
    queries.length = 0;
    const warm = await f.rawRequest(
      `/items/${f.item.id}/?utm_source=reddit${variant ? "&render=full" : ""}`,
      {
        headers: { Cookie: "cpc_csrf=second-browser" },
      },
    );
    assert.equal(warm.headers.get("X-Cache"), "HIT");
    assert.equal(warm.headers.get("Cache-Control"), "private, no-store");
    assert.equal(warm.headers.get("Set-Cookie"), null);
    assert.equal(await warm.text(), html);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM worker_cache_revision/);
    const consent = await f.rawRequest(path + variant, {
      headers: { Cookie: "cpc_warning=1" },
    });
    assert.equal(consent.headers.get("X-Cache"), "MISS");
    assert(!(await consent.text()).includes('id="download-warning"'));
    assert.equal(
      (
        await f.rawRequest(path + variant, {
          headers: { Cookie: "cpc_warning=1" },
        })
      ).headers.get("X-Cache"),
      "HIT",
    );
  }
  f.sqlite
    .prepare("UPDATE hub_item SET downloads=99 WHERE id=?")
    .run(f.item.id);
  const full = () =>
    f.request(path + "?render=full", "GET", undefined, "anonymous");
  assert((await (await full()).text()).includes("<dd>7</dd>"));
  expire();
  const refreshed = await full();
  assert.equal(refreshed.headers.get("X-Cache"), "MISS");
  assert((await refreshed.text()).includes("<dd>99</dd>"));
  const before = entries.size;
  f.sqlite
    .prepare(
      "UPDATE hub_item SET is_hidden=1,hidden_reason='Review' WHERE id=?",
    )
    .run(f.item.id);
  assert.equal(
    (await f.request(path, "GET", undefined, "anonymous")).status,
    403,
  );
  assert.equal((await full()).status, 403);
  assert.equal(entries.size, before);
  f.sqlite
    .prepare("UPDATE hub_item SET is_hidden=0,status='draft' WHERE id=?")
    .run(f.item.id);
  assert.equal((await full()).status, 404);
});

void test("download confirmation obtains an uncached per-browser CSRF token and retains the no-JavaScript fallback", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const { entries } = fragmentCache(t);
  const anonymous = () =>
    f.request("/accounts/csrf/", "GET", undefined, "anonymous");
  const tokenResponse = await anonymous();
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("Cache-Control"), "private, no-store");
  const { csrf_token: token } = await tokenResponse.json<{
    csrf_token: string;
  }>();
  assert(token.length >= 32);
  const cookie = tokenResponse.headers.get("Set-Cookie")!;
  assert(cookie.includes("cpc_csrf=" + token));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
    assert(cookie.includes(attribute));
  const another = await (await anonymous()).json<{ csrf_token: string }>();
  assert.notEqual(another.csrf_token, token);
  const existing = await f.rawRequest("/accounts/csrf/", {
    headers: { Cookie: "cpc_csrf=" + token },
  });
  assert.equal(existing.headers.get("Set-Cookie"), null);
  assert.deepEqual(await existing.json(), { csrf_token: token });
  const signedIn = await f.request("/accounts/csrf/");
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.deepEqual(await signedIn.json(), { csrf_token: "test-csrf" });
  assert.equal(entries.size, 0);
  const path = `/items/${f.item.id}/releases/${f.release.id}/download/`;
  const confirm = (csrf: string) =>
    f.rawRequest(path, {
      method: "POST",
      headers: {
        Cookie: "cpc_csrf=" + token,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: csrf }),
    });
  assert.equal((await confirm(another.csrf_token)).status, 403);
  assert.equal((await confirm(token)).status, 200);
  const fallback = await f.request(path, "GET", undefined, "anonymous");
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("Cache-Control"), "private, no-store");
  const fallbackCookie = fallback.headers.get("Set-Cookie")!.split(";")[0]!;
  const form = parseDocument(await fallback.text());
  const input = DomUtils.getElementsByTagName("input", form.children).find(
    (el) => el.attribs.name === "csrfmiddlewaretoken",
  )!;
  assert.equal(fallbackCookie, "cpc_csrf=" + input.attribs.value);
});
