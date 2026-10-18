import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { userById } from "../src/auth";
import {
  getItem,
  saveItem,
  listItems,
  serialize,
  selfAction,
  editable,
} from "../src/catalog";
import { uuid, now, publicId, write } from "../src/env";
const fields = {
  title: "Test",
  summary: "Summary",
  description: "Description",
  content_type: "blueprints",
};

void test("catalog validates every text field, native type and publication prerequisite", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const u = await userById(f.env, 1);
  assert(u);
  for (const data of [
    {},
    { ...fields, title: 1 },
    { ...fields, title: "" },
    { ...fields, title: "x".repeat(101) },
    { ...fields, tags: "x".repeat(201) },
    { ...fields, content_type: "mods" },
    { ...fields, content_type: undefined },
    { ...fields, status: "invalid" },
  ])
    await assert.rejects(saveItem(f.env, u, data));
  let item = await saveItem(f.env, u, {
    ...fields,
    tags: "Café, TEST, test,  two   words ",
  });
  assert.equal(item.tags, "cafe, test, two words");
  await assert.rejects(
    saveItem(f.env, u, { status: "published" }, item),
    /requires/,
  );
  item = await saveItem(f.env, u, { content_type: "scenarios" }, item);
  assert.equal(item.content_type_id, 3);
  const job = f.insert("hub_uploadjob", {
    id: uuid(),
    item_id: item.id,
    kind: "release",
    status: "pending",
    metadata: '{"version":"1"}',
    submitted_by_id: 1,
  });
  await assert.rejects(
    saveItem(f.env, u, { content_type: "blueprints" }, item),
    /Cannot change/,
  );
  item = await saveItem(f.env, u, { status: "published" }, item);
  assert.equal(item.status, "draft");
  assert.equal(item.publish_after_validation, 1);
  f.sqlite
    .prepare("UPDATE hub_uploadjob SET status='passed' WHERE id=?")
    .run(job.id);
  f.insert("hub_release", {
    id: uuid(),
    item_id: item.id,
    version: "1",
    file_stats: "{}",
  });
  f.insert("hub_screenshot", { id: uuid(), item_id: item.id });
  item = await saveItem(f.env, u, { status: "published" }, item);
  assert.equal(item.status, "published");
  assert.equal(
    f.sqlite
      .prepare("SELECT COUNT(*) n FROM hub_revision WHERE item_id=?")
      .get(item.id)!.n,
    4,
  );
  const other = await userById(f.env, 2);
  assert(other);
  assert.equal(editable(item, null), false);
  await assert.rejects(saveItem(f.env, other, {}, item), /Not allowed/);
  await assert.rejects(getItem(f.env, item.id, other, true), /Only the author/);
  await assert.rejects(
    selfAction(f.env, other, item, "delete"),
    /Only the author/,
  );
  assert.throws(
    () => write({ ...u, auth: "key", scopes: ["read"] }),
    /Write scope/,
  );
  await assert.rejects(getItem(f.env, uuid(), null), /not found/);
  await selfAction(f.env, u, item, "unpublish");
  assert.equal((await getItem(f.env, item.id, u)).status, "draft");
  const stale = { ...item, deleted_at: now() };
  await assert.rejects(selfAction(f.env, u, stale, "restore"), /expired/);
  assert.equal(publicId("short"), "short");
});

void test("catalog search, tag visibility, saved views and numeric filters enforce privacy", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const u = await userById(f.env, 1);
  assert(u);
  const item = await saveItem(f.env, u, { ...fields, tags: "secret, public" });
  const other = await userById(f.env, 2);
  assert(other);
  const publicItem = await saveItem(f.env, other, {
    ...fields,
    title: "Second",
    tags: "public",
  });
  f.sqlite
    .prepare("UPDATE hub_item SET status='published' WHERE id=?")
    .run(publicItem.id);
  f.insert("hub_release", {
    id: uuid(),
    item_id: publicItem.id,
    version: "1",
    file_stats: '{"width":4}',
  });
  f.insert("hub_screenshot", {
    id: uuid(),
    item_id: publicItem.id,
    image: "11111111-1111-4111-8111-111111111111-1234567812345678.webp",
  });
  f.insert("hub_bookmark", { item_id: publicItem.id, user_id: 1 });
  for (const [query, user, expected] of [
    ["mine=true&q=secret", u, 1],
    ["view=mine", null, 0],
    ["view=saved", u, 1],
    ["view=saved", null, 0],
    ["type=scenarios", null, 0],
    ["type=blueprints&author=2", null, 1],
    ["author=bad", null, 0],
    ["q=public", null, 1],
    ["q=missing", null, 0],
    ["tag=secret", null, 0],
    ["tag=public", null, 1],
    ["mine=true&tag=secret", u, 1],
    ["min_width=3&max_width=5", null, 1],
    ["min_width=5", null, 0],
    ["sort=popular&max_width=", null, 1],
    ["sort=newest", null, 1],
  ] as const)
    assert.equal(
      (await listItems(f.env, new URLSearchParams(query), user)).count,
      expected,
      query,
    );
  for (const q of ["min_width=-1", "min_width=bad", "max_width=1.5"])
    await assert.rejects(
      listItems(f.env, new URLSearchParams(q), null),
      /Invalid file statistics/,
    );
  assert.equal(
    (await listItems(f.env, new URLSearchParams(), other, 1)).count,
    1,
  );
  assert.equal((await listItems(f.env, new URLSearchParams(), u, 1)).count, 1);
  const result = await serialize(
    f.env,
    await getItem(f.env, publicItem.id, null),
    null,
  );
  assert.equal(result.tags, "public");
  assert(result.screenshots[0]!.image_url.startsWith(f.env.SCREENSHOT_URL));
  for (let n = 0; n < 25; n++)
    f.insert("hub_item", {
      id: uuid(),
      title: "Page " + n,
      author_id: 2,
      content_type_id: 1,
      status: "published",
    });
  const first = await (
    await f.request("/api/v1/items/", "GET", undefined, "anonymous")
  ).json<{ next: string; previous: null; count: number }>();
  assert(first.next.endsWith("page=2"));
  assert.equal(first.previous, null);
  assert.equal(first.count, 26);
  const second = await (
    await f.request("/api/v1/items/?page=2", "GET", undefined, "anonymous")
  ).json<{ previous: string; next: null }>();
  assert(second.previous.endsWith("page=1"));
  assert.equal(second.next, null);
  assert.equal((await f.request("/api/v1/types/missing/")).status, 404);
  f.sqlite.exec("DELETE FROM hub_uploadsettings");
  assert.equal((await f.request("/api/v1/types/")).status, 200);
  assert.equal(item.status, "draft");
});
