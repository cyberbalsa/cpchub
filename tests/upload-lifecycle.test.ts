import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { userById } from "../src/auth";
import { submit, processJob, jobJSON } from "../src/uploads";
import {
  deleteStoredFiles,
  queueDeletion,
  jobCleanupStatements,
} from "../src/storage-cleanup";
import { UploadedFile } from "../src/multipart";
import { uuid, dbId, hash, now, HttpError } from "../src/env";
import type { FileStatistics } from "../src/upload-schemas";
import { blueprint, scenario } from "./helpers/native";

async function setup(type: "blueprints" | "scenarios" = "blueprints") {
  const f = await fixture();
  const row = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: type === "blueprints" ? 1 : 3,
    title: "Lifecycle",
    status: "draft",
  });
  const user = await userById(f.env, 1);
  assert(user);
  const item = { ...row, type_slug: type };
  const file = new File(
    [type === "blueprints" ? blueprint() : scenario()],
    "folder/native" + (type === "blueprints" ? ".cpbp" : ".cpcs"),
  );
  const stats: FileStatistics = {
    schema_version: 1,
    kind: type === "blueprints" ? "blueprint" : "scenario",
    width: 1,
    height: 1,
    depth: 1,
  };
  return { ...f, user, item, file, stats };
}

void test("successful native uploads persist verified bytes and publish only after both required assets exist", async (t) => {
  for (const type of ["blueprints", "scenarios"] as const) {
    const f = await setup(type);
    t.after(f.close);
    t.mock.method(f.env.VALIDATOR, "fetch", async () => Response.json(f.stats));
    t.mock.method(
      f.env.IMAGE_VALIDATOR,
      "fetch",
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    f.sqlite
      .prepare("UPDATE hub_item SET publish_after_validation=1 WHERE id=?")
      .run(f.item.id);
    const job = await submit(f.env, f.user, f.item, f.file, "release", {
      version: "1",
      game_version: "2",
      changelog: "Changes",
    });
    assert.equal(job.get_status_display, "Checking");
    assert.equal(
      job.original_filename,
      type === "blueprints" ? "native.cpbp" : "native.cpcs",
    );
    await processJob(f.env, dbId(job.id));
    const result = f.sqlite
      .prepare("SELECT * FROM hub_release WHERE id=?")
      .get(dbId(job.id));
    assert(result);
    assert.equal(result.sha256, await hash(await f.file.arrayBuffer()));
    assert.equal(result.file_stats, JSON.stringify(f.stats));
    assert.equal(
      f.sqlite.prepare("SELECT status FROM hub_item WHERE id=?").get(f.item.id)!
        .status,
      "draft",
    );
    assert.equal(f.objects.size, 1);
    const shot = await submit(
      f.env,
      f.user,
      f.item,
      new File(["image"], "pic.png"),
      "screenshot",
      { caption: "Caption" },
    );
    await processJob(f.env, dbId(shot.id));
    assert.equal(
      f.sqlite.prepare("SELECT status FROM hub_item WHERE id=?").get(f.item.id)!
        .status,
      "published",
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
      0,
    );
    const native = await f.db
      .prepare("SELECT * FROM hub_uploadjob WHERE id=?")
      .bind(dbId(job.id))
      .first<import("../src/env").Table<"hub_uploadjob">>();
    assert(native);
    const screenshot = await f.db
      .prepare("SELECT * FROM hub_uploadjob WHERE id=?")
      .bind(dbId(shot.id))
      .first<import("../src/env").Table<"hub_uploadjob">>();
    assert(screenshot);
    assert.equal(jobJSON(native).get_status_display, "Passed");
    assert.equal(jobJSON(native).release, job.id);
    assert.equal(jobJSON(screenshot).screenshot, shot.id);
    await processJob(f.env, dbId(job.id));
    await processJob(f.env, uuid());
    assert.equal(f.objects.size, 2);
  }
});

void test("submission rejects invalid sizes, file extensions and versions before staging", async (t) => {
  const f = await setup();
  t.after(f.close);
  for (const file of [
    null,
    new File([], "x.cpbp"),
    new UploadedFile("x.cpbp", NaN, "bad", "bad"),
    new UploadedFile("x.cpbp", 100 * 1024 * 1024, "bad", "bad"),
  ])
    await assert.rejects(
      submit(f.env, f.user, f.item, file, "release", { version: "1" }),
      /size limit/,
    );
  await assert.rejects(
    submit(f.env, f.user, f.item, new File(["a"], "x.cpcs"), "release", {
      version: "1",
    }),
    /extension/,
  );
  for (const version of [undefined, "!", "x".repeat(41)])
    await assert.rejects(
      submit(f.env, f.user, f.item, f.file, "release", { version }),
      /version/,
    );
  assert.equal(f.objects.size, 0);
  f.sqlite.exec("DELETE FROM hub_uploadsettings");
  const key = "incoming/staged";
  const bytes = await f.file.arrayBuffer();
  await f.env.QUARANTINE.put(key, bytes);
  const staged = new UploadedFile(
    "C:\\native.cpbp",
    f.file.size,
    key,
    await hash(bytes),
  );
  const job = await submit(f.env, f.user, f.item, staged, "release", {
    version: "staged",
  });
  assert.equal(job.original_filename, "native.cpbp");
  assert.equal(
    f.sqlite.prepare("SELECT object_key FROM worker_job").get()!.object_key,
    key,
  );
});

void test("database rejection rolls back jobs and removes staged files with actionable quota errors", async (t) => {
  for (const [reason, status, message] of [
    ["upload_quota", 429, "16 uploads"],
    ["queue_full", 503, "queue is full"],
    ["screenshot_limit", 400, "eight screenshots"],
    ["duplicate_version", 400, "Version already exists"],
    ["database offline", 0, "database offline"],
  ] as const) {
    const f = await setup();
    t.after(f.close);
    t.mock.method(f.env.DB, "batch", async () => {
      throw new Error(reason);
    });
    await assert.rejects(
      submit(f.env, f.user, f.item, f.file, "release", { version: "1" }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, new RegExp(message));
        if (status)
          assert(error instanceof HttpError && error.status === status);
        return true;
      },
    );
    assert.equal(f.objects.size, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_uploadjob").get()!.n,
      0,
    );
  }
});

