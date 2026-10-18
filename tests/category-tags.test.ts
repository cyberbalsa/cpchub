import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseDocument, DomUtils } from "htmlparser2";
import { fixture } from "./helpers/app";
import { userById } from "../src/auth";
import { categoryTagGroups, publicTags, saveItem } from "../src/catalog";
import { now, uuid } from "../src/env";

void test("category migration reuses existing tags and invalidates cached tag lists", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync("migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      if (file === "0014_category_tags.sql") {
        db.exec(
          "INSERT INTO hub_tag(id,name) VALUES (100,'parking'),(101,'custom')",
        );
      }
      db.exec(readFileSync("migrations/" + file, "utf8"));
    }
    assert.equal(
      db.prepare("SELECT id FROM hub_tag WHERE name='parking'").get()!.id,
      100,
    );
    assert.equal(
      db.prepare("SELECT category_group FROM hub_tag WHERE id=100").get()!
        .category_group,
      "blueprints",
    );
    assert.equal(
      db.prepare("SELECT category_group FROM hub_tag WHERE id=101").get()!
        .category_group,
      "",
    );
    const revision = () =>
      Number(
        db
          .prepare("SELECT revision FROM worker_cache_revision WHERE id=1")
          .get()!.revision,
      );
    const before = revision();
    db.exec(
      "INSERT INTO hub_tag(name) VALUES ('new custom'); UPDATE hub_tag SET category_group='themes' WHERE name='new custom'; DELETE FROM hub_tag WHERE name='new custom'",
    );
    assert.equal(revision(), before + 3);
  } finally {
    db.close();
  }
});

void test("unused categories are always public, suggested, and searchable below the community threshold", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.sqlite.exec("UPDATE hub_tagsettings SET minimum_items=11");
  const groups = await categoryTagGroups(f.env);
  assert.deepEqual(
    groups.map((group) => [group.key, group.tags.length]),
    [
      ["blueprints", 22],
      ["scenarios", 16],
      ["themes", 10],
    ],
  );
  const all = await publicTags(f.env);
  assert.equal(all.length, 48);
  assert(all.every((tag) => tag.item_count === 0));
  assert.deepEqual(
    (await publicTags(f.env, "  FLORIDA  ")).map((tag) => ({ ...tag })),
    [{ name: "florida", item_count: 0 }],
  );
  const suggestions = await (
    await f.request("/api/v1/tags/suggest/")
  ).json<{ name: string }[]>();
  assert.equal(suggestions.length, 48);
  assert.deepEqual(
    new Set(suggestions.map((tag) => tag.name)),
    new Set(all.map((tag) => tag.name)),
  );
  assert.equal(
    (await f.request("/api/v1/tags/suggest/", "GET", undefined, "anonymous"))
      .status,
    401,
  );

  const author = await userById(f.env, 1);
  assert(author);
  const item = await saveItem(f.env, author, {
    title: "Example",
    summary: "Example",
    description: "Example",
    content_type: "blueprints",
    tags: "parking garages, unlisted",
  });
  f.sqlite
    .prepare("UPDATE hub_item SET status='published' WHERE id=?")
    .run(item.id);
  const get = async (path: string) =>
    (await f.request(path, "GET", undefined, "anonymous")).json<{
      count: number;
      results: { tags: string }[];
    }>();
  for (const query of ["tag=parking+garages", "q=parking+garages"]) {
    const result = await get("/api/v1/items/?" + query);
    assert.equal(result.count, 1);
    assert.equal(result.results[0]!.tags, "parking garages");
  }
  assert.equal((await get("/api/v1/items/?tag=unlisted")).count, 0);
  assert.equal((await get("/api/v1/items/?q=unlisted")).count, 0);
  assert.deepEqual(
    (await publicTags(f.env, "parking garages")).map((tag) => ({ ...tag })),
    [{ name: "parking garages", item_count: 1 }],
  );
  f.sqlite.exec("DELETE FROM hub_tagsettings");
  assert.equal((await publicTags(f.env, "parking garages")).length, 1);
  assert.deepEqual(await publicTags(f.env, "unlisted"), []);
});

