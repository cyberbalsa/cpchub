import { userById } from "../src/auth";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { maintenance, processJob } from "../src/uploads";
import { selfAction } from "../src/catalog";
import { removeScreenshot } from "../src/api";
import worker from "../src/index";
import { uuid, publicId } from "../src/env";

const DAY = 86400000,
  clock = Date.parse("2026-10-18T12:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
const author = async (f: Fixture) => {
  const u = await userById(f.env, 1);
  assert(u);
  return u;
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
function item(f: Fixture, deleted_at: string | null = null) {
  return f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
    title: "Cleanup audit",
    summary: "Summary",
    description: "Description",
    status: "draft",
    deleted_at,
  });
}
function count(f: Fixture, table: string) {
  return Number(f.sqlite.prepare("SELECT COUNT(*) n FROM " + table).get()!.n);
}
function activity(f: Fixture, time: number) {
  return f.insert("hub_accountactivity", {
    id: null,
    user_id: 1,
    created_at: iso(time),
    action: "login",
  });
}
function marker(
  f: Fixture,
  item_id: string,
  time: number,
  network = "192.0.2.1",
) {
  f.insert("hub_downloadip", {
    id: null,
    item_id,
    network,
    expires_at: iso(time),
  });
}
function pending(f: Fixture, item_id: string) {
  const id = uuid();
  f.insert("hub_uploadjob", {
    id,
    item_id,
    kind: "screenshot",
    status: "pending",
    metadata: '{"caption":"Audit","type":"blueprints"}',
    created_at: iso(clock - 60000),
    submitted_by_id: 1,
  });
  f.insert("worker_job", { id, object_key: "incoming/" + id });
  return id;
}

void test("timeout cleanup cannot interrupt a newly claimed queue job or delete its creation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  t.after(f.close);
  const creation = item(f, iso(clock - 15 * DAY));
  const id = pending(f, creation.id);
  f.sqlite
    .prepare("UPDATE hub_uploadjob SET created_at=? WHERE id=?")
    .run(iso(clock - DAY), id);
  const prepare = f.db.prepare;
  let raced = false;
  t.mock.method(f.db, "prepare", (sql: string) => {
    if (
      !raced &&
      sql.startsWith("UPDATE worker_job SET lease_until=? WHERE id=?")
    ) {
      raced = true;
      f.sqlite
        .prepare("UPDATE worker_job SET lease_until=? WHERE id=?")
        .run(clock + 1200000, id);
    }
    return prepare(sql);
  });
  await maintenance(f.env);
  assert(raced);
  assert.equal(
    f.sqlite.prepare("SELECT status FROM hub_uploadjob WHERE id=?").get(id)!
      .status,
    "pending",
  );
  assert.equal(count(f, "hub_item"), 1);
  assert.equal(count(f, "hub_filedeletion"), 0);
  t.mock.timers.setTime(clock + 1200000);
  await maintenance(f.env);
  assert.equal(count(f, "hub_item"), 0);
  assert.equal(count(f, "worker_job"), 0);
});

void test("healthy scheduled invocation purges old records/files and preserves live data and counters", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const old = item(f, iso(clock - 15 * DAY)),
      fresh = item(f, iso(clock - 13 * DAY)),
      live = item(f);
    const release = uuid(),
      shot = uuid(),
      publicKey = "11111111-1111-4111-8111-111111111111-aaaaaaaaaaaaaaaa.webp";
    f.insert("hub_release", {
      id: release,
      item_id: old.id,
      version: "1",
      file: "releases/old.cpbp",
      file_stats: "{}",
    });
    f.insert("hub_screenshot", { id: shot, item_id: old.id, image: publicKey });
    f.insert("hub_screenshot", {
      id: uuid(),
      item_id: fresh.id,
      image: "screenshots/keep.webp",
    });
    f.insert("hub_downloaduser", { id: null, item_id: old.id, user_id: 1 });
    f.insert("hub_downloaduser", {
      id: null,
      item_id: old.id,
      release_id: release,
      user_id: 1,
    });
    f.insert("hub_downloaduser", { id: null, item_id: live.id, user_id: 1 });
    f.insert("hub_sitemapentry", {
      id: null,
      item_id: old.id,
      path: "/items/" + old.id,
    });
    const deletions: string[] = [];
    Object.assign(f.env, {
      FILES: {
        async delete(name: string) {
          deletions.push("files:" + name);
        },
      },
      PUBLIC_IMAGES: {
        async delete(name: string) {
          deletions.push("images:" + name);
        },
      },
    });
    activity(f, clock - 15 * DAY);
    activity(f, clock - 13 * DAY);
    marker(f, live.id, clock - 1);
    marker(f, live.id, clock + 1, "192.0.2.2");
    f.insert("worker_nonce", { nonce: "old", expires_at: clock - 1 });
    f.insert("worker_nonce", { nonce: "new", expires_at: clock + 1 });
    const work: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: clock } as ScheduledController,
      f.env,
      {
        waitUntil(p: Promise<unknown>) {
          work.push(p);
        },
      } as ExecutionContext,
    );
    await Promise.all(work);
    assert.equal(count(f, "hub_item"), 2);
    assert.equal(count(f, "hub_release"), 0);
    assert.equal(count(f, "hub_screenshot"), 1);
    assert.equal(count(f, "hub_sitemapentry"), 0);
    assert.equal(count(f, "hub_downloaduser"), 1);
    assert.equal(count(f, "hub_filedeletion"), 0);
    assert.equal(count(f, "hub_accountactivity"), 1);
    assert.equal(count(f, "hub_downloadip"), 1);
    assert.equal(count(f, "worker_nonce"), 1);
    assert.deepEqual(
      deletions.sort(),
      ["files:releases/old.cpbp", "images:" + publicKey].sort(),
    );
    assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.close();
  }
});