void test("queue outages retain the upload outbox and concurrent deletion returns a conflict", async (t) => {
  const f = await setup();
  t.after(f.close);
  t.mock.method(f.env.UPLOADS, "send", async () => {
    throw Error("offline");
  });
  const result = await submit(f.env, f.user, f.item, f.file, "release", {
    version: "queued",
  });
  assert.equal(result.status, "pending");
  t.mock.method(f.env.UPLOADS, "send", async () => {
    f.sqlite.prepare("DELETE FROM hub_item WHERE id=?").run(f.item.id);
  });
  await assert.rejects(
    submit(f.env, f.user, f.item, f.file, "release", { version: "deleted" }),
    /deleted while uploading/,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    2,
  );
});

void test("leased jobs are not processed twice; deleted creations and missing inputs fail durably", async (t) => {
  for (const reason of ["leased", "deleted", "missing", "rejected"] as const) {
    const f = await setup();
    t.after(f.close);
    const job = await submit(f.env, f.user, f.item, f.file, "release", {
      version: "1",
    });
    const id = dbId(job.id);
    const validator = t.mock.method(
      f.env.VALIDATOR,
      "fetch",
      async () => new Response(null, { status: 422 }),
    );
    if (reason === "leased")
      f.sqlite
        .prepare("UPDATE worker_job SET lease_until=? WHERE id=?")
        .run(Date.now() + 60000, id);
    if (reason === "deleted")
      f.sqlite
        .prepare("UPDATE hub_item SET deleted_at=? WHERE id=?")
        .run(now(), f.item.id);
    if (reason === "missing") f.objects.clear();
    await processJob(f.env, id);
    const state = await f.db
      .prepare("SELECT * FROM hub_uploadjob WHERE id=?")
      .bind(id)
      .first<import("../src/env").Table<"hub_uploadjob">>();
    assert(state);
    assert.equal(state.status, reason === "leased" ? "pending" : "failed");
    assert.equal(validator.mock.callCount(), reason === "rejected" ? 1 : 0);
    if (reason !== "leased") {
      assert.equal(jobJSON(state).get_status_display, "Failed");
      await deleteStoredFiles(f.env);
      assert.equal(f.objects.size, 0);
    }
  }
});

void test("validator outages and corrupt replies release the lease for retry without approving data", async (t) => {
  for (const response of [
    () => new Response(null, { status: 503 }),
    () => Response.json({}),
    () =>
      Response.json({
        schema_version: 1,
        kind: "scenario",
        width: 1,
        height: 1,
        depth: 1,
      }),
  ]) {
    const f = await setup();
    t.after(f.close);
    const job = await submit(f.env, f.user, f.item, f.file, "release", {
      version: "1",
    });
    const id = dbId(job.id);
    t.mock.method(f.env.VALIDATOR, "fetch", async () => response());
    await assert.rejects(processJob(f.env, id));
    assert.equal(
      f.sqlite.prepare("SELECT lease_until FROM worker_job WHERE id=?").get(id)!
        .lease_until,
      0,
    );
    assert.equal(
      f.sqlite.prepare("SELECT status FROM hub_uploadjob WHERE id=?").get(id)!
        .status,
      "pending",
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_release").get()!.n,
      0,
    );
  }
});

