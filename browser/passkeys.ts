import type { BrowserWindow } from "./types";
import {
  array,
  boolean,
  literal,
  looseObject,
  number,
  object,
  optional,
  string,
} from "zod/mini";
const loginOptions = looseObject({ challenge: string() });
const registerOptions = looseObject({
  rp: looseObject({ name: string() }),
  user: looseObject({
    id: string(),
    name: string(),
    displayName: string(),
  }),
  challenge: string(),
  pubKeyCredParams: array(
    object({ alg: number(), type: literal("public-key") }),
  ),
});
const problem = object({
  errors: optional(array(string())),
  registration_required: optional(boolean()),
});
const verified = object({ redirect_url: string() });
class RequestError extends Error {
  constructor(
    message: string,
    readonly registrationRequired: boolean,
  ) {
    super(message);
  }
}
export function initialize(window: BrowserWindow) {
  const { document } = window;
  document
    .querySelectorAll<HTMLElement>("[data-passkey-panel]")
    .forEach((panel) => {
      const status = panel.querySelector<HTMLElement>("[data-passkey-status]")!;
      const registration = panel.querySelector<HTMLFormElement>(
        "[data-passkey-register]",
      );
      const toggle = panel.querySelector<HTMLButtonElement>(
        '[data-passkey-action="show-register"]',
      )!;
      const controls = panel.querySelectorAll<
        HTMLInputElement | HTMLButtonElement
      >(
        "[data-passkey-action], [data-passkey-register] input, [data-passkey-register] button",
      );
      let busy = false;
      function message(text: string) {
        status.textContent = text;
        status.hidden = !text;
      }
      function showRegistration(show: boolean) {
        if (!registration) return;
        registration.hidden = !show;
        toggle.setAttribute("aria-expanded", String(show));
        (show
          ? registration.querySelector<HTMLInputElement>('[name="username"]')!
          : toggle
        ).focus();
      }
      async function post(path: string, data: Record<string, unknown>) {
        const response = await window.fetch(
          "/accounts/passkeys/" + path + "/",
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-CSRFToken": panel.dataset.csrfToken!,
            },
            body: JSON.stringify(data),
          },
        );
        const result: unknown = await response.json();
        if (!response.ok) {
          const detail = problem.parse(result);
          throw new RequestError(
            response.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : detail.errors?.[0] ||
                  "We couldn’t complete that request. Try again.",
            detail.registration_required === true,
          );
        }
        return result;
      }
      const available = window.SimpleWebAuthnBrowser;
      if (
        !available ||
        !window.isSecureContext ||
        !available.browserSupportsWebAuthn()
      ) {
        controls.forEach((control) => {
          control.disabled = true;
        });
        message(
          "Passkeys aren’t available in this browser. Try another browser, or sign in with Steam or Discord.",
        );
        return;
      }
      const webauthn = available;
      async function run(
        action: "login" | "register",
        data: Record<string, unknown>,
      ) {
        if (busy) return;
        busy = true;
        controls.forEach((control) => {
          control.disabled = true;
        });
        panel.setAttribute("aria-busy", "true");
        message(
          action === "login"
            ? "Choose your passkey to sign in…"
            : "Follow your device’s instructions to save a passkey…",
        );
        let offerRegistration = false;
        try {
          const options = await post(action + "/options", data);
          const credential =
            action === "login"
              ? await webauthn.startAuthentication({
                  optionsJSON: loginOptions.parse(options),
                })
              : await webauthn.startRegistration({
                  optionsJSON: registerOptions.parse(options),
                });
          const result = verified.parse(
            await post(action + "/verify", { credential }),
          );
          message(
            action === "login"
              ? "Signed in. Opening CPC Hub…"
              : "Passkey saved. Opening CPC Hub…",
          );
          window.location.assign(result.redirect_url);
        } catch (cause) {
          const error =
            cause instanceof Error
              ? cause
              : new Error("We couldn’t complete that request. Try again.");
          if (error.name === "NotAllowedError") {
            offerRegistration = action === "login";
            message(
              action === "login"
                ? "Passkey sign-in didn’t finish. Try again, use Steam or Discord, or create an account below."
                : "No passkey was added. Try again to finish setting it up.",
            );
          } else if (error.name === "InvalidStateError") {
            message(
              "This device already has a passkey for your account. Use it to sign in, or choose another device.",
            );
          } else {
            offerRegistration =
              error instanceof RequestError && error.registrationRequired;
            message(
              error instanceof TypeError
                ? "Couldn’t connect to CPC Hub. Check your connection and try again."
                : error.message ||
                    "We couldn’t complete that request. Try again.",
            );
          }
        } finally {
          busy = false;
          controls.forEach((control) => {
            control.disabled = false;
          });
          panel.removeAttribute("aria-busy");
          if (offerRegistration) showRegistration(true);
        }
      }
      panel.addEventListener("click", (event) => {
        if (!(event.target instanceof window.Element)) return;
        const button = event.target.closest<HTMLElement>(
          "[data-passkey-action]",
        );
        if (!button || busy) return;
        const action = button.dataset.passkeyAction;
        if (action === "show-register" || action === "cancel-register") {
          message("");
          showRegistration(action === "show-register");
        } else if (action === "login") void run("login", {});
        else if (action === "add") void run("register", {});
      });
      registration?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!registration.reportValidity()) return;
        void run("register", {
          username:
            registration.querySelector<HTMLInputElement>('[name="username"]')!
              .value,
          create_account: true,
        });
      });
    });
}
