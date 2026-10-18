import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { socialUsername } from "../src/usernames";
import { uuid, one, type Table } from "../src/env";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function callback(f: Fixture, provider: "steam" | "discord", connect?: number) {
  const state = uuid();
  f.insert("worker_login", {
    state,
    provider,
    expires_at: Date.now() + 60000,
    nonce: connect ? String(connect) : "",
  });
  const params = new URLSearchParams({ state, code: "authorization-code" });
  if (provider === "steam") {
    const claimed = "https://steamcommunity.com/openid/id/76561198000000000";
    for (const [key, value] of Object.entries({
      ns: "http://specs.openid.net/auth/2.0",
      op_endpoint: "https://steamcommunity.com/openid/login",
      return_to:
        f.env.PUBLIC_URL + "/accounts/steam/login/callback/?state=" + state,
      identity: claimed,
      claimed_id: claimed,
      signed: "op_endpoint,claimed_id,identity,return_to,response_nonce",
      response_nonce:
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z") + uuid(),
    }))
      params.set("openid." + key, value);
  }
  return {
    params,
    request: () =>
      f.rawRequest("/accounts/" + provider + "/login/callback/?" + params, {
        headers: { Cookie: "cpc_login=" + state },
      }),
  };
}
function discordFetch(profile: unknown) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "test-provider-token" });
    assert.equal(url, "https://discord.com/api/users/@me");
    return Response.json(profile);
  };
}
const count = (f: Fixture, table: string) =>
  Number(f.sqlite.prepare("SELECT COUNT(*) n FROM " + table).get()!.n);
const social = (f: Fixture, uid: string) =>
  one<Table<"auth_user">>(
    f.env.DB,
    "SELECT u.* FROM auth_user u JOIN socialaccount_socialaccount a ON a.user_id=u.id WHERE a.uid=?",
    uid,
  );

