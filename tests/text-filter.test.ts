import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument, DomUtils } from "htmlparser2";
import { censorText, censorMarkdown, censorHTML } from "../src/text-filter";
import { normalizeText } from "../src/text-input";
import { environment } from "../src/render";
import { fixture } from "./helpers/app";
import { publicId, uuid } from "../src/env";
import type { SerializedItem } from "../src/catalog";

function parseHTML(html: string) {
  const root = parseDocument(html);
  const nodes = DomUtils.findAll(() => true, root);
  return {
    text: DomUtils.textContent(root),
    nodes,
    first: (tag: string) => nodes.find((node) => node.name === tag)!,
    all: (tag: string) => nodes.filter((node) => node.name === tag),
    field: (name: string) =>
      nodes.find(
        (node) =>
          ["input", "textarea", "select"].includes(node.name) &&
          node.attribs.name === name,
      )!,
  };
}

void test("Steam-style hearts replace profanity and common evasions before and after normalization", () => {
  for (const value of [
    "fuck",
    "FUCK",
    "f u c k",
    "f.u.c.k",
    "f-u-c-k",
    "fuuuuck",
    "f*ck",
    "f#ck",
    "f@ck",
    "phuck",
    "𝓯𝓾𝓬𝓴",
    "ｆｕｃｋ",
    "f\u200buck",
    "fυck",
    "sh1t",
    "s.h.i.t",
    "shiiiiit",
    "a55hole",
    "b!tch",
    "bаstаrd",
    "n1gg3r",
    "fagg0t",
    "fuckYou123",
    "xxfuckxx",
    "f\u202euck",
    "f\ud800uck",
    "ScunthorpeParkingfuck",
    "ScunthorpeParking fuck",
    "fuckScunthorpeParking",
    "ScunthorpeParking n1gg3r",
  ]) {
    for (const input of [value, normalizeText(value)]) {
      const result = censorText(input);
      assert(result.includes("♥"), input);
      assert.equal(censorText(result), result, "idempotent: " + input);
      assert.equal(
        normalizeText(result),
        result,
        "hearts survive normalization",
      );
    }
  }
  assert.equal(censorText("A fuck B shit C"), "A ♥♥♥♥ B ♥♥♥♥ C");
  assert.equal(censorText("f u c k"), "♥♥♥♥♥♥♥");
  assert.equal(censorText("𝓯𝓾𝓬𝓴"), "♥♥♥♥");
  assert.equal(censorText("♥♥♥♥"), "♥♥♥♥");
  assert.equal(censorText(""), "");
  const maximum = "A parking garage with pedestrian entrances. ".repeat(465);
  assert.equal(censorText(maximum), maximum);
  assert.equal(censorText(maximum + " fuck"), maximum + " ♥♥♥♥");
});

void test("the English dictionary and narrow allowlist preserve innocent names and ordinary catalog text", () => {
  for (const value of [
    "Randi",
    "Randi Larsen",
    "Lund",
    "Lund University",
    "Sala",
    "Sala Station",
    "Kutta",
    "Runge Kutta",
    "Kamina",
    "Maja",
    "Blackpool",
    "Blackburn",
    "Dyke Road",
    "Scunthorpe",
    "Scunthorpe car park",
    "ScunthorpeParking",
    "Fukushima",
    "Fukushima station",
    "FukushimaTransit",
    "Penistone",
    "Cockermouth",
    "Hancock",
    "John Cockburn",
    "Dickinson",
    "shiitake garden",
    "classic sports cars",
    "passenger entrance",
    "assessment",
    "assistant entrance",
    "basement",
    "cumulative parking deck",
    "analysis of parking",
    "analogue road",
    "Peacock Plaza",
    "cockpit view",
    "Sussex",
    "Essex",
    "Middlesex",
    "Cambridge campus",
    "Saturday",
    "grapevines",
    "Gay Street",
    "Gay and Lesbian Center",
    "Transgender Pride Park",
    "Queer history museum",
    "clbuttic",
    "2026.10.18",
    "C++ parking mod",
    "https://example.com/path?asset=1",
  ])
    assert.equal(censorText(value), value);
});

