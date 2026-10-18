import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { fixture } from "./helpers/app";
import { Buffer } from "../src/node-buffer";
import { userById } from "../src/auth";
import { oauth } from "../src/oauth";
import { hash, type App } from "../src/env";

void test("OAuth validates callback binding, PKCE, scopes and explicit consent", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.insert("oauth2_provider_application", {
    client_id: "client",
    client_type: "public",
    authorization_grant_type: "authorization-code",
    redirect_uris: "https://example.test/cb",
    name: "<script>",
  });
  const parameters = {
    client_id: "client",
    redirect_uri: "https://example.test/cb",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: Buffer.from(await hash("a".repeat(43)), "hex").toString(
      "base64url",
    ),
  };
  const consent = await f.request(
    "/o/authorize/?" + new URLSearchParams(parameters),
  );
  assert.equal(consent.status, 200);
  assert((await consent.text()).includes("&lt;script&gt;"));
  for (const update of [
    { client_id: "missing" },
    { redirect_uri: "https://evil.test/" },
    { response_type: "token" },
    { code_challenge_method: "plain" },
    { code_challenge: "short" },
    { scope: "admin" },
  ]) {
    assert.equal(
      (
        await f.request(
          "/o/authorize/?" + new URLSearchParams({ ...parameters, ...update }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/o/authorize/", "POST", {
          ...parameters,
          ...update,
          approve: "yes",
        })
      ).status,
      400,
    );
  }
  for (const scope of [1, ["read"]]) {
    const response = await f.request("/o/authorize/", "POST", {
      ...parameters,
      scope,
      approve: "yes",
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json<{ error: string }>()).error,
      "invalid_scope",
    );
  }
  const denied = await f.request("/o/authorize/", "POST", {
    ...parameters,
    approve: "no",
    state: "state",
  });
  const target = new URL(denied.headers.get("Location")!);
  assert.equal(target.searchParams.get("error"), "access_denied");
  assert.equal(target.searchParams.get("state"), "state");
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_oauth_code").get()!.n,
    0,
  );
  const yes = await f.request("/o/authorize/", "POST", {
    ...parameters,
    approve: "yes",
  });
  assert.equal(yes.status, 302);
  const code = new URL(yes.headers.get("Location")!).searchParams.get("code");
  assert(code);
  assert.equal(
    (
      await f.request(
        "/o/token/",
        "POST",
        {
          grant_type: "authorization_code",
          ...parameters,
          code,
          code_verifier: "short",
        },
        "anonymous",
      )
    ).status,
    400,
  );
  const invalid = await f.request(
    "/o/token/",
    "POST",
    { grant_type: "authorization_code", ...parameters, client_id: ["client"] },
    "anonymous",
  );
  assert.equal(invalid.status, 400);
  f.sqlite.exec("UPDATE auth_user SET is_active=0 WHERE id=1");
  const inactive = await f.request(
    "/o/token/",
    "POST",
    {
      grant_type: "authorization_code",
      ...parameters,
      code,
      code_verifier: "a".repeat(43),
    },
    "anonymous",
  );
  assert.equal(inactive.status, 400);
  assert.equal(
    (await inactive.json<{ error: string }>()).error,
    "invalid_grant",
  );
});

void test("OAuth router rejects non-browser principals and hides database failures", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await userById(f.env, 1, "oauth");
  assert(user);
  const app = new Hono<App>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/o", oauth);
  const denied = await app.request(
    "/o/authorize/",
    { method: "POST" },
    f.env,
    f.context,
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json<{ error: string }>()).error, "access_denied");
  t.mock.method(f.env.DB, "prepare", () => {
    throw new Error("secret database detail");
  });
  const failed = await f.request(
    "/o/token/",
    "POST",
    { grant_type: "refresh_token" },
    "anonymous",
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    error: "server_error",
    error_description: "Authorization service unavailable.",
  });
  assert.match(failed.headers.get("Cache-Control")!, /no-store/);
});
