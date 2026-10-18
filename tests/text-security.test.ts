import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  normalizeTextFields,
  normalizeSearch,
} from "../src/text-input";
import {
  environment,
  esc,
  input,
  area,
  select,
  url,
  viewItem,
} from "../src/render";
import { fixture } from "./helpers/app";
import { getItem } from "../src/catalog";
import { uuid, publicId, now } from "../src/env";

const attack =
  '<img src=x onerror="alert(1)"><script id="xss">alert(1)</script>&\'"';
void test("all human text fields share transliteration while protocol fields and file bytes retain their values", () => {
  const original = {
    username: "𝓑𝓪𝓵𝓼𝓪",
    title: "Ｆａｎｃｙ",
    summary: "Café",
    description: "你好\n**bold**\ttext",
    tags: "Łódź",
    caption: "Привет",
    version: "１.０",
    game_version: "１",
    changelog: "ß",
    reason: "Résumé",
    note: "é",
    name: "ＡＰＩ",
    q: "停車",
    tag: "𝐓𝐚𝐠",
    token: "𝓑\u200b",
    code: "Ｂ",
    client_id: "Ｂ",
    redirect_uri: "https://example.com/你好",
    csrfmiddlewaretoken: "é",
    file: new File(["raw"], "é.cpbp"),
    scopes: ["read"],
    days: 7,
  };
  const result = normalizeTextFields(original);
  for (const field of [
    "username",
    "title",
    "summary",
    "description",
    "tags",
    "caption",
    "version",
    "game_version",
    "changelog",
    "reason",
    "note",
    "name",
    "q",
    "tag",
  ])
    assert.notEqual(result[field], original[field as keyof typeof original]);
  for (const field of [
    "token",
    "code",
    "client_id",
    "redirect_uri",
    "csrfmiddlewaretoken",
    "file",
    "scopes",
    "days",
  ])
    assert.equal(result[field], original[field as keyof typeof original]);
  assert.equal(result.description, "Ni Hao\n**bold**\ttext");
  assert.equal(
    normalizeText("A\u0000\u0007\u200b\u202e\ud800B\r\nC"),
    "AB\r\nC",
  );
  const source = new URLSearchParams({
    q: "𝐏𝐚𝐫𝐤",
    tag: "Ｃａｒ",
    username: "Café",
    code: "𝐀",
  });
  assert.deepEqual(Object.fromEntries(normalizeSearch(source)), {
    q: "Park",
    tag: "Car",
    username: "Cafe",
    code: "𝐀",
  });
  assert.equal(source.get("q"), "𝐏𝐚𝐫𝐤");
});
void test("HTML helpers escape text and attribute values; plain message content never bypasses escaping", () => {
  assert.equal(esc("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(esc(null), "");
  for (const html of [
    input(attack, attack, attack, attack),
    area(attack, attack, attack),
    select(attack, attack, [{ value: attack, label: attack }], attack),
    environment.render("hub/message.html", {
      heading: attack,
      content: attack,
    }),
  ]) {
    assert(!html.includes('<script id="xss">'));
    assert(!html.includes("<img src=x"));
    assert(html.includes("&lt;"));
  }
  assert.equal(url("item-detail", 'a\"/><img>'), "/items/a%22%2F%3E%3Cimg%3E/");
  assert.throws(() => url("missing"), /Unknown route/);
});
void test("Markdown strips active HTML and routes links through the outbound validation page", () => {
  const markdown = environment.getFilter("basic_markdown") as (
    value: string,
  ) => unknown;
  assert.equal(String(markdown("")), "");
  assert(String(markdown("<a>no href</a>")).includes("/out/?url="));
  const html = String(
    markdown(
      "**Good**\n\n" +
        attack +
        "\n\n[bad](javascript:alert%281%29) [web](https://example.com/?a=1&b=2)",
    ),
  );
  assert.match(html, /<strong>Good<\/strong>/);
  assert(!html.includes("<script"));
  assert(!html.includes("<img"));
  assert(!html.includes("onerror="));
  assert(!html.includes('href="javascript:'));
  assert.match(html, /href="\/out\/\?url=https%3A%2F%2Fexample.com/);
  assert.match(html, /nofollow ugc noopener/);
});
void test("catalog, editor, search, profiles and moderation escape stored and reflected HTML", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await f.request("/api/v1/items/", "POST", {
    title: "Ｆａｎｃｙ " + attack,
    summary: attack,
    description: attack,
    tags: "Café",
    content_type: "blueprints",
  });
  assert.equal(response.status, 201);
  const created = await response.json<{
    id: string;
    title: string;
    tags: string;
  }>();
  assert(created.title.startsWith("Fancy "));
  assert.equal(created.tags, "cafe");
  const id = created.id.replaceAll("-", "");
  f.insert("hub_release", {
    id: uuid(),
    item_id: id,
    version: "1",
    file: "test.cpbp",
    file_stats: "{}",
    changelog: attack,
    original_filename: attack,
  });
  f.insert("hub_screenshot", {
    id: uuid(),
    item_id: id,
    image: "test.webp",
    caption: attack,
  });
  f.sqlite
    .prepare("UPDATE auth_user SET username=?,is_superuser=1 WHERE id=1")
    .run(attack);
  for (const path of [
    "/items/" + created.id + "/",
    "/items/" + created.id + "/?render=full",
    "/items/" + created.id + "/content/",
    "/items/" + created.id + "/edit/",
    "/?q=" + encodeURIComponent(attack),
    "/creators/1/",
    "/account/profile/",
    "/moderation/users/",
    "/moderation/users/1/",
    "/moderation/items/" + created.id + "/",
  ]) {
    const page = await f.request(path);
    assert.equal(page.status, 200, path);
    const html = await page.text();
    assert(!html.includes('<script id="xss">'), path);
    assert(!html.includes("<img src=x"), path);
    assert(html.includes("&lt;"), path);
  }
  // JSON API key creation exercises the same shared body policy.
  const issued = await f.request("/api/v1/keys/", "POST", {
    name: "Ｃａｆé",
    scopes: ["read"],
  });
  assert.equal(issued.status, 201);
  assert.equal((await issued.json<{ name: string }>()).name, "Cafe");
  const hidden = await f.request(
    "/moderation/items/" + created.id + "/",
    "POST",
    { action: "hide", reason: "Ｂａｄ " + attack },
  );
  assert.equal(hidden.status, 302);
  const blocked = await f.request(
    "/items/" + created.id + "/",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(blocked.status, 403);
  assert(!(await blocked.text()).includes('<script id="xss">'));
});
void test("template filters preserve safe formatting, nulls, sizes and UTC dates", () => {
  const f = (name: string, ...values: unknown[]) =>
    String(
      (environment.getFilter(name) as (...args: unknown[]) => unknown)(
        ...values,
      ),
    );
  for (const [value, expected] of [
    [0, "0 bytes"],
    [8, "8 bytes"],
    [1024, "1.0 KB"],
    [1048576, "1.0 MB"],
  ] as const)
    assert.equal(f("filesizeformat", value), expected);
  assert.equal(f("pluralize", 1), "");
  assert.equal(f("pluralize", 2), "s");
  assert.equal(f("pluralize", 1, "y,ies"), "y");
  assert.equal(f("pluralize", 3, "y,ies"), "ies");
  assert.equal(f("slice", "abcd", "1:3"), "bc");
  assert.equal(f("slice", [1, 2, 3], "1:"), "2,3");
  assert.equal(f("slice", null, ":"), "");
  assert.equal(f("date", ""), "");
  assert.equal(f("date", "invalid"), "");
  assert.equal(
    f("date", "2026-01-02T03:04:05Z", "Y y m n d j F M H i s !"),
    "2026 26 01 1 02 2 January Jan 03 04 05 !",
  );
  assert.equal(f("date", "2026-01-02T03:04:05Z"), "Jan 2, 2026");
  assert.equal(f("floatformat", null), "0.00");
  assert.equal(f("default", 0, "fallback"), "fallback");
  assert.equal(f("default", 1, "fallback"), "1");
  assert.equal(f("default_if_none", null, "fallback"), "fallback");
  assert.equal(f("default_if_none", 0, "fallback"), "0");
  assert.equal(f("yesno", true, "yes,no"), "yes");
  assert.equal(f("yesno", false, "yes,no"), "no");
  assert.equal(f("linebreaksbr", "<tag>\nline"), "&lt;tag&gt;<br>line");
  assert.equal(
    f("linebreaks", "<tag>\nline\n\nend"),
    "<p>&lt;tag&gt;<br>line</p><p>end</p>",
  );
  assert.equal(
    f("outbound_url", "https://example.com/?q=<"),
    "/out/?url=https%3A%2F%2Fexample.com%2F%3Fq%3D%3C",
  );
});
void test("view data includes parsed statistics and the exact restoration deadline", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = uuid();
  f.insert("hub_item", {
    id,
    author_id: 1,
    content_type_id: 1,
    status: "draft",
    deleted_at: now(),
  });
  f.insert("hub_release", {
    id: uuid(),
    item_id: id,
    file: "a.cpbp",
    file_stats: '{"width":1,"objects":null}',
  });
  f.sqlite.exec("UPDATE auth_user SET is_superuser=1 WHERE id=1");
  const { userById } = await import("../src/auth");
  const u = await userById(f.env, 1);
  const item = await getItem(f.env, id, u);
  const view = await viewItem(f.env, item, u);
  assert(view.can_restore);
  assert.equal(view.pk, publicId(id));
  assert(view.delete_after);
  assert(
    view.releases[0]!.stat_rows.some((row) => row.value === "Unavailable"),
  );
});