void test("decorative, accented, non-Latin, malformed UTF-16 and empty names become bounded readable usernames", () => {
  for (const [raw, want] of [
    ["𝓑𝓪𝓵𝓼𝓪", "Balsa"],
    ["Ｂａｌｓａ", "Balsa"],
    ["ⓑⓐⓛⓢⓐ", "balsa"],
    ["Café Łukasz Straße", "Cafe Lukasz Strasse"],
    ["你好 停車", "Ni Hao Ting Che"],
    ["Привет мир", "Privet mir"],
    ["B\u200bal\u202esa 🦄", "Balsa"],
    ["Ẕ̸͑a̶̦͝l̶̡g̷̦o̷̟", "Zalgo"],
    ["\ud800Balsa\udfff", "Balsa"],
    ["  Alpha   Beta_42.-  ", "Alpha Beta_42.-"],
    ["👩🏽‍🚀", "discord"],
    ["._-", "discord"],
    ["", "discord"],
    ["𝓑".repeat(200), "B".repeat(140)],
  ] as const) {
    const actual = socialUsername(raw, "discord");
    assert.equal(actual, want);
    assert.match(actual, /^[A-Za-z0-9_ .-]{1,140}$/);
    assert.equal(socialUsername(actual, "discord"), actual);
  }
  assert.equal(socialUsername("🔥", "steam"), "steam");
});
void test("Discord first login uses the normalized display name; later sign-ins keep the same chosen account name", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const profile = {
    id: "123456789012345678",
    username: "discord_handle",
    global_name: "𝓑𝓪𝓵𝓼𝓪 🦄",
  };
  t.mock.method(globalThis, "fetch", discordFetch(profile));
  const first = await callback(f, "discord").request();
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("Location"), "/");
  assert.match(first.headers.get("Set-Cookie")!, /cpc_session=.*HttpOnly/);
  const user = await social(f, profile.id);
  assert(user);
  assert.equal(user.username, "Balsa");
  assert.equal(user.password, "!");
  assert.equal(user.is_superuser, 0);
  assert.equal(user.is_staff, 0);
  profile.global_name = "Changed upstream";
  assert.equal((await callback(f, "discord").request()).status, 302);
  assert.equal((await social(f, profile.id))!.username, "Balsa");
  assert.equal(count(f, "auth_user"), 3);
  assert.equal(count(f, "socialaccount_socialaccount"), 1);
});
void test("Discord falls back to its handle, suffixes collisions, and keeps punctuation-only names usable", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const profile of [
    { id: "123456789012345678", username: "Author", global_name: null },
    { id: "123456789012345679", username: "Second", global_name: "  " },
    { id: "123456789012345680", username: "Third", global_name: "🔥" },
  ]) {
    t.mock.method(globalThis, "fetch", discordFetch(profile));
    assert.equal((await callback(f, "discord").request()).status, 302);
  }
  assert.match(
    (await social(f, "123456789012345678"))!.username,
    /^Author_[a-f0-9]{8}$/,
  );
  assert.equal((await social(f, "123456789012345679"))!.username, "Second");
  assert.equal((await social(f, "123456789012345680"))!.username, "discord");
  assert.equal(count(f, "auth_user"), 5);
});
void test("Steam first login uses the persona name belonging to the verified Steam identity", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://steamcommunity.com/openid/login") {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("openid.mode"),
          "check_authentication",
        );
        return new Response("is_valid:true\n");
      }
      return Response.json({
        response: {
          players: [
            { steamid: "11111111111111111", personaname: "Wrong user" },
            { steamid: "76561198000000000", personaname: "Ｆａｎｃｙ Café" },
          ],
        },
      });
    },
  );
  assert.equal((await callback(f, "steam").request()).status, 302);
  assert.equal((await social(f, "76561198000000000"))!.username, "Fancy Cafe");
});
void test("social linking preserves the current name and cannot steal another account or revive inactive users", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = "123456789012345678";
  t.mock.method(
    globalThis,
    "fetch",
    discordFetch({ id, username: "Provider name" }),
  );
  assert.equal((await callback(f, "discord", 1).request()).status, 302);
  assert.equal((await social(f, id))!.username, "Author");
  assert.equal(count(f, "auth_user"), 2);
  assert.equal((await callback(f, "discord", 1).request()).status, 302);
  assert.equal((await callback(f, "discord", 2).request()).status, 409);
  assert.equal((await social(f, id))!.id, 1);
  f.sqlite.exec("UPDATE auth_user SET is_active=0 WHERE id=1");
  assert.equal((await callback(f, "discord").request()).status, 403);
  assert.equal((await callback(f, "discord", 1).request()).status, 403);
});
void test("a failed provider-link insert rolls back the newly created user", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.sqlite.exec(
    "CREATE TRIGGER reject_social BEFORE INSERT ON socialaccount_socialaccount BEGIN SELECT RAISE(ABORT,'test storage failure'); END;",
  );
  t.mock.method(
    globalThis,
    "fetch",
    discordFetch({ id: "123456789012345678", username: "New user" }),
  );
  t.mock.method(console, "error", () => {});
  assert.equal((await callback(f, "discord").request()).status, 500);
  assert.equal(count(f, "auth_user"), 2);
  assert.equal(count(f, "socialaccount_socialaccount"), 0);
});
void test("provider responses and login state are validated before creating an account", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const profile of [
    { id: 12, username: "Wrong" },
    { id: "123456789012345678", username: [] },
    { id: "", username: "Wrong" },
  ]) {
    t.mock.method(globalThis, "fetch", discordFetch(profile));
    assert.equal((await callback(f, "discord").request()).status, 403);
  }
  const request = callback(f, "discord");
  request.params.set("state", "wrong");
  assert.equal((await request.request()).status, 403);
  const expired = callback(f, "discord");
  f.sqlite.exec("UPDATE worker_login SET expires_at=0");
  assert.equal((await expired.request()).status, 403);
  assert.equal(count(f, "auth_user"), 2);
});
void test("login initiation validates the provider and configuration and records browser-bound state", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const provider of ["discord", "steam"]) {
    const response = await f.request(
      "/accounts/" + provider + "/login/",
      "POST",
    );
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("Location")!);
    assert.equal(
      target.hostname,
      provider === "steam" ? "steamcommunity.com" : "discord.com",
    );
    assert.match(response.headers.get("Set-Cookie")!, /cpc_login=.*HttpOnly/);
  }
  assert.equal(
    (await f.request("/accounts/unknown/login/", "POST")).status,
    404,
  );
  f.env.DISCORD_CLIENT_SECRET = "";
  assert.equal(
    (await f.request("/accounts/discord/login/", "POST")).status,
    503,
  );
});

