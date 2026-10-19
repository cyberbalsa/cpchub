import test from "node:test";
import assert from "node:assert/strict";
import { staffFixture } from "./helpers/staff";
import { uuid } from "../src/env";
import { deleteStoredFiles } from "../src/storage-cleanup";

for (const kind of ["item", "user", "release", "screenshot"] as const)
  void test(`immediate ${kind} deletion wipes its data and storage before redirecting`, async (t) => {
    const f = await staffFixture();
    t.after(f.close);
    const removed: string[] = [];
    t.mock.method(f.env.FILES, "delete", async (key: string) => {
      removed.push(key);
    });
    t.mock.method(f.env.PUBLIC_IMAGES, "delete", async (key: string) => {
      removed.push(key);
    });
    t.mock.method(f.env.QUARANTINE, "delete", async (key: string) => {
      removed.push(key);
    });
    f.insert("hub_accountactivity", {
      user_id: 2,
      item_id: f.item.id,
      item_title: f.item.title,
    });
    f.insert("hub_moderationlog", {
      target_user_id: 2,
      item_id: f.item.id,
      item_title: f.item.title,
    });
    const job = uuid();
    f.insert("hub_uploadjob", {
      id: job,
      item_id: f.item.id,
      kind: "release",
      metadata: "{}",
      submitted_by_id: 2,
      status: "complete",
      release_id: f.release.id,
    });
    f.insert("worker_job", {
      id: job,
      object_key: "incoming/test",
      output_key: f.release.file,
    });
    f.insert("hub_filedeletion", { name: "unrelated", bucket: "files" });
    const path =
      kind === "user"
        ? "/moderation/users/2/delete/"
        : kind === "item"
          ? `/moderation/items/${f.item.id}/delete/`
          : `/moderation/items/${f.item.id}/${kind === "release" ? "releases" : "screenshots"}/${kind === "release" ? f.release.id : f.screenshot.id}/delete/`;
    assert.match(await (await f.request(path)).text(), /name="delete_now"/);
    f.role("Moderator");
    assert.equal(
      (await f.request(path, "POST", { delete_now: "on" })).status,
      403,
    );
    f.role("Admin");
    assert.equal(
      (await f.request(path, "POST", { delete_now: "on" })).status,
      302,
    );
    assert(!removed.includes("unrelated"));
    assert(
      removed.includes(
        kind === "screenshot" ? f.screenshot.image : f.release.file,
      ),
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
      1,
    );
    if (kind === "item" || kind === "user") {
      for (const table of [
        "hub_item",
        "hub_release",
        "hub_screenshot",
        "hub_uploadjob",
        "worker_job",
        "hub_accountactivity",
        "hub_moderationlog",
      ])
        assert.equal(
          f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,
          0,
          table,
        );
      assert(removed.includes("incoming/test"));
    }
    if (kind === "user")
      assert.equal(
        f.sqlite.prepare("SELECT id FROM auth_user WHERE id=2").get(),
        undefined,
      );
  });

void test("active validation blocks immediate deletion without partial mutations", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const job = uuid();
  f.insert("hub_uploadjob", {
    id: job,
    item_id: f.item.id,
    status: "pending",
    kind: "release",
    metadata: "{}",
    submitted_by_id: 2,
  });
  f.insert("worker_job", {
    id: job,
    object_key: "incoming/test",
    lease_until: Date.now() + 60000,
  });
  const response = await f.request(`/moderation/users/2/delete/`, "POST", {
    delete_now: "on",
  });
  assert.equal(response.status, 409);
  assert(f.sqlite.prepare("SELECT id FROM auth_user WHERE id=2").get());
  assert(
    f.sqlite.prepare("SELECT id FROM hub_release WHERE id=?").get(f.release.id),
  );
  assert(f.sqlite.prepare("SELECT id FROM hub_uploadjob WHERE id=?").get(job));
});

void test("storage failure reports incomplete wipe and retains durable cleanup for retry", async (t) => {
  const f = await staffFixture();
  t.after(f.close);
  const mock = t.mock.method(f.env.FILES, "delete", async () => {
    throw Error("unavailable");
  });
  const response = await f.request(
    `/moderation/items/${f.item.id}/delete/`,
    "POST",
    { delete_now: "on" },
  );
  assert.equal(response.status, 503);
  assert.equal(
    f.sqlite.prepare("SELECT id FROM hub_item WHERE id=?").get(f.item.id),
    undefined,
  );
  assert(
    Number(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    ) > 0,
  );
  mock.mock.restore();
  await deleteStoredFiles(f.env);
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    0,
  );
});
