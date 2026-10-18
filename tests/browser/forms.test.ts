import test from "node:test";
import assert from "node:assert/strict";
import { dom, flush, deferred } from "./helpers";
import { initialize as upload } from "../../browser/upload";
import { initialize as tags } from "../../browser/tags";
import { initialize as apiDocs } from "../../browser/api-docs";
import type { BrowserWindow } from "../../browser/types";
const formHTML =
  '<form data-creation-upload><select name="content_type"><option value="blueprints">Blueprints</option><option value="scenarios">Scenarios</option></select><input type="file" name="file"><input name="action" value="metadata"><button type="submit">Save creation</button><ul class="errorlist"><li>Old</li></ul></form>';
void test("upload forms select native extensions, prevent duplicate sends and display escaped validation errors", async (t) => {
  const absent = dom();
  t.after(absent.close);
  upload(absent.window);
  const f = dom(formHTML);
  t.after(f.close);
  const request = deferred<Response>();
  let calls = 0;
  f.window.fetch = async () => {
    calls++;
    return request.promise;
  };
  upload(f.window);
  const form = f.query<HTMLFormElement>("form"),
    type = f.query<HTMLSelectElement>("select"),
    file = f.query<HTMLInputElement>('[name="file"]');
  assert.equal(file.accept, ".cpbp");
  type.value = "scenarios";
  type.dispatchEvent(new f.window.Event("change"));
  assert.equal(file.accept, ".cpcs");
  f.submit(form);
  f.submit(form);
  assert.equal(calls, 1);
  assert.equal(f.query<HTMLButtonElement>("button").disabled, true);
  request.resolve(
    Response.json(
      { errors: ['<script>alert("x")</script>', "Invalid file"] },
      { status: 400 },
    ),
  );
  await flush();
  assert.equal(f.query("li").textContent, '<script>alert("x")</script>');
  assert.equal(form.querySelector("script"), null);
  assert.equal(f.query<HTMLButtonElement>("button").disabled, false);
  form.setAttribute("action", "/upload/");
  f.window.fetch = async (url, init) => {
    assert.equal(url, "/upload/");
    assert.equal(init?.method, "POST");
    return Response.json({ redirect_url: "/items/id/edit/" });
  };
  f.submit(form);
  await flush();
  assert.deepEqual(f.navigated, ["/items/id/edit/"]);
});
void test("upload failures retain selected inputs and provide a retry message", async (t) => {
  const f = dom(formHTML);
  t.after(f.close);
  upload(f.window);
  for (const mode of [
    "redirect",
    "missing",
    "empty",
    "bad-json",
    "network",
  ] as const) {
    f.window.fetch = async () => {
      throw Error("not captured");
    };
    // The initializer captures fetch, just as a page captures its platform APIs.
    const page = dom(formHTML);
    t.after(page.close);
    page.window.fetch = async () => {
      if (mode === "network") throw Error("offline");
      if (mode === "bad-json") return new Response("invalid");
      const response = Response.json(mode === "empty" ? { errors: [] } : {});
      if (mode === "redirect")
        Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    upload(page.window);
    page.submit(page.query("form"));
    await flush();
    assert.match(page.query("li").textContent, /could not be confirmed/);
    assert.equal(
      page.query<HTMLInputElement>('[name="action"]').value,
      "metadata",
    );
  }
});
void test("tag suggestions handle duplicate tags, list and paginated responses, stale results and failures", async (t) => {
  const f = dom(
    '<input id="tags" data-tag-input="/api/v1/tags/" data-tag-multiple="true" value="old, ne"><input id="single" data-tag-input="/api/v1/tags/" value="">',
  );
  t.after(f.close);
  let result: unknown = {
    results: [
      { name: "old", item_count: 1 },
      { name: "new", item_count: 3 },
      { name: '<img onerror="x">' },
    ],
  };
  let response: Promise<Response> | undefined;
  let fail = false;
  f.window.fetch = async () => {
    if (fail) throw Error("offline");
    return response ?? Response.json(result);
  };
  tags(f.window);
  f.custom("htmx:afterSwap", {});
  assert.equal(f.window.document.querySelectorAll("datalist").length, 2);
  const input = f.query<HTMLInputElement>("#tags");
  input.dispatchEvent(new f.window.Event("focus"));
  await flush();
  const options = [
    ...f.window.document.querySelectorAll("#tags-suggestions option"),
  ];
  assert.equal(options.length, 2);
  assert.equal(options[0]!.getAttribute("value"), "old, new");
  assert.equal(options[0]!.getAttribute("label"), "new (3)");
  assert.equal(f.window.document.querySelector("img"), null);
  result = [{ name: "single" }];
  f.query("#single").dispatchEvent(new f.window.Event("focus"));
  await flush();
  assert.equal(
    f.query<HTMLOptionElement>("#single-suggestions option").value,
    "single",
  );
  const stale = deferred<Response>();
  response = stale.promise;
  input.dispatchEvent(new f.window.Event("focus"));
  input.value = "changed";
  stale.resolve(Response.json([{ name: "stale" }]));
  await flush();
  assert.equal(options[0]!.getAttribute("value"), "old, new");
  response = Promise.resolve(new Response(null, { status: 503 }));
  input.dispatchEvent(new f.window.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    f.window.document.querySelectorAll("#tags-suggestions option").length,
    0,
  );
  response = undefined;
  fail = true;
  input.dispatchEvent(new f.window.Event("focus"));
  await flush();
  fail = false;
  const pending = deferred<Response>();
  response = pending.promise;
  input.dispatchEvent(new f.window.Event("focus"));
  input.remove();
  pending.resolve(Response.json([]));
  await flush();
  f.custom("htmx:historyRestore", {});
  assert.equal(
    f.window.document.querySelectorAll("#single-suggestions").length,
    1,
  );
});
void test("API explorer pins schema and rewrites only the production API origin", async (t) => {
  const f = dom();
  t.after(f.close);
  let options: Parameters<BrowserWindow["SwaggerUIBundle"]>[0] | undefined;
  f.window.SwaggerUIBundle = (value) => {
    options = value;
  };
  apiDocs(f.window);
  f.window.dispatchEvent(new f.window.Event("DOMContentLoaded"));
  assert(options);
  assert.equal(options.url, "/api/schema/");
  assert.deepEqual(options.supportedSubmitMethods, ["get", "head"]);
  assert.equal(
    options.requestInterceptor({ url: "https://cpchub.net/api/v1/items/?q=x" })
      .url,
    "https://cpchub.net/api/v1/items/?q=x",
  );
  assert.equal(
    options.requestInterceptor({ url: "https://example.test/api/" }).url,
    "https://example.test/api/",
  );
});