void test("repeated self-delete must not extend the original 14-day deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f, iso(clock - 13 * DAY));
    await selfAction(f.env, await author(f), i, "delete");
    assert.equal(
      f.sqlite.prepare("SELECT deleted_at FROM hub_item WHERE id=?").get(i.id)!
        .deleted_at,
      i.deleted_at,
    );
  } finally {
    f.close();
  }
});

void test("restore must fail at exactly 14 days", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f, iso(clock - 14 * DAY));
    await assert.rejects(
      selfAction(f.env, await author(f), i, "restore"),
      /expired/,
    );
  } finally {
    f.close();
  }
});

void test("cleanup must remove creations, activity and IP markers exactly at expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    item(f, iso(clock - 14 * DAY));
    const live = item(f);
    activity(f, clock - 14 * DAY);
    marker(f, live.id, clock);
    await maintenance(f.env);
    assert.deepEqual(
      {
        items: count(f, "hub_item"),
        activity: count(f, "hub_accountactivity"),
        ips: count(f, "hub_downloadip"),
      },
      { items: 1, activity: 0, ips: 0 },
    );
  } finally {
    f.close();
  }
});

void test("a failed file deletion must not block privacy expiry or unrelated file deletions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f);
    activity(f, clock - 15 * DAY);
    marker(f, i.id, clock - 1);
    f.insert("hub_filedeletion", { id: null, name: "releases/fail.cpbp" });
    f.insert("hub_filedeletion", { id: null, name: "releases/good.cpbp" });
    const removed: string[] = [];
    Object.assign(f.env, {
      FILES: {
        async delete(name: string) {
          if (name.includes("fail")) throw Error("simulated R2 outage");
          removed.push(name);
        },
      },
    });
    await assert.rejects(maintenance(f.env), AggregateError);
    assert.deepEqual(
      {
        activity: count(f, "hub_accountactivity"),
        ips: count(f, "hub_downloadip"),
        pending: count(f, "hub_filedeletion"),
        removed,
      },
      { activity: 0, ips: 0, pending: 1, removed: ["releases/good.cpbp"] },
    );
  } finally {
    f.close();
  }
});

void test("an upload queue outage must not block 14-day cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f);
    pending(f, i.id);
    item(f, iso(clock - 15 * DAY));
    activity(f, clock - 15 * DAY);
    marker(f, i.id, clock - 1);
    Object.assign(f.env, {
      UPLOADS: {
        async send() {
          throw Error("simulated queue outage");
        },
      },
    });
    await assert.rejects(maintenance(f.env), AggregateError);
    assert.deepEqual(
      {
        items: count(f, "hub_item"),
        activity: count(f, "hub_accountactivity"),
        ips: count(f, "hub_downloadip"),
      },
      { items: 1, activity: 0, ips: 0 },
    );
  } finally {
    f.close();
  }
});

void test("upload quota records follow the Python one-hour cleanup window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    f.insert("hub_uploadevent", {
      id: null,
      user_id: 1,
      created_at: iso(clock - 2 * 3600000),
    });
    f.insert("hub_uploadevent", {
      id: null,
      user_id: 1,
      created_at: iso(clock - 30 * 60000),
    });
    await maintenance(f.env);
    assert.equal(count(f, "hub_uploadevent"), 1);
  } finally {
    f.close();
  }
});

