import test from "node:test";
import assert from "node:assert/strict";
import { staffFixture } from "./helpers/staff";
import { uuid, hash, now } from "../src/env";

void test("settings require an admin browser session and validate public OAuth callback registration", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("Moderator");
  assert.equal((await f.request("/admin/settings")).status, 403);
  f.role("Admin");
  for (const data of [
    {},
    { action: "client" },
    { action: "client", name: "x".repeat(256) },
    {
      action: "client",
      name: "test",
      redirect_uris: Array<string>(11).fill("https://a.example/cb").join("\n"),
    },
    ...[
      "not a url",
      "http://example.com",
      "ftp://example.com",
      "https://u:p@example.com",
      "https://example.com/#fragment",
      "https://example.com/" + "x".repeat(2000),
    ].map((redirect_uris) => ({
      action: "client",
      name: "test",
      redirect_uris,
    })),
  ])
    assert.equal(
      (await f.request("/admin/settings", "POST", data)).status,
      400,
    );
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "client",
        name: "𝓒𝓪𝓯é <script>",
        redirect_uris:
          "https://app.example/callback\nhttp://localhost:8080/cb\nhttp://127.0.0.1/cb\nhttp://[::1]/cb",
      })
    ).status,
    302,
  );
  const client = f.sqlite
    .prepare("SELECT * FROM oauth2_provider_application")
    .get()!;
  assert.equal(client.name, "Cafe <script>");
  assert.equal(client.client_type, "public");
  const page = await (await f.request("/admin/settings")).text();
  assert(page.includes("Cafe &lt;script&gt;"));
  f.insert("worker_token", {
    digest: await hash("token"),
    user_id: 2,
    client_id: String(client.client_id),
    kind: "access",
    scope: "read",
    expires_at: Date.now() + 60000,
    family: "family",
  });
  f.insert("hub_apikey", {
    id: uuid(),
    digest: "client-key",
    user_id: 2,
    name: "child",
    scopes: "[]",
    application_id: Number(client.id),
  });
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "revoke-client",
        id: 999,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "revoke-client",
        id: client.id,
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_token").get()!.n,
    0,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) n FROM hub_apikey WHERE digest='client-key'")
      .get()!.n,
    0,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) n FROM oauth2_provider_application")
      .get()!.n,
    0,
  );
});

void test("file type configuration requires native validators and bounded integer positions", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  assert.equal(
    (await f.request("/admin/settings", "POST", { action: "type", id: 999 }))
      .status,
    404,
  );
  for (const data of [
    { name: "", position: 0 },
    { name: "x".repeat(51), position: 0 },
    ...[-1, 10001, 1.5, "bad"].map((position) => ({ name: "name", position })),
  ])
    assert.equal(
      (
        await f.request("/admin/settings", "POST", {
          action: "type",
          id: 1,
          ...data,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "type",
        id: 2,
        name: "packs",
        position: 0,
        uploads_enabled: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "type",
        id: 1,
        name: "Ｃａｆé",
        description: "Some text",
        position: 10,
        uploads_enabled: true,
      })
    ).status,
    302,
  );
  assert.equal(
    (
      await f.request("/admin/settings", "POST", {
        action: "type",
        id: 1,
        name: "Blueprints",
        position: 0,
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT uploads_enabled FROM hub_contenttype WHERE id=1")
      .get()!.uploads_enabled,
    0,
  );
  f.insert("worker_monthly_cost", {
    id: 1,
    amount_cents: 3125,
    currency: "USD",
    month: now().slice(0, 7),
    updated_at: now(),
  });
  const page = await (await f.request("/admin/settings")).text();
  assert(page.includes("Site settings"));
  assert.equal(
    (await f.request("/admin/settings", "POST", { action: "refresh-costs" }))
      .status,
    302,
  );
});
