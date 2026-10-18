"use strict";
document.querySelectorAll("[data-passkey-panel]").forEach((panel) => {
  const status = panel.querySelector("[data-passkey-status]");
  const registration = panel.querySelector("[data-passkey-register]");
  const toggle = panel.querySelector('[data-passkey-action="show-register"]');
  const controls = panel.querySelectorAll("[data-passkey-action], [data-passkey-register] input, [data-passkey-register] button");
  let busy = false;
  function message(text) {
    status.textContent = text;
    status.hidden = !text;
  }
  function showRegistration(show) {
    if (!registration) return;
    registration.hidden = !show;
    toggle.setAttribute("aria-expanded", String(show));
    if (!busy) (show ? registration.elements.username : toggle).focus();
  }
  async function post(path, data = {}) {
    const response = await fetch("/accounts/passkeys/" + path + "/", {
      method: "POST", credentials: "same-origin",
      headers: {"Content-Type": "application/json", Accept: "application/json", "X-CSRFToken": panel.dataset.csrfToken},
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(response.status === 429 ? "Too many attempts. Wait a minute and try again." : result.errors?.[0] || "We couldn’t complete that request. Try again.");
      error.registrationRequired = result.registration_required === true;
      throw error;
    }
    return result;
  }
  if (!window.SimpleWebAuthnBrowser || !window.isSecureContext || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
    controls.forEach((control) => { control.disabled = true; });
    message("Passkeys aren’t available in this browser. Try another browser, or sign in with Steam or Discord.");
    return;
  }
  async function run(action, data) {
    if (busy) return;
    busy = true;
    controls.forEach((control) => { control.disabled = true; });
    panel.setAttribute("aria-busy", "true");
    message(action === "login" ? "Choose your passkey to sign in…" : "Follow your device’s instructions to save a passkey…");
    let offerRegistration = false;
    try {
      const kind = action === "login" ? "login" : "register";
      const optionsJSON = await post(kind + "/options", data);
      const credential = action === "login"
        ? await SimpleWebAuthnBrowser.startAuthentication({optionsJSON})
        : await SimpleWebAuthnBrowser.startRegistration({optionsJSON});
      const result = await post(kind + "/verify", {credential});
      message(action === "login" ? "Signed in. Opening CPC Hub…" : "Passkey saved. Opening CPC Hub…");
      window.location.assign(result.redirect_url);
    } catch (error) {
      if (error.name === "NotAllowedError") {
        offerRegistration = action === "login";
        message(action === "login"
          ? "Passkey sign-in didn’t finish. Try again, use Steam or Discord, or create an account below."
          : "No passkey was added. Try again to finish setting it up.");
      } else if (error.name === "InvalidStateError") {
        message("This device already has a passkey for your account. Use it to sign in, or choose another device.");
      } else {
        offerRegistration = error.registrationRequired === true;
        message(error instanceof TypeError ? "Couldn’t connect to CPC Hub. Check your connection and try again." : error.message || "We couldn’t complete that request. Try again.");
      }
    } finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
      panel.removeAttribute("aria-busy");
      if (offerRegistration) showRegistration(true);
    }
  }
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-passkey-action]");
    if (!button || busy) return;
    const action = button.dataset.passkeyAction;
    if (action === "show-register" || action === "cancel-register") {
      message("");
      showRegistration(action === "show-register");
    } else {
      void run(action, {});
    }
  });
  registration?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!registration.reportValidity()) return;
    void run("register", {username: registration.elements.username.value, create_account: true});
  });
});