void test("native approval requires the same input bytes to survive all validation reads", async (t) => {
  for (const failure of [
    "missing-input",
    "missing-approved",
    "size",
    "digest",
  ] as const) {
    const f = await setup();
    t.after(f.close);
    const job = await submit(f.env, f.user, f.item, f.file, "release", {
      version: "1",
    });
    const id = dbId(job.id);
    t.mock.method(f.env.VALIDATOR, "fetch", async () => Response.json(f.stats));
    const original = f.env.QUARANTINE.get.bind(f.env.QUARANTINE);
    let reads = 0;
    t.mock.method(f.env.QUARANTINE, "get", async (key: string) => {
      reads++;
      if (
        (failure === "missing-input" && reads === 2) ||
        (failure === "missing-approved" && reads === 3)
      )
        return null;
      if (reads === 2 && (failure === "size" || failure === "digest"))
        f.objects.set(
          key,
          new Uint8Array(failure === "size" ? 1 : f.file.size),
        );
      return original(key);
    });
    if (failure.startsWith("missing"))
      await assert.rejects(processJob(f.env, id), /Missing/);
    else {
      await processJob(f.env, id);
      assert.match(
        String(
          f.sqlite
            .prepare("SELECT error FROM hub_uploadjob WHERE id=?")
            .get(id)!.error,
        ),
        /integrity/,
      );
    }
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_release").get()!.n,
      0,
    );
  }
});

void test("image retries reuse persisted output keys and reject invalid transformed sizes", async (t) => {
  const f = await setup();
  t.after(f.close);
  const job = await submit(
    f.env,
    f.user,
    f.item,
    new File(["input"], "shot.png"),
    "screenshot",
    {},
  );
  const id = dbId(job.id);
  for (const size of [0, 8 * 1024 * 1024 + 1]) {
    t.mock.method(
      f.env.IMAGE_VALIDATOR,
      "fetch",
      async () => new Response(new Uint8Array(size)),
    );
    await assert.rejects(processJob(f.env, id), /Invalid result/);
  }
  const key = "11111111-1111-4111-8111-111111111111-1234567812345678.webp";
  f.sqlite
    .prepare("UPDATE worker_job SET output_key=? WHERE id=?")
    .run(key, id);
  t.mock.method(
    f.env.IMAGE_VALIDATOR,
    "fetch",
    async () => new Response(new Uint8Array([1])),
  );
  await processJob(f.env, id);
  assert.equal(
    f.sqlite.prepare("SELECT image FROM hub_screenshot WHERE id=?").get(id)!
      .image,
    key,
  );
});

void test("cleanup defers leased objects, recognizes legacy keys and retains failures for retry", async (t) => {
  const f = await setup();
  t.after(f.close);
  const image = "11111111-1111-4111-8111-111111111111-1234567812345678.webp";
  f.insert("hub_filedeletion", { name: image });
  f.objects.set(image, new Uint8Array([1]));
  await queueDeletion(f.db, "files", "future", now(), Date.now() + 60000).run();
  await queueDeletion(f.db, "files", "future", now(), 0).run();
  f.objects.set("future", new Uint8Array([1]));
  await f.db.batch(
    jobCleanupStatements(
      f.db,
      { object_key: "incoming/failed", output_key: "releases/orphan" },
      now(),
    ),
  );
  f.objects.set("releases/orphan", new Uint8Array([1]));
  await deleteStoredFiles(f.env);
  assert.deepEqual([...f.objects.keys()], ["future"]);
  f.sqlite.exec("PRAGMA ignore_check_constraints=ON");
  f.insert("hub_filedeletion", { name: "bad-bucket", bucket: "invalid" });
  f.sqlite.exec(
    "CREATE TRIGGER fail_attempt BEFORE UPDATE OF attempts ON hub_filedeletion BEGIN SELECT RAISE(ABORT,'retry state unavailable'); END",
  );
  await assert.rejects(deleteStoredFiles(f.env), (e: unknown) => {
    assert(e instanceof AggregateError);
    assert.equal(e.errors.length, 2);
    return true;
  });
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
    2,
  );
});

void test("deleting an account during validation never promotes an untracked object", async (t) => {
  for (const kind of ["release", "screenshot"] as const) {
    const f = await setup();
    t.after(f.close);
    const job = await submit(f.env, f.user, f.item, f.file, kind, {
      version: "1",
    });
    t.mock.method(
      kind === "release" ? f.env.VALIDATOR : f.env.IMAGE_VALIDATOR,
      "fetch",
      async () => {
        f.sqlite.exec("DELETE FROM auth_user WHERE id=1");
        return kind === "release"
          ? Response.json(f.stats)
          : new Response(new Uint8Array([1]));
      },
    );
    await assert.rejects(
      processJob(f.env, dbId(job.id)),
      /deleted during validation/,
    );
    assert([...f.objects.keys()].every((key) => key.startsWith("incoming/")));
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM hub_filedeletion").get()!.n,
      1,
    );
    await deleteStoredFiles(f.env, Date.now() + 21 * 60000);
    assert.equal(f.objects.size, 0);
  }
});
