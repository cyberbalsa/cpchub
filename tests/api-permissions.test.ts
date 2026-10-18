import test from "node:test";
import assert from "node:assert/strict";
import { staffFixture } from "./helpers/staff";
import { issueKey, removeScreenshot } from "../src/api";
import { userById } from "../src/auth";
import { hash, uuid, type Row } from "../src/env";

void test("API history, upload and screenshot operations enforce author and staff permissions", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("");
  const base = `/api/v1/items/${f.item.id}/`;
  for (const path of ["history/", "upload-jobs/"])
    assert.equal((await f.request(base + path)).status, 403);
  const u = await userById(f.env, 1);
  assert(u);
  await assert.rejects(
    removeScreenshot(f.env, u, f.item, f.screenshot.id),
    /Not allowed/,
  );
  f.role("Admin");
  const admin = await userById(f.env, 1);
  assert(admin);
  await assert.rejects(
    removeScreenshot(f.env, admin, f.item, uuid()),
    /not found/,
  );
  await assert.rejects(
    removeScreenshot(f.env, admin, f.item, f.screenshot.id),
    /need a screenshot/,
  );
  for (const route of ["releases/", "screenshots/"])
    assert.equal((await f.request(base + route, "POST", {})).status, 400);
});

void test("key creation restricts names, scopes and count without allowing scope escalation", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const u = await userById(f.env, 1);
  assert(u);
  const invalid: Row[] = [
    {},
    { name: "x".repeat(81) },
    { name: "x", scopes: [] },
    { name: "x", scopes: [1] },
    { name: "x", scopes: ["keys:write"] },
    { name: "x", days: 0 },
    { name: "x", days: 91 },
    { name: "x", days: 1.5 },
  ];
  for (const data of invalid) await assert.rejects(issueKey(f.env, u, data));
  await assert.rejects(
    issueKey(f.env, { ...u, scopes: ["read"] }, { name: "x", scopes: "write" }),
    /Invalid scopes/,
  );
  await assert.rejects(
    issueKey(f.env, { ...u, auth: "oauth", scopes: ["read"] }, { name: "x" }),
    /Cannot manage/,
  );
  for (let n = 0; n < 19; n++)
    await issueKey(f.env, u, { name: "Key " + n, days: n % 2 ? 7 : null });
  await assert.rejects(
    issueKey(f.env, u, { name: "overflow" }),
    /20 active keys/,
  );
  for (const method of ["GET", "DELETE"])
    assert.equal(
      (
        await f.request(
          method === "GET" ? "/api/v1/keys/" : "/api/v1/keys/missing/",
          method,
          undefined,
          "key",
        )
      ).status,
      403,
    );
});

void test("OAuth key management is isolated to the authorizing application", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const app = f.insert("oauth2_provider_application", {
    client_id: "client",
    client_type: "public",
    authorization_grant_type: "authorization-code",
    redirect_uris: "https://example.test/cb",
    name: "Manager",
  });
  f.insert("worker_token", {
    digest: await hash("access"),
    user_id: 1,
    client_id: "client",
    kind: "access",
    scope: "read write keys:write",
    family: "family",
    expires_at: Date.now() + 60000,
  });
  const call = (path: string, method = "GET", data?: unknown) =>
    f.rawRequest(path, {
      method,
      headers: {
        Authorization: "Bearer access",
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const created = await call("/api/v1/keys/", "POST", {
    name: "Manager key",
    scopes: ["read"],
  });
  assert.equal(created.status, 201);
  const key = await created.json<{ id: string }>();
  assert.equal(
    f.sqlite
      .prepare("SELECT application_id FROM hub_apikey WHERE name='Manager key'")
      .get()!.application_id,
    app.id,
  );
  const listed = await (await call("/api/v1/keys/")).json<{ count: number }>();
  assert.equal(listed.count, 1);
  const original = f.sqlite
    .prepare("SELECT id FROM hub_apikey WHERE name='Test'")
    .get()!;
  await call(`/api/v1/keys/${original.id}/`, "DELETE");
  assert.equal(
    f.sqlite
      .prepare("SELECT revoked_at FROM hub_apikey WHERE name='Test'")
      .get()!.revoked_at,
    null,
  );
  assert.equal((await call(`/api/v1/keys/${key.id}/`, "DELETE")).status, 204);
  assert(
    f.sqlite
      .prepare("SELECT revoked_at FROM hub_apikey WHERE name='Manager key'")
      .get()!.revoked_at,
  );
  f.sqlite.exec("UPDATE worker_token SET scope='read'");
  for (const [path, method] of [
    ["/api/v1/keys/", "GET"],
    ["/api/v1/keys/missing/", "DELETE"],
    ["/api/v1/keys/", "POST"],
  ])
    assert.equal(
      (await call(path!, method!, method === "GET" ? undefined : {})).status,
      403,
    );
});

void test("download routes preserve privacy, support HEAD, redirect images and deduplicate IPv6 networks", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const release = `/api/v1/items/${f.item.id}/releases/${f.release.id}/download/`,
    image = `/api/v1/items/${f.item.id}/screenshots/${f.screenshot.id}/image/`;
  assert.equal((await f.request(release)).status, 503);
  assert.equal(
    (await f.request(`/api/v1/items/${f.item.id}/releases/${uuid()}/download/`))
      .status,
    404,
  );
  f.objects.set(f.release.file, new Uint8Array([1, 2]));
  f.objects.set(f.screenshot.image, new Uint8Array([3]));
  assert.equal((await f.request(release, "HEAD")).status, 200);
  const head = await f.request(image, "HEAD");
  assert.equal(await head.text(), "");
  assert.equal(
    (await f.request(image)).headers.get("Content-Type"),
    "image/webp",
  );
  await f.request(release, "GET", undefined, "anonymous");
  assert.equal(
    f.sqlite
      .prepare("SELECT downloads FROM hub_item WHERE id=?")
      .get(f.item.id)!.downloads,
    0,
  );
  for (const ip of [
    "2001:db8::1",
    "2001:db8:0000:0:0:0:0:2",
    "::1",
    "2001::",
    ":1:2:3:4:5:6:7",
  ])
    assert.equal(
      (await f.rawRequest(release, { headers: { "CF-Connecting-IP": ip } }))
        .status,
      200,
    );
  assert.equal(
    f.sqlite
      .prepare("SELECT downloads FROM hub_item WHERE id=?")
      .get(f.item.id)!.downloads,
    4,
  );
  const key = "11111111-1111-4111-8111-111111111111-1234567812345678.webp";
  f.sqlite
    .prepare("UPDATE hub_screenshot SET image=? WHERE id=?")
    .run(key, f.screenshot.id);
  const redirect = await f.request(image);
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("Location"),
    f.env.SCREENSHOT_URL + "/" + key,
  );
});
