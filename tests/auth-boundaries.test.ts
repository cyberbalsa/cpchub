import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { fixture } from "./helpers/app";
import { hash, HttpError, now, uuid, type App } from "../src/env";
import { session, userById } from "../src/auth";
import { passkeys } from "../src/passkeys";

void test("inactive OAuth accounts, missing CSRF and anonymous private pages fail safely", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.insert("worker_token", {
    digest: await hash("inactive-token"),
    kind: "access",
    user_id: 2,
    client_id: "test-client",
    family: "family",
    scope: "read",
    expires_at: Date.now() + 60000,
  });
  f.sqlite.exec("UPDATE auth_user SET is_active=0 WHERE id=2");
  assert.equal(
    (
      await f.rawRequest("/api/v1/me/", {
        headers: { Authorization: "Bearer inactive-token" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.rawRequest("/account/profile/", {
        method: "POST",
        headers: { Cookie: "cpc_session=test-session" },
      })
    ).status,
    403,
  );
  const anonymous = await f.request(
    "/account/profile/",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get("Location")!, /^\/accounts\/login\//);
  const login = await f.rawRequest("/accounts/steam/login/", {
    method: "POST",
    headers: { Cookie: "cpc_csrf=test", "X-CSRFToken": "test" },
  });
  assert.equal(login.status, 302);
  assert.equal(
    f.sqlite.prepare("SELECT nonce FROM worker_login").get()!.nonce,
    "",
  );
});

void test("session creation without a social provider records staff authentication", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await userById(f.env, 1);
  assert(user);
  const app = new Hono<App>();
  app.get("/staff-session", async (c) => {
    await session(c, user);
    return c.text("ok");
  });
  const response = await app.request(
    "https://cpchub.net/staff-session",
    {},
    f.env,
    f.context,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie")!, /cpc_session=/);
  assert.equal(
    f.sqlite.prepare("SELECT auth_method FROM hub_accountactivity").get()!
      .auth_method,
    "staff",
  );
});

void test("passkey challenges reject incomplete legacy session bindings", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await userById(f.env, 1);
  assert(user);
  // Exercise the router boundary with an authenticated context whose cookie is missing.
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", passkeys);
  app.onError((error, c) => {
    assert(error instanceof HttpError);
    return c.json({ error: error.message }, error.status);
  });
  const options = await app.request(
    "https://cpchub.net/accounts/passkeys/register/options/",
    { method: "POST", body: "{}" },
    f.env,
    f.context,
  );
  assert.equal(options.status, 200);
  assert.equal(
    f.sqlite
      .prepare("SELECT session_digest FROM worker_passkey_challenge")
      .get()!.session_digest,
    await hash(""),
  );
  f.sqlite.exec("UPDATE worker_passkey_challenge SET session_digest=NULL");
  const cookie = options.headers.get("Set-Cookie")!.split(";")[0]!;
  const response = await app.request(
    "https://cpchub.net/accounts/passkeys/register/verify/",
    { method: "POST", headers: { Cookie: cookie }, body: "{}" },
    f.env,
    f.context,
  );
  assert.equal(response.status, 403);
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_passkey_challenge").get()!
      .n,
    0,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_passkey").get()!.n,
    0,
  );
});

void test("upload quota responses tell API clients when to retry", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const item = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
  });
  for (let n = 0; n < 16; n++)
    f.insert("hub_uploadevent", { user_id: 1, created_at: now() });
  const body = new FormData();
  body.set("file", new File(["native"], "test.cpbp"));
  body.set("version", "1");
  const response = await f.request(
    `/api/v1/items/${item.id}/releases/`,
    "POST",
    body,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_job").get()!.n,
    0,
  );
});
