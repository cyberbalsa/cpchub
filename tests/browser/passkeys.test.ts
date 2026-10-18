import test from "node:test";
import assert from "node:assert/strict";
import { dom, flush, deferred } from "./helpers";
import { initialize } from "../../browser/passkeys";
import type { BrowserWindow } from "../../browser/types";
const markup =
  '<section data-passkey-panel data-csrf-token="csrf"><p data-passkey-status hidden></p><button type="button" data-passkey-action="login">Login</button><button type="button" data-passkey-action="add">Add</button><button type="button" data-passkey-action="show-register">Create</button><form data-passkey-register hidden><input name="username" value="Name"><button type="submit">Register</button><button type="button" data-passkey-action="cancel-register">Cancel</button></form></section>';
const authentication = {
  id: "key",
  rawId: "key",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "data",
    authenticatorData: "data",
    signature: "signature",
  },
};
const registration = {
  id: "key",
  rawId: "key",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: { clientDataJSON: "data", attestationObject: "data" },
};
const options = {
  challenge: "challenge",
  rp: { name: "CPC Hub", id: "cpchub.net" },
  user: { id: "handle", name: "Name", displayName: "Name" },
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  authenticatorSelection: { residentKey: "required" },
  extensions: { credProps: true },
};
function supported(window: BrowserWindow) {
  window.SimpleWebAuthnBrowser = {
    browserSupportsWebAuthn: () => true,
    startAuthentication: async () => authentication,
    startRegistration: async (value) => {
      assert.deepEqual(value.optionsJSON.extensions, { credProps: true });
      return registration;
    },
  };
  window.fetch = async (url) =>
    Response.json(
      String(url).endsWith("options/")
        ? options
        : { redirect_url: "/account/profile/" },
    );
}
void test("passkey controls gracefully explain unsupported and insecure browsers", (t) => {
  for (const reason of ["missing", "insecure", "unsupported"]) {
    const f = dom(markup);
    t.after(f.close);
    supported(f.window);
    if (reason === "missing") delete f.window.SimpleWebAuthnBrowser;
    if (reason === "insecure")
      Object.defineProperty(f.window, "isSecureContext", { value: false });
    if (reason === "unsupported")
      f.window.SimpleWebAuthnBrowser!.browserSupportsWebAuthn = () => false;
    initialize(f.window);
    assert.match(
      f.query("[data-passkey-status]").textContent,
      /aren’t available/,
    );
    assert.equal(f.query<HTMLButtonElement>("button").disabled, true);
  }
});
void test("login and account registration pass verified responses and navigate after success", async (t) => {
  const f = dom(markup);
  t.after(f.close);
  supported(f.window);
  const requests: string[] = [];
  f.window.fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("X-CSRFToken"), "csrf");
    return Response.json(
      String(url).endsWith("options/")
        ? options
        : { redirect_url: "/account/profile/" },
    );
  };
  initialize(f.window);
  f.click(f.query('[data-passkey-action="show-register"]'));
  assert.equal(f.query<HTMLFormElement>("form").hidden, false);
  f.click(f.query('[data-passkey-action="cancel-register"]'));
  assert.equal(f.query<HTMLFormElement>("form").hidden, true);
  f.click(f.query('[data-passkey-action="login"]'));
  await flush();
  assert.deepEqual(f.navigated, ["/account/profile/"]);
  assert.match(f.query("[data-passkey-status]").textContent, /Signed in/);
  f.submit(f.query("form"));
  await flush();
  assert.equal(f.navigated.length, 2);
  assert.match(f.query("[data-passkey-status]").textContent, /Passkey saved/);
  f.click(f.query('[data-passkey-action="add"]'));
  await flush();
  assert.equal(f.navigated.length, 3);
  assert.equal(requests.length, 6);
  const input = f.query<HTMLInputElement>("input");
  input.required = true;
  input.value = "";
  f.submit(f.query("form"));
  await flush();
  assert.equal(requests.length, 6);
  const unknown = f.window.document.createElement("button");
  unknown.dataset.passkeyAction = "unknown";
  f.query("section").append(unknown);
  f.click(unknown);
  f.click(f.query("p"));
  const text = f.window.document.createTextNode("text");
  f.query("section").append(text);
  f.click(text);
});
void test("busy passkey requests ignore repeated clicks and submissions until the current request completes", async (t) => {
  const f = dom(markup);
  t.after(f.close);
  supported(f.window);
  const pending = deferred<Response>();
  let calls = 0;
  f.window.fetch = async () => {
    calls++;
    return pending.promise;
  };
  initialize(f.window);
  f.click(f.query('[data-passkey-action="login"]'));
  f.click(f.query('[data-passkey-action="show-register"]'));
  f.submit(f.query("form"));
  assert.equal(calls, 1);
  pending.resolve(Response.json({ errors: ["Try later"] }, { status: 503 }));
  await flush();
  assert.equal(f.query("section").hasAttribute("aria-busy"), false);
  assert.equal(f.query<HTMLButtonElement>("button").disabled, false);
});
void test("passkey errors distinguish cancellation, existing credentials, registration offers and network failures", async (t) => {
  for (const mode of [
    "login-cancel",
    "register-cancel",
    "existing",
    "network",
    "empty",
    "unknown",
    "offer",
    "rate",
    "fallback",
  ] as const) {
    const f = dom(markup);
    t.after(f.close);
    supported(f.window);
    if (["offer", "rate", "fallback"].includes(mode))
      f.window.fetch = async () =>
        Response.json(
          mode === "offer"
            ? { errors: ["Create an account"], registration_required: true }
            : {},
          { status: mode === "rate" ? 429 : 400 },
        );
    else {
      const error =
        mode === "network"
          ? new TypeError("offline")
          : new Error(mode === "empty" ? "" : "failure");
      if (mode.endsWith("cancel")) error.name = "NotAllowedError";
      if (mode === "existing") error.name = "InvalidStateError";
      const fail = async (): Promise<never> => {
        throw mode === "unknown" ? "unknown" : error;
      };
      f.window.SimpleWebAuthnBrowser!.startAuthentication = fail;
      f.window.SimpleWebAuthnBrowser!.startRegistration = fail;
    }
    initialize(f.window);
    f.click(
      f.query(
        mode === "register-cancel"
          ? '[data-passkey-action="add"]'
          : '[data-passkey-action="login"]',
      ),
    );
    await flush();
    const message = f.query("[data-passkey-status]").textContent;
    assert.match(
      message,
      mode === "login-cancel"
        ? /didn’t finish/
        : mode === "register-cancel"
          ? /No passkey was added/
          : mode === "existing"
            ? /already has a passkey/
            : mode === "network"
              ? /Couldn’t connect/
              : mode === "rate"
                ? /Too many attempts/
                : mode === "offer"
                  ? /Create an account/
                  : /couldn’t complete/,
    );
    assert.equal(
      f.query<HTMLFormElement>("form").hidden,
      mode !== "login-cancel" && mode !== "offer",
    );
    assert.equal(f.query<HTMLButtonElement>("button").disabled, false);
  }
  const profile = dom(
    '<section data-passkey-panel data-csrf-token="csrf"><p data-passkey-status></p><button type="button" data-passkey-action="show-register">Create</button></section>',
  );
  t.after(profile.close);
  supported(profile.window);
  initialize(profile.window);
  profile.click(profile.query("button"));
});
