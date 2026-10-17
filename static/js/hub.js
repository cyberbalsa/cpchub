"use strict";
function confirmExternalLink(event) {
  if (event.defaultPrevented || event.button > 1) return;
  const dialog = document.getElementById("external-warning");
  if (!dialog || typeof dialog.showModal !== "function") return;
  if (event.target.closest("[data-close-external-warning]")) {
    dialog.close();
    return;
  }
  const link = event.target.closest("a[href]");
  if (!link) return;
  if (link.hasAttribute("data-confirm-external")) {
    if (dialog.open) dialog.close();
    return;
  }
  let destination;
  try {
    const url = new URL(link.href);
    if (url.origin === location.origin && url.pathname === dialog.dataset.warningPath) {
      destination = new URL(url.searchParams.get("url"));
    } else if (url.origin !== location.origin) {
      destination = url;
    } else {
      return;
    }
    if (!["https:", "http:"].includes(destination.protocol) || destination.username || destination.password) return;
  } catch {
    return;
  }
  event.preventDefault();
  const proceed = dialog.querySelector("[data-confirm-external]");
  proceed.href = destination.href;
  proceed.target = link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1 ? "_blank" : "_self";
  dialog.querySelector("[data-external-destination]").textContent = destination.href;
  dialog.showModal();
}
document.addEventListener("click", confirmExternalLink);
document.addEventListener("auxclick", confirmExternalLink);
document.addEventListener("htmx:configRequest", (event) => {
  if (event.detail.elt.id !== "catalog-filter") return;
  for (const [name, value] of Object.entries(event.detail.parameters)) {
    if (value === "") delete event.detail.parameters[name];
  }
});
document.addEventListener("click", (event) => {
  const dialog = document.getElementById("download-warning");
  if (!dialog || typeof dialog.showModal !== "function") return;
  if (event.target.closest("[data-close-download-warning]")) {
    dialog.close();
    return;
  }
  const link = event.target.closest("a[data-download-name]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const form = dialog.querySelector("[data-download-warning-form]");
  form.action = link.href;
  form.reset();
  form.querySelector("[data-download-warning-error]").hidden = true;
  dialog.querySelector("[data-warning-file]").textContent = link.dataset.downloadName;
  dialog.showModal();
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("dialog [data-download-warning-form]")) return;
  event.preventDefault();
  const dialog = form.closest("dialog");
  const button = form.querySelector('[type="submit"]');
  const error = form.querySelector("[data-download-warning-error]");
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(form.action, {
      method: "POST", body: new FormData(form), credentials: "same-origin",
      headers: {Accept: "application/json"},
    });
    if (!response.ok) throw new Error("Download confirmation failed");
    const result = await response.json();
    dialog.close();
    if (result.remembered) dialog.remove();
    window.location.assign(result.download_url);
  } catch {
    error.textContent = "The download could not start. Please try again.";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Select & copy the key";
  }
});
document.addEventListener("htmx:responseError", () => {
  const results = document.getElementById("results");
  if (results) {
    const message = document.createElement("p");
    message.className = "notice";
    message.textContent = "The request could not be completed. Refresh the page to try again.";
    results.prepend(message);
  }
});
