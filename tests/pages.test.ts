import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { staffFixture } from "./helpers/staff";
import { uuid, now } from "../src/env";

function upload(shots = 1) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    title: "Ｃａｆé",
    summary: "Summary",
    description: "Description",
    content_type: "blueprints",
    status: "published",
    version: "1",
  }))
    data.set(key, value);
  data.set("file", new File(["native"], "test.cpbp"));
  for (let n = 0; n < shots; n++)
    data.append("screenshots", new File(["shot"], n + ".png"));
  return data;
}

void test("browser upload forms validate all files before creating records and accept one or multiple screenshots", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request("/upload/", "POST", {})).status, 400);
  assert.equal(
    (await f.request("/upload/", "POST", { action: "release" })).status,
    400,
  );
  for (const bad of [
    upload(0),
    upload(9),
    (() => {
      const d = upload(0);
      d.set("screenshots", "text instead of file");
      return d;
    })(),
  ]) {
    const response = await f.request("/upload/", "POST", bad);
    assert([400, 413].includes(response.status));
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM hub_item").get()!.n, 0);
  for (const n of [1, 2]) {
    const data = upload(n);
    if (n === 1) data.set("status", "draft");
    const response = await f.request("/upload/", "POST", data);
    assert.equal(response.status, 302);
    const page = await f.request(response.headers.get("Location")!);
    assert.equal(page.status, 200);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM hub_item").get()!.n, 2);
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM hub_accountactivity WHERE action='create'",
      )
      .get()!.n,
    2,
  );
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM hub_item WHERE publish_after_validation=1",
      )
      .get()!.n,
    1,
  );
});

void test("creation editor covers metadata, added assets, removals, checks and self-service actions", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.sqlite
    .prepare("UPDATE hub_item SET author_id=1,status='draft' WHERE id=?")
    .run(f.item.id);
  const path = `/items/${f.item.id}/`;
  for (const data of [
    { action: "release" },
    { action: "screenshot" },
    { action: "unknown" },
  ])
    assert.equal((await f.request(path + "edit/", "POST", data)).status, 400);
  const meta = await f.rawRequest(path + "edit/", {
    method: "POST",
    headers: {
      Cookie: "cpc_session=test-session",
      "X-CSRFToken": "test-csrf",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ title: "New title", status: "draft" }),
  });
  assert.equal(meta.status, 202);
  for (const [action, field, name] of [
    ["release", "file", "test.cpbp"],
    ["screenshot", "image", "test.png"],
  ]) {
    const data = new FormData();
    data.set("action", action!);
    data.set("version", "2");
    data.set(field!, new File(["file"], name!));
    assert.equal((await f.request(path + "edit/", "POST", data)).status, 302);
  }
  assert.equal(
    (await f.request(path + "edit/", "POST", { action: "remove-screenshot" }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.request(path + "edit/", "POST", {
        action: "remove-screenshot",
        screenshot_id: f.screenshot.id,
      })
    ).status,
    302,
  );
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await f.request(path + "checks/")).status, 200);
  for (const action of ["unpublish", "delete", "restore"]) {
    assert.equal((await f.request(path + action + "/")).status, 200);
    assert.equal(
      (await f.request(path + action + "/", "POST", {})).status,
      302,
    );
  }
  f.role("Moderator");
  f.sqlite.prepare("UPDATE hub_item SET author_id=2 WHERE id=?").run(f.item.id);
  assert.equal((await f.request(path + "edit/")).status, 200);
});

void test("catalog fragments, creator privacy, bookmarks and informational pages render", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  assert.equal(
    (await f.rawRequest("/?view=all", { headers: { "HX-Request": "true" } }))
      .status,
    200,
  );
  assert.equal((await f.request("/creators/999/")).status, 404);
  assert.equal(
    (await f.request("/creators/2/", "GET", undefined, "anonymous")).status,
    200,
  );
  for (const path of [
    "/install/",
    "/developers/",
    "/donate/",
    "/accounts/login/",
    "/accounts/logout/",
    "/out/?url=https%3A%2F%2Fexample.test%2F",
  ])
    assert.equal((await f.request(path)).status, 200);
  for (const query of [
    "",
    "javascript:alert(1)",
    "https://user:pass@example.test/",
  ])
    assert.equal(
      (await f.request("/out/?url=" + encodeURIComponent(query))).status,
      400,
    );
  assert.equal((await f.request("/accounts/3rdparty/")).status, 302);
  const path = `/items/${f.item.id}/save/`;
  assert.equal((await f.request(path, "POST", {})).status, 302);
  const toggle = await f.rawRequest(path, {
    method: "POST",
    headers: {
      Cookie: "cpc_session=test-session",
      "X-CSRFToken": "test-csrf",
      "HX-Request": "true",
    },
  });
  assert.equal(toggle.status, 200);
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_bookmark").get()!.n,
    0,
  );
  assert.equal(
    (await f.request("/account/profile/", "POST", { action: "missing" }))
      .status,
    400,
  );
  assert.equal(
    (await f.request("/account/profile/", "POST", { action: "remove-passkey" }))
      .status,
    409,
  );
});