void test("Discord token failures and Steam assertion validation reject untrusted identities", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const mode of ["token-http", "token-data", "profile-http"] as const) {
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
      String(input).endsWith("/token")
        ? Response.json(
            mode === "token-data" ? {} : { access_token: "token" },
            { status: mode === "token-http" ? 503 : 200 },
          )
        : new Response(null, { status: 503 }),
    );
    const request = callback(f, "discord");
    request.params.delete("code");
    assert.equal((await request.request()).status, 403);
  }
  for (const key of [
    "openid.ns",
    "openid.op_endpoint",
    "openid.return_to",
    "openid.identity",
    "openid.claimed_id",
    "openid.signed",
  ]) {
    const request = callback(f, "steam");
    request.params.delete(key);
    assert.equal((await request.request()).status, 403);
  }
  for (const nonce of ["", "invalid", "2000-01-01T00:00:00Zrandom"]) {
    const request = callback(f, "steam");
    request.params.set("openid.response_nonce", nonce);
    assert.equal((await request.request()).status, 403);
  }
  for (const response of [
    () => new Response(null, { status: 503 }),
    () => new Response("is_valid:false\n"),
  ]) {
    t.mock.method(globalThis, "fetch", async () => response());
    assert.equal((await callback(f, "steam").request()).status, 403);
  }
  const request = callback(f, "steam");
  f.insert("worker_nonce", {
    nonce: request.params.get("openid.response_nonce")!,
    expires_at: Date.now() + 60000,
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("is_valid:true\n"),
  );
  assert.equal((await request.request()).status, 403);
  assert.equal(
    (await f.rawRequest("/accounts/steam/login/callback/", {})).status,
    403,
  );
  assert.equal(
    (
      await f.rawRequest(
        "/accounts/discord/login/callback/?state=missing-cookie",
        {},
      )
    ).status,
    403,
  );
  const state = uuid();
  f.insert("worker_login", {
    state,
    provider: "unsupported",
    expires_at: Date.now() + 60000,
  });
  assert.equal(
    (
      await f.rawRequest(
        "/accounts/unsupported/login/callback/?state=" + state,
        { headers: { Cookie: "cpc_login=" + state } },
      )
    ).status,
    404,
  );
  assert.equal(count(f, "auth_user"), 2);
});

void test("Steam remains usable when its optional display-name lookup is unavailable or incomplete", async (t) => {
  for (const mode of [
    "missing-key",
    "http",
    "invalid",
    "empty",
    "mismatch",
  ] as const) {
    const f = await fixture();
    t.after(f.close);
    if (mode === "missing-key") f.env.STEAM_API_KEY = "";
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
      if (String(url).includes("steamcommunity.com"))
        return new Response("is_valid:true\r\n");
      if (mode === "http") return new Response(null, { status: 503 });
      return Response.json(
        mode === "invalid"
          ? {}
          : {
              response: {
                players:
                  mode === "empty"
                    ? []
                    : [{ steamid: "other", personaname: "Other" }],
              },
            },
      );
    });
    assert.equal((await callback(f, "steam").request()).status, 302);
    assert.equal(
      (await social(f, "76561198000000000"))!.username,
      "Steam 000000",
    );
  }
});

void test("concurrent social creation reuses the winning identity and repeated username collisions stay bounded", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const id = "123456789012345678";
  t.mock.method(globalThis, "fetch", discordFetch({ id, username: "Author" }));
  const request = callback(f, "discord");
  const batch = t.mock.method(f.db, "batch", async () => {
    f.insert("socialaccount_socialaccount", {
      provider: "discord",
      uid: id,
      user_id: 1,
      extra_data: "{}",
    });
    throw Error(
      "UNIQUE constraint failed: socialaccount_socialaccount.provider, socialaccount_socialaccount.uid",
    );
  });
  assert.equal((await request.request()).status, 302);
  assert.equal(count(f, "auth_user"), 2);
  batch.mock.restore();
  f.sqlite.exec("DELETE FROM socialaccount_socialaccount");
  f.insert("auth_user", { username: "Author_11111111", is_active: 1 });
  const conflict = callback(f, "discord");
  t.mock.method(
    crypto,
    "randomUUID",
    () => "11111111-1111-4111-8111-111111111111",
  );
  assert.equal((await conflict.request()).status, 409);
  assert.equal(count(f, "auth_user"), 3);
});

void test("a social account removed immediately after creation fails without granting a session", async (t) => {
  const f = await fixture();
  t.after(f.close);
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    discordFetch({ id: "123456789012345678", username: "New" }),
  );
  const batch = f.db.batch.bind(f.db);
  t.mock.method(f.db, "batch", async (statements: D1PreparedStatement[]) => {
    const result = await batch(statements);
    f.sqlite.exec("DELETE FROM auth_user WHERE username='New'");
    return result;
  });
  assert.equal((await callback(f, "discord").request()).status, 500);
  assert.equal(count(f, "worker_session"), 1);
});