void test("download deduplication expires and refreshes IPs after 14 days while preserving account markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f);
    f.sqlite
      .prepare("UPDATE hub_item SET status='published' WHERE id=?")
      .run(i.id);
    const r = uuid();
    f.insert("hub_release", {
      id: r,
      item_id: i.id,
      version: "1",
      file: "releases/download.cpbp",
      file_stats: "{}",
    });
    f.objects.set("releases/download.cpbp", new Uint8Array([1]));
    const path =
      "/api/v1/items/" +
      publicId(i.id) +
      "/releases/" +
      publicId(r) +
      "/download/";
    const download = async (auth = false) =>
      assert.equal(
        (
          await f.rawRequest(path, {
            headers: {
              "CF-Connecting-IP": "192.0.2.4",
              ...(auth ? { Authorization: "ApiKey " + f.key } : {}),
            },
          })
        ).status,
        200,
      );
    await download(true);
    assert.equal(
      f.sqlite.prepare("SELECT downloads FROM hub_item WHERE id=?").get(i.id)!
        .downloads,
      1,
    );
    assert.equal(count(f, "hub_downloaduser"), 2);
    assert.equal(count(f, "hub_downloadip"), 2);
    t.mock.timers.setTime(clock + 14 * DAY);
    await download();
    assert.equal(
      f.sqlite.prepare("SELECT downloads FROM hub_item WHERE id=?").get(i.id)!
        .downloads,
      2,
    );
    assert.equal(
      f.sqlite.prepare("SELECT expires_at FROM hub_downloadip LIMIT 1").get()!
        .expires_at,
      iso(clock + 28 * DAY),
    );
    t.mock.timers.setTime(clock + 29 * DAY);
    await maintenance(f.env);
    assert.equal(count(f, "hub_downloadip"), 0);
    assert.equal(count(f, "hub_downloaduser"), 2);
    await download(true);
    assert.equal(
      f.sqlite.prepare("SELECT downloads FROM hub_item WHERE id=?").get(i.id)!
        .downloads,
      2,
    );
  } finally {
    f.close();
  }
});

void test("a promoted image must still be deleted if its database commit fails before the creation expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f),
      id = pending(f, i.id);
    f.objects.set("incoming/" + id, new Uint8Array([1]));
    Object.assign(f.env, {
      IMAGE_VALIDATOR: {
        async fetch() {
          return new Response(new Uint8Array([1, 2, 3]));
        },
      },
    });
    const originalBatch = f.env.DB.batch.bind(f.env.DB);
    let fail = true;
    f.env.DB.batch = async (statements) => {
      if (fail) {
        fail = false;
        throw Error("simulated failed DB commit");
      }
      return originalBatch(statements);
    };
    await assert.rejects(processJob(f.env, id), /simulated failed DB commit/);
    const output = f.sqlite
      .prepare("SELECT output_key FROM worker_job WHERE id=?")
      .get(id)!.output_key;
    assert.equal(typeof output, "string");
    assert(typeof output === "string");
    assert(f.objects.has(output));
    f.sqlite
      .prepare("UPDATE hub_uploadjob SET created_at=? WHERE id=?")
      .run(iso(clock - 16 * 60000), id);
    await maintenance(f.env);
    f.sqlite
      .prepare("UPDATE hub_item SET deleted_at=? WHERE id=?")
      .run(iso(clock - 15 * DAY), i.id);
    await maintenance(f.env);
    assert.equal(count(f, "hub_item"), 0);
    assert.equal(count(f, "worker_job"), 0);
    assert.equal(
      f.objects.has(output),
      false,
      "Promoted image survives timeout and final creation purge without any remaining DB reference",
    );
  } finally {
    f.close();
  }
});

void test("screenshot deletion and its durable cleanup entry must commit atomically", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const f = await fixture();
  try {
    const i = item(f),
      id = uuid(),
      key = "22222222-2222-4222-8222-222222222222-bbbbbbbbbbbbbbbb.webp";
    f.insert("hub_screenshot", { id, item_id: i.id, image: key });
    f.objects.set(key, new Uint8Array([1]));
    f.sqlite.exec(
      "CREATE TRIGGER reject_cleanup BEFORE INSERT ON hub_filedeletion BEGIN SELECT RAISE(ABORT,'simulated interrupted deletion enqueue'); END;",
    );
    await assert.rejects(
      removeScreenshot(f.env, await author(f), i, id),
      /simulated interrupted deletion enqueue/,
    );
    assert.equal(
      count(f, "hub_screenshot") + count(f, "hub_filedeletion"),
      1,
      "The object must remain tracked either by its screenshot or by a deletion entry",
    );
  } finally {
    f.close();
  }
});