void test("category counts exclude nonpublic creations and suggestions never expose another author's private tags", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.sqlite.exec("UPDATE hub_tagsettings SET minimum_items=2");
  const author = await userById(f.env, 2);
  assert(author);
  const item = await saveItem(f.env, author, {
    title: "Example",
    summary: "Example",
    description: "Example",
    content_type: "scenarios",
    tags: "florida, private experiment",
  });
  const count = async (expected: number) =>
    assert.deepEqual(
      (await publicTags(f.env, "florida")).map((tag) => ({ ...tag })),
      [{ name: "florida", item_count: expected }],
    );
  const suggest = async () =>
    (await f.request("/api/v1/tags/suggest/?q=private+experiment")).json();
  await count(0);
  assert.deepEqual(await suggest(), []);
  f.sqlite
    .prepare("UPDATE hub_item SET status='published' WHERE id=?")
    .run(item.id);
  await count(1);
  assert.deepEqual(await publicTags(f.env, "private experiment"), []);
  assert.deepEqual(await suggest(), [{ name: "private experiment" }]);
  f.sqlite
    .prepare("UPDATE hub_item SET hidden_reason='Test moderation' WHERE id=?")
    .run(item.id);
  for (const column of ["is_hidden", "is_demo", "deleted_at"]) {
    f.sqlite
      .prepare(`UPDATE hub_item SET ${column}=? WHERE id=?`)
      .run(column === "deleted_at" ? now() : 1, item.id);
    await count(0);
    f.sqlite
      .prepare(`UPDATE hub_item SET ${column}=? WHERE id=?`)
      .run(column === "deleted_at" ? null : 0, item.id);
  }
  f.insert("hub_usermoderation", { user_id: 2, shadow_banned_at: now() });
  await count(0);
  assert.deepEqual(await suggest(), []);
  f.sqlite.exec("DELETE FROM hub_usermoderation");
  f.sqlite
    .prepare("UPDATE hub_item SET author_id=1,status='draft' WHERE id=?")
    .run(item.id);
  assert.deepEqual(await suggest(), [{ name: "private experiment" }]);
  await count(0);

  // Popular community tags must never push categories out of the bounded lists.
  f.sqlite
    .prepare("UPDATE hub_item SET status='published' WHERE id=?")
    .run(item.id);
  f.sqlite.exec("UPDATE hub_tagsettings SET minimum_items=1");
  for (let n = 0; n < 210; n++) {
    const tag = f.insert("hub_tag", { name: "aaa community " + n });
    f.insert("hub_item_tag_index", { item_id: item.id, tag_id: tag.id });
  }
  const list = await publicTags(f.env);
  const suggestions = await (
    await f.request("/api/v1/tags/suggest/")
  ).json<{ name: string }[]>();
  assert.equal(list.length, 200);
  assert.equal(suggestions.length, 200);
  const categories = (await categoryTagGroups(f.env)).flatMap(
    (group) => group.tags,
  );
  for (const category of categories) {
    assert(list.some((tag) => tag.name === category.name));
    assert(suggestions.some((tag) => tag.name === category.name));
  }
  assert.equal(
    list.filter((tag) => tag.name.startsWith("aaa community")).length,
    152,
  );
});

void test("category links preserve catalog filters, reset pagination and show choices on upload and edit", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const page = parseDocument(
    await (
      await f.request(
        "/?view=saved&q=example&sort=popular&page=5&type=scenarios",
      )
    ).text(),
  );
  const links = DomUtils.getElementsByTagName("a", page.children).filter(
    (link) => link.attribs.class === "category-chip",
  );
  assert.equal(links.length, 48);
  const garage = new URL(
    links.find((link) => DomUtils.textContent(link) === "parking garages")!
      .attribs.href!,
    "https://cpchub.net/",
  );
  assert.equal(garage.searchParams.get("tag"), "parking garages");
  assert.equal(garage.searchParams.get("type"), "blueprints");
  assert.equal(garage.searchParams.get("page"), "1");
  assert.equal(garage.searchParams.get("q"), "example");
  assert.equal(garage.searchParams.get("view"), "saved");
  assert.equal(garage.searchParams.get("sort"), "popular");
  const theme = new URL(
    links.find((link) => DomUtils.textContent(link) === "florida")!.attribs
      .href!,
    "https://cpchub.net/",
  );
  assert.equal(theme.searchParams.get("type"), "scenarios");
  const filtered = parseDocument(
    await (
      await f.rawRequest("/?q=updated&sort=newest&type=scenarios&tag=florida", {
        headers: { "HX-Request": "true" },
      })
    ).text(),
  );
  const updatedTheme = DomUtils.getElementsByTagName(
    "a",
    filtered.children,
  ).find((link) => DomUtils.textContent(link) === "florida")!;
  assert.equal(updatedTheme.attribs["aria-current"], "true");
  assert.equal(
    new URL(updatedTheme.attribs.href!, "https://cpchub.net/").searchParams.get(
      "q",
    ),
    "updated",
  );
  const item = f.insert("hub_item", {
    id: uuid(),
    author_id: 1,
    content_type_id: 1,
    status: "draft",
  });
  for (const path of ["/upload/", `/items/${item.id}/edit/`]) {
    const editor = parseDocument(await (await f.request(path)).text());
    assert.equal(
      DomUtils.getElementsByTagName("button", editor.children).filter(
        (button) => button.attribs["data-tag-value"],
      ).length,
      48,
    );
    assert.equal(
      DomUtils.getElementsByTagName("input", editor.children).find(
        (input) => input.attribs.id === "id_tags",
      )!.attribs.maxlength,
      "200",
    );
  }
});