void test("browser key and manager revocation removes only the current account's access", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const data = new URLSearchParams({
    name: "Ｃａｆé",
    scopes: "read",
    csrfmiddlewaretoken: "test-csrf",
  });
  const response = await f.rawRequest("/account/keys/", {
    method: "POST",
    body: data,
    headers: { Cookie: "cpc_session=test-session" },
  });
  assert.equal(response.status, 200);
  assert((await response.text()).includes("Cafe"));
  const key = f.sqlite
    .prepare("SELECT id FROM hub_apikey WHERE name='Cafe'")
    .get()!;
  assert.equal(
    (await f.request(`/account/keys/${key.id}/revoke/`, "POST", {})).status,
    302,
  );
  f.insert("hub_apikey", {
    id: uuid(),
    name: "Expired",
    digest: "expired",
    prefix: "expired",
    user_id: 1,
    scopes: "[]",
    expires_at: "2000-01-01",
  });
  f.insert("hub_apikey", {
    id: uuid(),
    name: "Fresh",
    digest: "fresh",
    prefix: "fresh",
    user_id: 1,
    scopes: "[]",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  const app = f.insert("oauth2_provider_application", {
    client_id: "manager",
    name: "Manager",
  });
  f.insert("worker_token", {
    digest: "manager",
    user_id: 1,
    client_id: "manager",
    scope: "read",
    kind: "access",
    family: "family",
    expires_at: Date.now() + 60000,
  });
  assert.equal((await f.request("/account/keys/")).status, 200);
  assert.equal(
    (await f.request(`/account/managers/${app.id}/revoke/`, "POST", {})).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM worker_token").get()!.n,
    0,
  );
  f.insert("hub_userpreferences", {
    user_id: 1,
    ugc_warning_version: 1,
    ugc_warning_acknowledged_at: now(),
  });
  assert.equal(
    (await f.request("/account/download-warning/reset/", "POST", {})).status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT ugc_warning_version FROM hub_userpreferences WHERE user_id=1",
      )
      .get()!.ugc_warning_version,
    0,
  );
});

void test("browser downloads require confirmation and support remembered consent, HEAD and missing files", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.objects.set(f.release.file, new Uint8Array([1]));
  const path = `/items/${f.item.id}/releases/${f.release.id}/download/`;
  assert.equal(
    (await f.request(`/items/${f.item.id}/releases/${uuid()}/download/`))
      .status,
    404,
  );
  assert.equal(
    (await f.request(path, "GET", undefined, "anonymous")).status,
    200,
  );
  assert.equal(
    (await f.request(path, "HEAD", undefined, "anonymous")).status,
    200,
  );
  assert.equal((await f.request(path)).status, 200);
  for (const remember of [false, true]) {
    const response = await f.rawRequest(path, {
      method: "POST",
      headers: {
        Cookie: "cpc_session=test-session",
        "X-CSRFToken": "test-csrf",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ remember }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json<{ remembered: boolean }>()).remembered,
      remember,
    );
  }
  assert.equal(
    (await f.request(path)).headers.get("Content-Type"),
    "application/octet-stream",
  );
  const anonymous = await f.rawRequest(path, {
    method: "POST",
    headers: {
      Cookie: "cpc_csrf=csrf",
      "X-CSRFToken": "csrf",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ skip_warning: true }),
  });
  assert.equal(anonymous.status, 302);
  assert.equal(
    (
      await f.rawRequest(path, { headers: { Cookie: "cpc_warning=1" } })
    ).headers.get("Content-Type"),
    "application/octet-stream",
  );
  assert.equal((await f.request(`/items/${f.item.id}/`)).status, 200);
});
