import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { fixture } from "./helpers/app";
import { staffFixture } from "./helpers/staff";
import { edgeCache } from "../src/cache";
import worker from "../src/index";
import { uuid, now, type App } from "../src/env";

void test("public cache hits use canonical revision keys and never cache private or failed responses", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const keys: string[] = [];
  t.mock.method(caches.default, "match", async (key: Request) => {
    keys.push(key.url);
    return new Response("cached", {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  });
  const hit = await f.request(
    "/api/v1/types/?sort=newest&q=a",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(hit.headers.get("X-Cache"), "HIT");
  assert.equal(await hit.text(), "cached");
  assert(keys[0]!.includes("q=a&sort=newest&__revision="));
  f.sqlite.exec("DELETE FROM worker_cache_revision");
  await f.request("/api/v1/types/", "GET", undefined, "anonymous");
  assert(keys[1]!.endsWith("__revision=0"));
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", null);
    await next();
  });
  app.use("*", edgeCache);
  app.get("/api/v1/types/", (c) => {
    c.header("Set-Cookie", "example=1");
    return c.text("cookie");
  });
  t.mock.method(caches.default, "match", async () => undefined);
  const cookie = await app.request(
    "https://cpchub.net/api/v1/types/",
    {},
    f.env,
    f.context,
  );
  assert.equal(cookie.headers.get("Cache-Control"), "private, no-store");
  const invalid = await f.request(
    "/api/v1/types/missing/",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get("Cache-Control"), "private, no-store");
});

void test("public metadata, documentation, share images and redirects return safe responses", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const missing = await f.request("/missing-route/");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    status: 404,
    errors: { detail: "Not found." },
  });
  for (const path of [
    "/health/",
    "/robots.txt",
    "/.well-known/security.txt",
    "/sitemap.xml",
    "/api/docs/",
    "/api/schema/",
    "/moderation",
    "/moderation/",
  ])
    assert.equal((await f.request(path)).status, 200, path);
  for (const path of [
    "/security.txt",
    "/sitemap-2.xml",
    "/api/redoc/",
    "/admin/",
    "/admin/login/",
  ])
    assert([301, 302].includes((await f.request(path)).status), path);
  assert.equal(
    (await f.request("/admin/", "GET", undefined, "anonymous")).headers.get(
      "Location",
    ),
    "/admin/login/",
  );
  assert(
    (await (await f.request("/sitemap.xml")).text()).includes("<lastmod>"),
  );
  const path = `/share/items/${f.item.id}/${f.screenshot.id}/image.webp`;
  assert.equal(
    (await f.request(`/share/items/${f.item.id}/${uuid()}/image.webp`)).status,
    404,
  );
  assert.equal((await f.request(path)).status, 404);
  f.objects.set(f.screenshot.image, new Uint8Array([1]));
  assert.equal(
    (await f.request(path)).headers.get("Content-Type"),
    "image/webp",
  );
  const key = "11111111-1111-4111-8111-111111111111-1234567812345678.webp";
  f.sqlite
    .prepare("UPDATE hub_screenshot SET image=? WHERE id=?")
    .run(key, f.screenshot.id);
  assert.equal(
    (await f.request(path)).headers.get("Location"),
    f.env.SCREENSHOT_URL + "/" + key,
  );
  f.role("");
  for (const route of ["/moderation", "/moderation/"])
    assert.equal((await f.request(route)).status, 403);
});

void test("request size, upload origin and CSRF guards reject early and clean staged files", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal(
    (
      await f.rawRequest("/api/v1/items/", {
        method: "POST",
        headers: { "Content-Length": String(101 * 1024 * 1024) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await f.rawRequest("/api/v1/items/", {
        method: "POST",
        body: "x".repeat(65537),
      })
    ).status,
    413,
  );
  const upload = () => {
    const d = new FormData();
    d.set("file", new File(["native"], "test.cpbp"));
    return d;
  };
  assert.equal(
    (await f.rawRequest("/api/v1/items/", { method: "POST", body: upload() }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.rawRequest("/api/v1/items/", {
        method: "POST",
        body: upload(),
        headers: {
          Cookie: "cpc_session=test-session",
          Origin: "https://evil.test",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.rawRequest("/api/v1/items/", {
        method: "POST",
        body: upload(),
        headers: {
          Cookie: "cpc_session=test-session",
          Origin: f.env.PUBLIC_URL,
        },
      })
    ).status,
    403,
  );
  assert.equal(f.objects.size, 0);
  assert.equal(
    (
      await f.rawRequest("/api/v1/items/", {
        method: "POST",
        body: "x".repeat(65536),
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    403,
  );
});

void test("server errors hide internals even when the error page cannot reach D1", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const log = t.mock.method(console, "error", () => {});
  t.mock.method(f.env.DB, "prepare", () => {
    throw new Error("database credential secret");
  });
  for (const [path, accept] of [
    ["/health/", "text/html"],
    ["/health/", "application/json"],
    ["/api/v1/types/", "application/json"],
  ]) {
    const response = await f.rawRequest(path!, {
      headers: { Accept: accept! },
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert(body.includes("The request could not be completed."));
    assert(!body.includes("credential"));
  }
  assert.equal(log.mock.callCount(), 3);
});

void test("queue failures retry individual messages and scheduled failures do not cancel independent tasks", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const item = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
  });
  const id = uuid();
  f.insert("hub_uploadjob", {
    id,
    item_id: item.id,
    kind: "screenshot",
    status: "pending",
    metadata: '{"type":"blueprints"}',
    submitted_by_id: 1,
  });
  f.insert("worker_job", { id, object_key: "incoming/test" });
  f.objects.set("incoming/test", new Uint8Array([1]));
  const ack: string[] = [],
    retry: number[] = [];
  const messages = [uuid(), id].map((id) => ({
    id,
    body: { id },
    timestamp: new Date(),
    attempts: 1,
    ack() {
      ack.push(id);
    },
    retry(options?: QueueRetryOptions) {
      retry.push(options?.delaySeconds ?? 0);
    },
  }));
  await worker.queue(
    {
      queue: "uploads",
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      messages,
      ackAll() {},
      retryAll() {},
    },
    f.env,
  );
  assert.equal(ack.length, 1);
  assert.deepEqual(retry, [30]);
  f.insert("hub_accountactivity", { user_id: 1, created_at: "2000-01-01" });
  f.insert("worker_nonce", { nonce: "expired", expires_at: 1 });
  f.sqlite.exec(
    "CREATE TRIGGER deny_session_expiry BEFORE DELETE ON worker_session BEGIN SELECT RAISE(ABORT,'session expiry failed'); END",
  );
  f.sqlite.exec("UPDATE worker_session SET expires_at=1");
  await worker.scheduled(
    { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
    f.env,
    f.context,
  );
  await assert.rejects(
    Promise.all(f.background.splice(0)),
    /Scheduled tasks failed/,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_nonce").get()!.n,
    0,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_accountactivity").get()!.n,
    0,
  );
  assert(now());
});
