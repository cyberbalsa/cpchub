import test from "node:test";
import assert from "node:assert/strict";
import { dom, flush, deferred } from "./helpers";
import { initialize as upload } from "../../browser/upload";
import { initialize as tags } from "../../browser/tags";
import { initialize as apiDocs } from "../../browser/api-docs";
import type { BrowserWindow } from "../../browser/types";
const formHTML =
  '<form data-creation-upload><select name="content_type"><option value="blueprints">Blueprints</option><option value="scenarios">Scenarios</option></select><input type="file" name="file"><input name="action" value="metadata"><input name="title" value="My creation"><input name="csrfmiddlewaretoken" value="old-token"><button type="submit">Save creation</button><ul class="errorlist"><li>Old</li></ul></form>';
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
void test("upload errors explain edge blocks, limits and server failures without clearing the form", async (t) => {
  const cases: [string, () => Response, RegExp][] = [
    [
      "firewall",
      () =>
        new Response('<script>throw Error("blocked")</script>', {
          status: 403,
          headers: { "cf-ray": "a52183f11cddc028-ORD" },
        }),
      /security checks blocked this upload/,
    ],
    [
      "challenge",
      () =>
        new Response("Challenge", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
      /browser security check interrupted/,
    ],
    [
      "size",
      () => new Response("Too large", { status: 413 }),
      /Choose smaller files or fewer screenshots/,
    ],
    [
      "edge rate limit",
      () =>
        Response.json(
          { error: "rate_limited", retry_after: 60 },
          { status: 429 },
        ),
      /Wait 60 seconds/,
    ],
    [
      "retry header",
      () =>
        new Response("Limited", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      /Wait 120 seconds/,
    ],
    [
      "unknown retry time",
      () => new Response("Limited", { status: 429 }),
      /Wait a few minutes/,
    ],
    [
      "invalid retry time",
      () =>
        new Response("Limited", {
          status: 429,
          headers: { "Retry-After": "invalid" },
        }),
      /Wait a few minutes/,
    ],
    [
      "zero retry time",
      () =>
        new Response("Limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      /Wait a few minutes/,
    ],
    [
      "quota",
      () =>
        Response.json(
          { errors: ["16 uploads per hour. Try again later."] },
          { status: 429 },
        ),
      /16 uploads per hour/,
    ],
    [
      "unavailable",
      () => new Response("Bad gateway", { status: 502 }),
      /upload service is having trouble/,
    ],
    [
      "server error",
      () =>
        Response.json(
          { errors: ["The request could not be completed."] },
          { status: 500 },
        ),
      /upload service is having trouble/,
    ],
    ["invalid JSON", () => new Response("invalid"), /unexpected response/],
    ["missing fields", () => Response.json({}), /unexpected response/],
    [
      "empty errors",
      () => Response.json({ errors: [] }),
      /unexpected response/,
    ],
    [
      "wrong schema",
      () => Response.json({ errors: "invalid" }),
      /unexpected response/,
    ],
    [
      "unexpected redirect",
      () => {
        const response = Response.json({ redirect_url: "/items/id/edit/" });
        Object.defineProperties(response, {
          redirected: { value: true },
          url: { value: "https://cpchub.net/other/" },
        });
        return response;
      },
      /unexpected response/,
    ],
  ];
  for (const [name, reply, message] of cases) {
    const page = dom(formHTML);
    t.after(page.close);
    const file = page.query<HTMLInputElement>('[name="file"]');
    const selected = [new page.window.File(["native"], "selected.cpbp")];
    Object.defineProperty(file, "files", { value: selected });
    page.window.fetch = async () => reply();
    upload(page.window);
    const form = page.query("form");
    page.submit(form);
    await flush();
    const notice = page.query<HTMLElement>('[role="alert"]');
    assert.match(notice.textContent!, message, name);
    assert.match(notice.textContent!, /selected files are still here/);
    assert.equal(notice.hidden, false);
    assert.equal(page.window.document.activeElement, notice);
    assert.equal(
      page.query<HTMLInputElement>('[name="title"]').value,
      "My creation",
    );
    assert.equal(file.files, selected);
    assert.equal(page.query<HTMLButtonElement>("button").disabled, false);
    assert.equal(form.hasAttribute("aria-busy"), false);
    assert.deepEqual(page.navigated, []);
    assert.equal(notice.querySelector("script"), null);
    const mine = notice.querySelector<HTMLAnchorElement>(
      'a[href="/?view=mine"]',
    )!;
    assert.equal(mine.target, "_blank");
    assert.equal(mine.rel, "noopener");
    if (name === "firewall")
      assert.match(
        notice.textContent!,
        /HTTP 403.*Request ID: a52183f11cddc028-ORD/,
      );
    if (name === "challenge")
      assert.equal(
        notice.querySelector<HTMLAnchorElement>('a[href="/"]')!.target,
        "_blank",
      );
  }
});

void test("connection failures distinguish offline browsers and keep duplicate-upload guidance", async (t) => {
  for (const online of [true, false]) {
    const f = dom(formHTML);
    t.after(f.close);
    Object.defineProperty(f.window.navigator, "onLine", { value: online });
    f.window.fetch = async () => {
      throw Error("connection lost");
    };
    upload(f.window);
    f.submit(f.query("form"));
    await flush();
    assert.match(
      f.query("li").textContent,
      online ? /connection was interrupted/ : /You're offline/,
    );
    assert.match(f.query("li").textContent, /My uploads before retrying/);
    assert.match(f.query('[role="alert"]').textContent, /Keep this tab open/);
  }
});

void test("expired sign-ins and CSRF tokens can be refreshed after signing in in another tab", async (t) => {
  for (const mode of ["unauthorized", "login redirect", "csrf"] as const) {
    const f = dom(formHTML);
    t.after(f.close);
    let calls = 0;
    f.window.fetch = async (url, init) => {
      calls++;
      if (calls === 1) {
        if (mode === "unauthorized")
          return new Response("Unauthorized", { status: 401 });
        if (mode === "csrf")
          return Response.json(
            { errors: ["Invalid CSRF token."] },
            { status: 403 },
          );
        const response = new Response("Sign in");
        Object.defineProperties(response, {
          redirected: { value: true },
          url: { value: "https://cpchub.net/accounts/login/?next=/upload/" },
        });
        return response;
      }
      if (calls === 2) {
        assert.equal(url, "/accounts/csrf/");
        assert.equal(init?.credentials, "same-origin");
        return Response.json({ csrf_token: "new-token" });
      }
      assert.equal(init?.method, "POST");
      assert.equal(
        (init.body as FormData).get("csrfmiddlewaretoken"),
        "new-token",
      );
      return Response.json({ redirect_url: "/items/id/edit/" });
    };
    upload(f.window);
    f.submit(f.query("form"));
    await flush();
    assert.match(f.query("li").textContent, /sign-in changed or expired/);
    assert.equal(
      f.query<HTMLAnchorElement>('a[href="/accounts/login/"]').target,
      "_blank",
    );
    assert.equal(calls, 1, "Never retry an upload automatically");
    f.submit(f.query("form"));
    await flush();
    assert.equal(calls, 3);
    assert.deepEqual(f.navigated, ["/items/id/edit/"]);
  }
});

void test("failed sign-in refreshes do not send files and can be retried", async (t) => {
  for (const mode of ["http", "invalid token", "html"] as const) {
    const f = dom(formHTML);
    t.after(f.close);
    let calls = 0;
    f.window.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 401 });
      if (calls === 2) {
        if (mode === "http")
          return Response.json({ csrf_token: "token" }, { status: 503 });
        if (mode === "html") return new Response("Blocked");
        return Response.json({ csrf_token: 10 });
      }
      return Response.json({ csrf_token: "fresh" });
    };
    upload(f.window);
    f.submit(f.query("form"));
    await flush();
    f.submit(f.query("form"));
    await flush();
    assert.match(f.query("li").textContent, /sign-in could not be checked/);
    assert.equal(calls, 2);
    assert.equal(
      f.query<HTMLInputElement>('[name="csrfmiddlewaretoken"]').value,
      "old-token",
    );
    f.submit(f.query("form"));
    await flush();
    assert.equal(calls, 4);
    assert.equal(
      f.query<HTMLInputElement>('[name="csrfmiddlewaretoken"]').value,
      "fresh",
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

void test("category choices toggle tags, respect the character limit, and survive history restoration", async (t) => {
  const f = dom(`
    <input id="tags" data-tag-input="/api/v1/tags/suggest/" data-tag-multiple="true" maxlength="200" value="Parking, custom, PARKING">
    <section data-tag-target="tags">
      <button type="button" data-tag-value="parking"></button>
      <button type="button" data-tag-value="gas stations"></button>
    </section>`);
  t.after(f.close);
  f.window.fetch = async () =>
    Response.json(
      Array.from({ length: 48 }, (_, i) => ({ name: "category " + i })),
    );
  tags(f.window);
  const input = f.query<HTMLInputElement>("#tags");
  const parking = f.query<HTMLButtonElement>('[data-tag-value="parking"]');
  const gas = f.query<HTMLButtonElement>('[data-tag-value="gas stations"]');
  assert.equal(parking.getAttribute("aria-pressed"), "true");
  parking.click();
  assert.equal(input.value, "custom");
  assert.equal(parking.getAttribute("aria-pressed"), "false");
  gas.click();
  assert.equal(input.value, "custom, gas stations");
  assert.equal(gas.getAttribute("aria-pressed"), "true");
  input.value = "gas stations, " + "x".repeat(185);
  input.dispatchEvent(new f.window.Event("input"));
  assert.equal(parking.disabled, true);
  assert.equal(gas.disabled, false);
  parking.click();
  assert.equal(input.value.length, 199);
  gas.click();
  assert.equal(input.value.length, 185);
  assert.equal(parking.disabled, false);

  input.value = "";
  input.dispatchEvent(new f.window.Event("input"));
  input.dispatchEvent(new f.window.Event("focus"));
  await flush();
  assert.equal(
    f.window.document.querySelectorAll("datalist option").length,
    48,
  );
  f.custom("htmx:afterSwap", {});
  f.custom("htmx:historyRestore", {});
  parking.click();
  assert.equal(input.value, "parking");
  assert.equal(parking.getAttribute("aria-pressed"), "true");
  assert.equal(f.window.document.querySelectorAll("datalist").length, 1);
  // A restore can happen before any request; canceling that binding must be safe too.
  f.custom("htmx:historyRestore", {});
  input.removeAttribute("maxlength");
  input.value = "x".repeat(200);
  input.dispatchEvent(new f.window.Event("input"));
  assert.equal(parking.disabled, false);
});