void test("Markdown masks visible text and decoded entities without changing link targets or enabling HTML", () => {
  const source =
    "**fuck** [fuck](https://example.com/fuck?q=1&b=2)\n\nf&#117;ck\n\nhttps://example.com/fuck\n\n<img src=x onerror=alert(1)><script>alert(1)</script>";
  const masked = censorMarkdown(source);
  assert(
    masked.startsWith("**♥♥♥♥** [♥♥♥♥](https://example.com/fuck?q=1&b=2)"),
  );
  assert.equal(censorMarkdown(""), "");
  assert.equal(censorMarkdown(masked), masked);
  const markdown = environment.getFilter("basic_markdown") as (
    value: string,
  ) => unknown;
  const doc = parseHTML(String(markdown(masked)));
  assert.equal(DomUtils.textContent(doc.first("strong")), "♥♥♥♥");
  assert(!doc.text.includes("fuck"));
  assert(
    !doc.nodes.some(
      (node) =>
        ["script", "img"].includes(node.name) || "onerror" in node.attribs,
    ),
  );
  assert.equal(
    doc.first("a").attribs.href,
    "/out/?url=" + encodeURIComponent("https://example.com/fuck?q=1&b=2"),
  );
  assert.equal(
    DomUtils.textContent(doc.all("a")[1]!),
    "https://example.com/♥♥♥♥",
  );
  assert.equal(
    String(markdown("A &amp; B <em>safe</em>")),
    "<p>A &amp; B <em>safe</em></p>\n",
  );
  for (const value of [
    "f**u**ck",
    "f<em>u</em>ck",
    "f&#x75;c&#107;",
    "[f](https://example.com)uck",
    "f`u`ck",
  ]) {
    const html = String(markdown(censorMarkdown(value)));
    assert.equal(parseHTML(html).text.trim(), "♥♥♥♥", value);
  }
  assert.equal(censorHTML("f<!-- safe -->uck"), "♥<!-- safe -->♥♥♥");
  assert.equal(
    censorHTML("<p>f</p><p>uck</p><br><hr><p></p>"),
    "<p>f</p><p>uck</p><br><hr><p></p>",
  );
});

void test("public HTML, metadata and APIs mask new and existing content; editing and moderation retain escaped originals", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.request("/api/v1/items/", "POST", {
    title: "𝓯𝓾𝓬𝓴 Park",
    summary: "fυck summary",
    description: "**f.u.c.k** <script>bad()</script>",
    tags: "fuck",
    content_type: "blueprints",
  });
  assert.equal(response.status, 201);
  const created = await response.json<SerializedItem>();
  assert.equal(created.title, "♥♥♥♥ Park");
  assert.equal(created.summary, "♥♥♥♥ summary");
  assert.equal(created.tags, "♥♥♥♥");
  const id = created.id.replaceAll("-", "");
  const release = f.insert("hub_release", {
    id: uuid(),
    item_id: id,
    version: "fuck",
    game_version: "sh1t",
    changelog: "**b!tch** [link](https://example.com/fuck)",
    original_filename: "fuck.cpbp",
    file: "unchanged.cpbp",
    file_stats: "{}",
  });
  f.insert("hub_screenshot", {
    id: uuid(),
    item_id: id,
    image: "unchanged.webp",
    caption: "𝓯𝓾𝓬𝓴 caption",
  });
  f.sqlite.exec(
    "UPDATE hub_item SET status='published'; UPDATE hub_tagsettings SET minimum_items=1; UPDATE auth_user SET username='fuck Person' WHERE id=1",
  );
  const path = "/items/" + created.id + "/";
  for (const route of [
    path,
    path + "?render=full",
    path + "content/",
    "/?render=full",
    "/catalog/results/",
    "/creators/1/",
    path + "releases/" + publicId(release.id) + "/download/",
  ]) {
    const page = await f.request(route, "GET", undefined, "anonymous");
    assert.equal(page.status, 200, route);
    const doc = parseHTML(await page.text());
    assert(!doc.text.includes("fuck"), route);
    assert(doc.text.includes("♥♥♥♥"), route);
    assert(!doc.all("script").some((node) => !node.attribs.src));
    for (const meta of doc
      .all("meta")
      .filter((node) => "content" in node.attribs))
      assert(!meta.attribs.content!.includes("fuck"), route);
  }
  const get = await f.request("/api/v1" + path, "GET", undefined, "anonymous");
  assert.equal(get.status, 200);
  const item = await get.json<SerializedItem>();
  assert.equal(item.author, "♥♥♥♥ Person");
  assert.equal(item.releases[0]!.version, "♥♥♥♥");
  assert.equal(item.releases[0]!.game_version, "♥♥♥♥");
  assert.equal(item.releases[0]!.original_filename, "♥♥♥♥.cpbp");
  assert(item.releases[0]!.changelog.includes("https://example.com/fuck"));
  assert.equal(item.screenshots[0]!.caption, "♥♥♥♥ caption");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  f.objects.set("unchanged.cpbp", bytes);
  const download = await f.request(
    new URL(item.releases[0]!.download_url).pathname,
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("Content-Disposition"),
    "attachment; filename*=UTF-8''" + encodeURIComponent("♥♥♥♥.cpbp"),
  );
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert(
    item.releases[0]!.download_url.endsWith(
      publicId(release.id) + "/download/",
    ),
  );
  const index = await (
    await f.request("/api/v1/items/", "GET", undefined, "anonymous")
  ).json<{ results: SerializedItem[] }>();
  assert.equal(index.results[0]!.title, "♥♥♥♥ Park");
  const editor = parseHTML(await (await f.request(path + "edit/")).text());
  assert.equal(editor.field("title").attribs.value, "fuck Park");
  assert.equal(
    DomUtils.textContent(editor.field("description")),
    "**f.u.c.k** <script>bad()</script>",
  );
  f.sqlite.exec("UPDATE auth_user SET is_superuser=1 WHERE id=1");
  const moderation = await f.request("/moderation" + path);
  assert.equal(moderation.status, 200);
  const doc = parseHTML(await moderation.text());
  assert(doc.text.includes("Original text before public filtering"));
  assert(doc.text.includes("fuck Park"));
  assert(doc.text.includes("𝓯𝓾𝓬𝓴 caption"));
  assert(!doc.all("script").some((node) => !node.attribs.src));
  assert.equal(
    f.sqlite.prepare("SELECT title FROM hub_item WHERE id=?").get(id)!.title,
    "fuck Park",
  );
  f.sqlite
    .prepare(
      "UPDATE hub_item SET is_hidden=1,hidden_reason='fuck reason' WHERE id=?",
    )
    .run(id);
  const hidden = await f.request(
    "/api/v1" + path,
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(hidden.status, 403);
  assert((await hidden.text()).includes("♥♥♥♥ reason"));
});

