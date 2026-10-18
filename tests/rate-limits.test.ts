import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { hash, now } from "../src/env";
import { checkResponse } from "./helpers/openapi";

void test("one IP gets 300 anonymous API requests and a separate 900 authenticated requests", async () => {
  const f = await fixture();
  try {
    const headers = { "CF-Connecting-IP": "192.0.2.1" };
    for (let n = 0; n < 300; n++)
      assert.equal(
        (await f.rawRequest("/api/v1/types/", { headers })).status,
        200,
      );
    const denied = await f.rawRequest("/api/v1/types/", { headers });
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("Retry-After"), "60");
    assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
    await checkResponse("/api/v1/types/", "GET", denied);
    assert.deepEqual(await denied.json(), {
      error: "rate_limited",
      retry_after: 60,
    });
    const authenticated = { ...headers, Authorization: "Bearer " + f.key };
    for (let n = 0; n < 900; n++)
      assert.equal(
        (await f.rawRequest("/api/v1/me/", { headers: authenticated })).status,
        200,
      );
    assert.equal(
      (await f.rawRequest("/api/v1/me/", { headers: authenticated })).status,
      429,
    );
    // Changing credential type or a client-supplied forwarded IP does not reset it.
    assert.equal(
      (
        await f.rawRequest("/api/v1/me/", {
          headers: {
            ...headers,
            Cookie: "cpc_session=test-session",
            "X-Forwarded-For": "192.0.2.99",
          },
        })
      ).status,
      429,
    );
    assert.equal(
      (
        await f.rawRequest("/api/v1/types/", {
          headers: { "CF-Connecting-IP": "192.0.2.2" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.rawRequest("/api/v1/me/", {
          headers: { ...authenticated, "CF-Connecting-IP": "192.0.2.2" },
        })
      ).status,
      200,
    );
  } finally {
    f.close();
  }
});

void test("sensitive routes get 60 anonymous and 180 authenticated requests; rejected uploads do no storage work", async () => {
  const f = await fixture();
  try {
    for (const [auth, limit] of [
      ["anonymous", 60],
      ["session", 180],
    ] as const) {
      for (let n = 0; n < limit; n++)
        assert.equal(
          (
            await f.request(
              "/o/token/",
              "POST",
              { grant_type: "invalid" },
              auth,
            )
          ).status,
          400,
        );
      const denied = await f.request(
        "/o/token/",
        "POST",
        { grant_type: "invalid" },
        auth,
      );
      assert.equal(denied.status, 429);
      await checkResponse("/o/token/", "POST", denied);
    }
    let uploads = 0;
    Object.assign(f.env.QUARANTINE, {
      async createMultipartUpload() {
        uploads++;
        throw new Error("Must not reach storage");
      },
    });
    const data = new FormData();
    data.set("file", new Blob(["bad-file"]), "test.cpbp");
    const rejected = await f.request(
      "/api/v1/items/missing/releases/",
      "POST",
      data,
    );
    assert.equal(rejected.status, 429);
    assert.equal(uploads, 0);
    assert.equal(f.objects.size, 0);
    // Exhausting the sensitive allowance does not exhaust ordinary catalog reads.
    assert.equal((await f.request("/api/v1/me/")).status, 200);
  } finally {
    f.close();
  }
});

void test("only validated sessions, API keys and OAuth access tokens receive the authenticated allowance", async () => {
  const f = await fixture();
  try {
    const authenticated: string[] = [];
    f.env.API_ANON_RATE_LIMIT = {
      async limit() {
        return { success: false };
      },
    };
    f.env.API_AUTH_RATE_LIMIT = {
      async limit({ key }) {
        authenticated.push(key);
        return { success: true };
      },
    };
    f.insert("worker_token", {
      digest: await hash("valid-oauth"),
      user_id: 1,
      client_id: "manager",
      scope: "read",
      kind: "access",
      family: "test",
      expires_at: Date.now() + 60000,
    });
    const validHeaders: Record<string, string>[] = [
      { Cookie: "cpc_session=test-session" },
      { Authorization: "ApiKey " + f.key },
      { Authorization: "Bearer valid-oauth" },
    ];
    for (const headers of validHeaders) {
      assert.equal(
        (
          await f.rawRequest("/api/v1/me/", {
            headers: { ...headers, "CF-Connecting-IP": "192.0.2.1" },
          })
        ).status,
        200,
      );
    }
    const invalidHeaders: Record<string, string>[] = [
      {},
      { Cookie: "cpc_session=forged" },
      { Authorization: "Bearer fake" },
      { Authorization: "Basic " + f.key },
      { Authorization: "ApiKey cpc_forged" },
    ];
    for (const headers of invalidHeaders) {
      assert.equal(
        (await f.rawRequest("/api/v1/me/", { headers })).status,
        429,
      );
    }
    f.sqlite.prepare("UPDATE hub_apikey SET revoked_at=?").run(now());
    assert.equal(
      (await f.request("/api/v1/me/", "GET", undefined, "key")).status,
      429,
    );
    f.sqlite.exec(
      "UPDATE worker_token SET expires_at=0; UPDATE worker_session SET expires_at=0",
    );
    assert.equal(
      (
        await f.rawRequest("/api/v1/me/", {
          headers: { Authorization: "Bearer valid-oauth" },
        })
      ).status,
      429,
    );
    assert.equal((await f.request("/api/v1/me/")).status, 429);
    assert.deepEqual(authenticated, ["192.0.2.1", "192.0.2.1", "192.0.2.1"]);
  } finally {
    f.close();
  }
});

void test("API uploads and downloads count against both budgets; cache hits cannot bypass the limiter", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    f.env.SENSITIVE_AUTH_RATE_LIMIT = {
      async limit() {
        calls.push("sensitive");
        return { success: true };
      },
    };
    f.env.API_AUTH_RATE_LIMIT = {
      async limit() {
        calls.push("api");
        return { success: false };
      },
    };
    for (const suffix of [
      "releases/",
      "screenshots/",
      "releases/missing/download/",
    ]) {
      assert.equal(
        (await f.request("/api/v1/items/missing/" + suffix)).status,
        429,
      );
    }
    assert.deepEqual(calls, [
      "sensitive",
      "api",
      "sensitive",
      "api",
      "sensitive",
      "api",
    ]);
    let cacheReads = 0;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        default: {
          async match() {
            cacheReads++;
            return new Response("{}");
          },
        },
      },
    });
    f.env.API_ANON_RATE_LIMIT = {
      async limit() {
        return { success: false };
      },
    };
    assert.equal(
      (await f.request("/api/v1/types/", "GET", undefined, "anonymous")).status,
      429,
    );
    assert.equal(cacheReads, 0);
    assert.equal((await f.request("/health/")).status, 200);
  } finally {
    f.close();
  }
});
