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
  for (let n = 0; n < 51; n++)
    f.insert("hub_item", {
      id: uuid(),
      title: "Page " + n,
      author_id: 2,
      content_type_id: 1,
      status: "published",
    });
  const first = await (
    await f.request("/api/v1/items/", "GET", undefined, "anonymous")
  ).json<{
    next: string;
    previous: null;
    count: number;
    results: { id: string }[];
  }>();
  assert(first.next.endsWith("page=2"));
  assert.equal(first.previous, null);
  assert.equal(first.count, 52);
  assert.equal(first.results.length, 50);
  const second = await (
    await f.request("/api/v1/items/?page=2", "GET", undefined, "anonymous")
  ).json<{ previous: string; next: null; results: { id: string }[] }>();
  assert(second.previous.endsWith("page=1"));
  assert.equal(second.next, null);
  assert.equal(second.results.length, 2);
  assert.equal(
    new Set([...first.results, ...second.results].map((item) => item.id)).size,
    52,
  );
  for (const path of [
    "/catalog/results/?type=blueprints",
    "/?type=blueprints&render=full",
    "/creators/2/",
  ]) {
    const firstPage = await (
      await f.request(path, "GET", undefined, "anonymous")
    ).text();
    assert.equal(
      (firstPage.match(/class="creation-card"/g) || []).length,
      50,
      path,
    );
    assert(firstPage.includes("Page 1 of 2"), path);
    const secondPage = await (
      await f.request(
        path + (path.includes("?") ? "&" : "?") + "page=2",
        "GET",
        undefined,
        "anonymous",
      )
    ).text();
    assert.equal(
      (secondPage.match(/class="creation-card"/g) || []).length,
      2,
      path,
    );
    assert(secondPage.includes("Page 2 of 2"), path);
  }
  assert.equal((await f.request("/api/v1/types/missing/")).status, 404);
  f.sqlite.exec("DELETE FROM hub_uploadsettings");
  assert.equal((await f.request("/api/v1/types/")).status, 200);
  assert.equal(item.status, "draft");
});

void test("collection bounds and popularity sorts match current saves and preserve visibility", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const items = [0, 1, 2].map((saves) => {
    const item = f.insert("hub_item", {
      id: uuid(),
      author_id: 1,
      content_type_id: 1,
      status: "published",
      title: "Creation " + saves,
      tags: "parking garages",
      downloads: 30 - saves * 10,
      created_at: `2026-01-0${saves + 1}T00:00:00Z`,
      updated_at: `2026-02-0${saves + 1}T00:00:00Z`,
    });
    f.sqlite
      .prepare(
        "INSERT INTO hub_item_tag_index(item_id,tag_id) SELECT ?,id FROM hub_tag WHERE name='parking garages'",
      )
      .run(item.id);
    for (let user = 1; user <= saves; user++)
      f.insert("hub_bookmark", { item_id: item.id, user_id: user });
    return item;
  });
  f.insert("hub_release", {
    id: uuid(),
    item_id: items[1]!.id,
    file_stats: '{"width":10}',
  });
  const privateItem = f.insert("hub_item", {
    id: uuid(),
    author_id: 2,
    content_type_id: 1,
    status: "draft",
    title: "Private",
    downloads: 1000,
  });
  f.insert("hub_bookmark", { item_id: privateItem.id, user_id: 2 });
  for (const [query, expected] of [
    ["", [0, 1, 2]],
    ["sort=popular", [0, 1, 2]],
    ["sort=toString", [0, 1, 2]],
    ["sort=saved", [2, 1, 0]],
    ["sort=updated", [2, 1, 0]],
    ["sort=newest", [2, 1, 0]],
    ["max_collection_count=0", [0]],
    ["min_collection_count=1", [1, 2]],
    ["min_collection_count=1&max_collection_count=1", [1]],
    ["min_collection_count=2&max_collection_count=1", []],
    ["min_collection_count=&max_collection_count=", [0, 1, 2]],
    [
      "min_collection_count=1&min_width=10&type=blueprints&tag=parking+garages",
      [1],
    ],
  ] as const) {
    const result = await listItems(f.env, new URLSearchParams(query), null);
    assert.equal(result.count, expected.length, query);
    assert.deepEqual(
      result.items.map((item) => item.id),
      expected.map((n) => items[n]!.id),
      query,
    );
  }
  for (const bound of ["min", "max"])
    for (const value of ["-1", "1.5", "bad", "Infinity", "9007199254740992"])
      assert.equal(
        (await f.request(`/api/v1/items/?${bound}_collection_count=${value}`))
          .status,
        400,
      );
  const u = await userById(f.env, 2);
  const own = await listItems(
    f.env,
    new URLSearchParams("view=mine&min_collection_count=1"),
    u,
  );
  assert.deepEqual(
    own.items.map((item) => item.id),
    [privateItem.id],
  );
  f.sqlite
    .prepare("DELETE FROM hub_bookmark WHERE item_id=? AND user_id=2")
    .run(items[2]!.id);
  assert.equal(
    (
      await listItems(
        f.env,
        new URLSearchParams("min_collection_count=2"),
        null,
      )
    ).count,
    0,
  );
});