void test("masked tags remain usable as filters without exposing private tags or creations", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.request("/api/v1/items/", "POST", {
    title: "Parking",
    summary: "Summary",
    description: "Description",
    tags: "fuck, shit",
    content_type: "blueprints",
  });
  assert.equal(response.status, 201);
  const { id } = await response.json<{ id: string }>();
  const query = encodeURIComponent("♥♥♥♥");
  const count = async (
    path: string,
    auth: "session" | "anonymous" = "anonymous",
  ) =>
    (
      await (
        await f.request(path, "GET", undefined, auth)
      ).json<{ count: number }>()
    ).count;
  assert.equal(await count("/api/v1/items/?tag=" + query), 0);
  assert.equal(
    await count("/api/v1/items/?mine=true&tag=" + query, "session"),
    1,
  );
  assert.equal(await count("/api/v1/items/?mine=true&tag=" + query), 0);
  assert.equal(
    await count("/api/v1/items/?mine=true&tag=" + query + "x", "session"),
    0,
  );
  f.sqlite
    .prepare("UPDATE hub_item SET status='published' WHERE id=?")
    .run(id.replaceAll("-", ""));
  f.sqlite.exec("UPDATE hub_tagsettings SET minimum_items=1");
  assert.equal(await count("/api/v1/items/?tag=" + query), 1);
  const tags = await (
    await f.request("/api/v1/tags/", "GET", undefined, "anonymous")
  ).json<{ results: { name: string }[] }>();
  assert.equal(tags.results.filter((tag) => tag.name === "♥♥♥♥").length, 2);
  assert(!tags.results.some((tag) => /fuck|shit/.test(tag.name)));
  const suggestions = await (
    await f.request("/api/v1/tags/suggest/?q=fuck")
  ).json<{ name: string }[]>();
  assert.deepEqual(suggestions, [{ name: "♥♥♥♥" }]);
  f.insert("hub_usermoderation", {
    user_id: 1,
    shadow_banned_at: "2026-10-18",
  });
  assert.equal(await count("/api/v1/items/?tag=" + query), 0);
  assert.equal(
    await count("/api/v1/items/?mine=true&tag=" + query, "session"),
    1,
  );
});

void test("changing a chosen name keeps the identifier and edit field intact while masking the public profile", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.request("/account/profile/", "POST", {
    action: "rename",
    username: "𝓯𝓾𝓬𝓴 Person",
  });
  assert.equal(response.status, 303);
  assert.equal(
    f.sqlite.prepare("SELECT username FROM auth_user WHERE id=1").get()!
      .username,
    "fuck Person",
  );
  const page = await f.request("/creators/1/", "GET", undefined, "anonymous");
  const html = await page.text();
  assert(html.includes("♥♥♥♥ Person"));
  assert(!html.includes("fuck Person"));
  const profile = parseHTML(
    await (await f.request("/account/profile/")).text(),
  );
  assert.equal(profile.field("username").attribs.value, "fuck Person");
  assert.equal(
    DomUtils.textContent(
      profile.nodes.find((node) => node.attribs.class === "account-name")!,
    ),
    "♥♥♥♥ Person",
  );
  assert.equal(
    (await (await f.request("/api/v1/me/")).json<{ username: string }>())
      .username,
    "fuck Person",
  );
});
