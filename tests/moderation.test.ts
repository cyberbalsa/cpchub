import test from "node:test";
import assert from "node:assert/strict";
import { staffFixture } from "./helpers/staff";
import { uuid, now } from "../src/env";

void test("moderator restoration rechecks the deadline before writing or logging success", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.sqlite
    .prepare("UPDATE hub_item SET deleted_at=? WHERE id=?")
    .run(now(), f.item.id);
  const prepare = f.db.prepare;
  t.mock.method(f.db, "prepare", (sql: string) => {
    if (sql.startsWith("UPDATE hub_item SET deleted_at=NULL"))
      f.sqlite
        .prepare("UPDATE hub_item SET deleted_at=? WHERE id=?")
        .run(new Date(Date.now() - 15 * 86400000).toISOString(), f.item.id);
    return prepare(sql);
  });
  const response = await f.request(`/moderation/items/${f.item.id}/`, "POST", {
    action: "restore-deleted",
  });
  assert.equal(response.status, 403);
  assert(
    f.sqlite
      .prepare("SELECT deleted_at FROM hub_item WHERE id=?")
      .get(f.item.id)!.deleted_at,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_moderationlog").get()!.n,
    0,
  );
});

void test("moderation dashboards, reviews and users paginate and filter records", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.insert("hub_moderationlog", {
    action: "hide",
    actor_id: null,
    item_id: f.item.id,
    item_title: f.item.title,
  });
  for (let i = 3; i < 55; i++)
    f.insert("auth_user", { id: i, username: "Member" + i, is_active: 1 });
  for (const path of [
    "/moderation/",
    "/moderation/?state=hidden&q=Test",
    "/moderation/?state=draft",
    "/moderation/?state=highlighted",
    "/moderation/?state=deleted",
    "/moderation/users/",
    "/moderation/users/?page=2",
    "/moderation/users/?q=不存在",
    "/moderation/reviews/",
    "/moderation/reviews/?state=seen&q=Test",
    `/moderation/items/${f.item.id}/`,
  ])
    assert.equal((await f.request(path)).status, 200, path);
  for (const [page, expected] of [
    [1, 50],
    [2, 4],
  ] as const) {
    const html = await (
      await f.request("/moderation/users/?page=" + page)
    ).text();
    assert.equal((html.match(/>Manage<\/a>/g) || []).length, expected);
    assert(html.includes(`Page ${page} of 2`));
  }
  const path = `/moderation/items/${f.item.id}/`;
  assert.equal(
    (await f.request(path, "POST", { action: "review", content_revision: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request(path, "POST", {
        action: "mark-reviewed",
        content_revision: 2,
        note: "Café <b>note</b>",
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT note FROM hub_itemreview").get()!.note,
    "Cafe <b>note</b>",
  );
  assert.equal(
    (await f.request("/moderation/reviews/?state=seen")).status,
    200,
  );
  assert.equal(
    (
      await f.request(path, "POST", {
        action: "mark-seen",
        content_revision: 2,
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_itemreview").get()!.n,
    1,
  );
  f.role("");
  assert.equal((await f.request("/moderation/")).status, 403);
  assert.equal(
    (await f.request("/moderation/", "GET", undefined, "key")).status,
    403,
  );
});

void test("reviewers can hide and review, managers restore, and expired deletions remain unrestorable", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("Reviewer");
  const path = `/moderation/items/${f.item.id}/`;
  assert.equal(
    (await f.request(path, "POST", { action: "highlight" })).status,
    302,
  );
  assert(
    f.sqlite
      .prepare("SELECT featured_at FROM hub_item WHERE id=?")
      .get(f.item.id)!.featured_at,
  );
  assert.equal(
    (await f.request(path, "POST", { action: "unhighlight" })).status,
    302,
  );
  assert.equal((await f.request(path, "POST", { action: "hide" })).status, 400);
  assert.equal(
    (await f.request(path, "POST", { action: "hide", reason: "Café reason" }))
      .status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT hidden_reason FROM hub_item WHERE id=?")
      .get(f.item.id)!.hidden_reason,
    "Cafe reason",
  );
  assert.equal(
    (await f.request(path, "POST", { action: "highlight" })).status,
    400,
  );
  assert.equal(
    (await f.request(path, "POST", { action: "restore" })).status,
    403,
  );
  assert.equal((await f.request(path, "POST", {})).status, 403);
  f.role("Moderator");
  assert.equal(
    (await f.request(path, "POST", { action: "restore" })).status,
    302,
  );
  f.sqlite
    .prepare("UPDATE hub_item SET deleted_at=? WHERE id=?")
    .run(now(), f.item.id);
  assert.equal(
    (await f.request(path, "POST", { action: "restore-deleted" })).status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT deleted_at FROM hub_item WHERE id=?")
      .get(f.item.id)!.deleted_at,
    null,
  );
  f.sqlite
    .prepare("UPDATE hub_item SET deleted_at='2000-01-01T00:00:00Z' WHERE id=?")
    .run(f.item.id);
  assert.equal(
    (await f.request(path, "POST", { action: "restore-deleted" })).status,
    403,
  );
  assert.equal((await f.request(path + "delete/")).status, 403);
  f.role("Admin");
  assert.equal((await f.request(path + "delete/")).status, 200);
  assert.equal((await f.request(path + "delete/", "POST", {})).status, 302);
  assert(
    Date.parse(
      String(
        f.sqlite
          .prepare("SELECT deleted_at FROM hub_item WHERE id=?")
          .get(f.item.id)!.deleted_at,
      ),
    ) <=
      Date.now() - 14 * 86400000,
  );
});

void test("file moderation restricts roles, escapes metadata and transactionally queues deleted objects", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  for (const [kind, file] of [
    ["releases", f.release],
    ["screenshots", f.screenshot],
  ] as const) {
    const base = `/moderation/items/${f.item.id}/${kind}/${file.id}/`;
    f.role("Reviewer");
    assert.equal((await f.request(base + "edit/")).status, 403);
    f.role("Moderator");
    assert.equal((await f.request(base + "delete/")).status, 403);
    assert.equal((await f.request(base + "edit/")).status, 200);
    if (kind === "releases") {
      for (const version of [undefined, 1, "!"])
        assert.equal(
          (await f.request(base + "edit/", "POST", { version })).status,
          400,
        );
      assert.equal(
        (
          await f.request(base + "edit/", "POST", {
            version: "2",
            game_version: "3",
            changelog: "Café <script>",
          })
        ).status,
        302,
      );
      assert.equal(
        (await f.request(base + "edit/", "POST", { version: "3" })).status,
        302,
      );
    } else {
      assert.equal(
        (await f.request(base + "edit/", "POST", { caption: "Café <script>" }))
          .status,
        302,
      );
      const page = await (await f.request(base + "edit/")).text();
      assert(page.includes("Cafe &lt;script&gt;"));
      assert.equal((await f.request(base + "edit/", "POST", {})).status, 302);
    }
    f.role("Admin");
    assert.equal((await f.request(base + "delete/")).status, 200);
    assert.equal(
      (await f.request(base + "delete/", "POST", { reason: "cleanup" })).status,
      302,
    );
    assert.equal((await f.request(base + "edit/")).status, 404);
  }
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    2,
  );
  assert.equal(
    f.sqlite.prepare("SELECT status FROM hub_item WHERE id=?").get(f.item.id)!
      .status,
    "draft",
  );
});

void test("admin retention activity filters and upload/tag settings enforce their limits", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.insert("hub_accountactivity", {
    user_id: 2,
    action: "login",
    ip_address: "192.0.2.1",
    created_at: now(),
  });
  f.insert("hub_accountactivity", {
    user_id: 2,
    action: "login",
    created_at: "2000-01-01",
  });
  for (const path of [
    "/moderation/activity/",
    "/moderation/activity/?user=2&username=Other&action=login&ip=192.0.2.1&page=1",
    "/moderation/activity/?page=2",
  ])
    assert.equal((await f.request(path)).status, 200);
  for (const [path, col, max] of [
    ["tags", "minimum_items", 100000],
    ["uploads", "max_file_mb", 100],
  ] as const) {
    assert.equal((await f.request(`/moderation/${path}/`)).status, 200);
    for (const value of [0, 1.5, max + 1, "bad"])
      assert.equal(
        (await f.request(`/moderation/${path}/`, "POST", { [col]: value }))
          .status,
        400,
      );
    assert.equal(
      (await f.request(`/moderation/${path}/`, "POST", { [col]: max })).status,
      302,
    );
    f.sqlite.exec(
      `DELETE FROM hub_${path === "tags" ? "tag" : "upload"}settings`,
    );
    assert.equal((await f.request(`/moderation/${path}/`)).status, 200);
    f.role("Moderator");
    assert.equal((await f.request(`/moderation/${path}/`)).status, 403);
    f.role("Admin");
  }
  f.role("Moderator");
  assert.equal((await f.request("/moderation/activity/")).status, 403);
});

void test("user moderation protects staff, validates roles and revokes disabled account credentials", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.insert("socialaccount_socialaccount", {
    provider: "discord",
    uid: "11111111111111111",
    user_id: 2,
    extra_data: "{}",
  });
  const path = "/moderation/users/2/";
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await f.request("/moderation/users/999/")).status, 404);
  assert.equal(
    (await f.request("/moderation/users/1/", "POST", { action: "revoke" }))
      .status,
    400,
  );
  f.role("Reviewer");
  for (const p of ["/moderation/users/", path])
    assert.equal((await f.request(p)).status, 403);
  f.role("Moderator");
  assert.equal(
    (await f.request(path, "POST", { action: "revoke" })).status,
    403,
  );
  assert.equal(
    (await f.request(path, "POST", { action: "shadow-ban" })).status,
    400,
  );
  assert.equal(
    (await f.request(path, "POST", { action: "shadow-ban", reason: "Reason" }))
      .status,
    302,
  );
  assert(
    f.sqlite
      .prepare(
        "SELECT shadow_banned_at FROM hub_usermoderation WHERE user_id=2",
      )
      .get()!.shadow_banned_at,
  );
  assert.equal((await f.request(path)).status, 200);
  assert.equal(
    (
      await f.request(path, "POST", {
        action: "remove-shadow-ban",
        reason: "Resolved",
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT shadow_banned_at FROM hub_usermoderation WHERE user_id=2",
      )
      .get()!.shadow_banned_at,
    null,
  );
  for (const role of ["Reviewer", "Admin"] as const) {
    f.role(role, 2);
    assert.equal((await f.request(path)).status, 200);
    assert.equal(
      (
        await f.request(path, "POST", {
          action: "shadow-ban",
          reason: "Reason",
        })
      ).status,
      403,
    );
  }
  f.role("Admin");
  assert.equal(
    (await f.request(path, "POST", { role: "invalid" })).status,
    400,
  );
  assert.equal(
    (
      await f.request(path, "POST", {
        role: "Admin",
        username: "Ｃａｆé",
        is_active: true,
      })
    ).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT username FROM auth_user WHERE id=2").get()!
      .username,
    "Cafe",
  );
  assert.equal((await f.request(path)).status, 200);
  f.insert("worker_session", {
    digest: "target",
    user_id: 2,
    csrf: "target",
    expires_at: Date.now() + 10000,
  });
  f.insert("hub_apikey", {
    id: uuid(),
    user_id: 2,
    digest: "target",
    name: "key",
    scopes: "[]",
  });
  assert.equal(
    (await f.request(path, "POST", { action: "revoke" })).status,
    302,
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) n FROM worker_session WHERE user_id=2")
      .get()!.n,
    0,
  );
  assert(
    f.sqlite.prepare("SELECT revoked_at FROM hub_apikey WHERE user_id=2").get()!
      .revoked_at,
  );
  assert.equal((await f.request(path, "POST", {})).status, 302);
  assert.equal(
    f.sqlite.prepare("SELECT is_active FROM auth_user WHERE id=2").get()!
      .is_active,
    0,
  );
  assert.equal((await f.request(path)).status, 200);
});

void test("account deletion is admin-only and leaves every owned file in the durable deletion queue", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  f.role("Moderator");
  assert.equal((await f.request("/moderation/users/2/delete/")).status, 403);
  f.role("Admin");
  for (const id of [1, 999])
    assert.equal(
      (await f.request(`/moderation/users/${id}/delete/`)).status,
      400,
    );
  assert.equal((await f.request("/moderation/users/2/delete/")).status, 200);
  assert.equal(
    (await f.request("/moderation/users/2/delete/", "POST", {})).status,
    302,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM auth_user WHERE id=2").get()!.n,
    0,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    2,
  );
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});
