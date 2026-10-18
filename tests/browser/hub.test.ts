import test from "node:test";
import assert from "node:assert/strict";
import { dom, flush } from "./helpers";
import { initialize } from "../../browser/hub";
const external =
  '<dialog id="external-warning" data-warning-path="/out/"><a data-confirm-external href="#">Proceed</a><button data-close-external-warning>Close</button><p data-external-destination></p></dialog>';
const download =
  '<dialog id="download-warning"><span data-warning-file></span><button data-close-download-warning>Close</button><form data-download-warning-form><input name="csrfmiddlewaretoken" value="csrf"><input type="file" name="ignored"><button type="submit">Download</button><p data-download-warning-error hidden></p></form></dialog>';
void test("external links require confirmation with safe URLs and preserve modifier-key behavior", async (t) => {
  const f = dom(
    external +
      '<a id="link" href="https://example.test/?q=%3Cscript%3E">Link</a><div id="other"></div>',
  );
  t.after(f.close);
  initialize(f.window);
  const link = f.query<HTMLAnchorElement>("#link"),
    dialog = f.query<HTMLDialogElement>("dialog"),
    proceed = f.query<HTMLAnchorElement>("[data-confirm-external]");
  f.click(link);
  assert(dialog.open);
  assert.equal(proceed.target, "_self");
  assert.equal(f.query("[data-external-destination]").textContent, link.href);
  assert.equal(f.window.document.querySelector("script"), null);
  f.click(proceed);
  assert.equal(dialog.open, false);
  f.click(proceed);
  assert.equal(dialog.open, false);
  for (const values of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { button: 1 },
  ]) {
    f.click(link, values);
    assert.equal(proceed.target, "_blank");
    dialog.close();
  }
  link.target = "_blank";
  f.click(link);
  assert.equal(proceed.target, "_blank");
  f.click(f.query("[data-close-external-warning]"));
  assert.equal(dialog.open, false);
  link.href = "/out/?url=" + encodeURIComponent("https://other.test/");
  f.click(link);
  assert.equal(proceed.href, "https://other.test/");
  dialog.close();
  for (const url of [
    "/internal/",
    "/out/",
    "/out/?url=bad",
    "javascript:alert(1)",
    "https://user:pass@example.test/",
  ]) {
    link.href = url;
    f.click(link);
    assert.equal(dialog.open, false, url);
  }
  f.click(f.query("#other"));
  f.click(f.window.document);
  f.click(link, { button: 2 });
  f.click(link, {}, true);
  await flush();
});
void test("missing dialogs and browsers without dialog support retain normal link behavior", (t) => {
  const f = dom('<a href="https://example.test/">Link</a>');
  t.after(f.close);
  initialize(f.window);
  assert.equal(f.click(f.query("a")).defaultPrevented, false);
  const unsupported = dom(
    external +
      download +
      '<a data-download-name="file" href="/download/">Link</a>',
  );
  t.after(unsupported.close);
  Object.defineProperty(
    unsupported.window.HTMLDialogElement.prototype,
    "showModal",
    { value: undefined },
  );
  initialize(unsupported.window);
  assert.equal(
    unsupported.click(unsupported.query("a[data-download-name]"))
      .defaultPrevented,
    false,
  );
});
void test("download warnings reset forms, confirm before navigation, handle errors and remember consent", async (t) => {
  const f = dom(
    download +
      '<a id="download" data-download-name="&lt;img onerror=x&gt;" href="/download/">Get file</a><form id="other"></form>',
  );
  t.after(f.close);
  let status = 200,
    remembered = false;
  f.window.fetch = async (_url, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(String(init?.body), "csrfmiddlewaretoken=csrf");
    return Response.json(
      { remembered, download_url: "/approved/" },
      { status },
    );
  };
  initialize(f.window);
  const link = f.query("#download"),
    dialog = f.query<HTMLDialogElement>("dialog"),
    form = f.query<HTMLFormElement>("dialog form");
  for (const values of [
    { button: 1 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    f.click(link, values);
    assert.equal(dialog.open, false);
  }
  f.click(link, {}, true);
  assert.equal(dialog.open, false);
  f.click(link);
  assert(dialog.open);
  assert.equal(f.query("[data-warning-file]").textContent, "<img onerror=x>");
  assert.equal(dialog.querySelector("img"), null);
  f.click(f.query("[data-close-download-warning]"));
  assert.equal(dialog.open, false);
  f.submit(f.query("#other"));
  f.submit(f.window.document);
  f.click(link);
  f.submit(form);
  await flush();
  assert.deepEqual(f.navigated, ["/approved/"]);
  assert.equal(dialog.open, false);
  status = 503;
  f.click(link);
  f.submit(form);
  await flush();
  assert.equal(
    f.query<HTMLElement>("[data-download-warning-error]").hidden,
    false,
  );
  assert(dialog.open);
  status = 200;
  remembered = true;
  f.submit(form);
  await flush();
  assert.equal(f.window.document.querySelector("dialog"), null);
});
void test("copy controls, HTMX parameter cleanup and error feedback use text-only DOM updates", async (t) => {
  const f = dom(
    '<button data-copy="key">Copy</button><code id="key">&lt;script&gt;</code><div id="results"></div><form id="catalog-filter"></form>',
  );
  t.after(f.close);
  let copied = "",
    fail = false;
  Object.defineProperty(f.window.navigator, "clipboard", {
    value: {
      async writeText(value: string) {
        if (fail) throw Error("denied");
        copied = value;
      },
    },
  });
  initialize(f.window);
  f.click(f.query("button"));
  await flush();
  assert.equal(copied, "<script>");
  assert.equal(f.query("button").textContent, "Copied!");
  fail = true;
  f.click(f.query("button"));
  await flush();
  assert.match(f.query("button").textContent, /Select & copy/);
  const parameters = { q: "", page: "2", render: "full" };
  f.custom("htmx:configRequest", { elt: f.query("form"), parameters });
  assert.deepEqual(parameters, { page: "2" });
  const other = { q: "" };
  f.custom("htmx:configRequest", { elt: f.query("code"), parameters: other });
  assert.deepEqual(other, { q: "" });
  f.custom("htmx:responseError", {});
  assert.match(f.query("#results p").textContent, /Refresh the page/);
  f.query("#results").remove();
  f.custom("htmx:responseError", {});
  const content = f.window.document.createElement("div");
  content.id = "item-content";
  f.window.document.body.append(content);
  f.custom("htmx:sendError", {});
  assert.match(f.query("#item-content p").textContent, /Refresh the page/);
});
