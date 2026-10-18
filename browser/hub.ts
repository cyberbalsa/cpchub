import type { BrowserWindow } from "./types";
import { boolean, object, string } from "zod/mini";
const confirmation = object({
  remembered: boolean(),
  download_url: string(),
});
export function initialize(window: BrowserWindow) {
  const { document, location, URL, FormData, URLSearchParams } = window;
  function confirmExternalLink(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button > 1 ||
      !(event.target instanceof window.Element)
    )
      return;
    const dialog =
      document.querySelector<HTMLDialogElement>("#external-warning");
    if (!dialog || typeof dialog.showModal !== "function") return;
    if (event.target.closest("[data-close-external-warning]")) {
      dialog.close();
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    if (link.hasAttribute("data-confirm-external")) {
      if (dialog.open) dialog.close();
      return;
    }
    let destination: URL;
    try {
      const url = new URL(link.href);
      if (
        url.origin === location.origin &&
        url.pathname === dialog.dataset.warningPath
      )
        destination = new URL(url.searchParams.get("url") ?? "");
      else if (url.origin !== location.origin) destination = url;
      else return;
      if (
        !["https:", "http:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        return;
    } catch {
      return;
    }
    event.preventDefault();
    const proceed = dialog.querySelector<HTMLAnchorElement>(
      "[data-confirm-external]",
    )!;
    proceed.href = destination.href;
    proceed.target =
      link.target === "_blank" ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.button === 1
        ? "_blank"
        : "_self";
    dialog.querySelector<HTMLElement>(
      "[data-external-destination]",
    )!.textContent = destination.href;
    dialog.showModal();
  }
  document.addEventListener("click", confirmExternalLink);
  document.addEventListener("auxclick", confirmExternalLink);
  document.addEventListener("htmx:configRequest", (event) => {
    const { detail } = event as CustomEvent<{
      elt: Element;
      parameters: Record<string, unknown>;
    }>;
    if (detail.elt.id !== "catalog-filter") return;
    for (const [name, value] of Object.entries(detail.parameters))
      if (value === "") delete detail.parameters[name];
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof window.Element)) return;
    const dialog =
      document.querySelector<HTMLDialogElement>("#download-warning");
    if (!dialog || typeof dialog.showModal !== "function") return;
    if (event.target.closest("[data-close-download-warning]")) {
      dialog.close();
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>(
      "a[data-download-name]",
    );
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const form = dialog.querySelector<HTMLFormElement>(
      "[data-download-warning-form]",
    )!;
    form.action = link.href;
    form.reset();
    form.querySelector<HTMLElement>("[data-download-warning-error]")!.hidden =
      true;
    dialog.querySelector<HTMLElement>("[data-warning-file]")!.textContent =
      link.dataset.downloadName!;
    dialog.showModal();
  });
  document.addEventListener("submit", (event) => {
    void startDownload(event);
  });
  async function startDownload(event: SubmitEvent) {
    const form = event.target;
    if (
      !(form instanceof window.HTMLFormElement) ||
      !form.matches("dialog [data-download-warning-form]")
    )
      return;
    event.preventDefault();
    const dialog = form.closest("dialog")!;
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const error = form.querySelector<HTMLElement>(
      "[data-download-warning-error]",
    )!;
    button.disabled = true;
    error.hidden = true;
    try {
      const body = new URLSearchParams();
      for (const [key, value] of new FormData(form))
        if (typeof value === "string") body.append(key, value);
      const response = await window.fetch(form.action, {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Download confirmation failed");
      const result = confirmation.parse(await response.json());
      dialog.close();
      if (result.remembered) dialog.remove();
      window.location.assign(result.download_url);
    } catch {
      error.textContent = "The download could not start. Please try again.";
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }
  document.addEventListener("click", (event) => {
    void copyKey(event);
  });
  async function copyKey(event: MouseEvent) {
    if (!(event.target instanceof window.Element)) return;
    const button = event.target.closest<HTMLElement>("[data-copy]");
    if (!button) return;
    try {
      await window.navigator.clipboard.writeText(
        document.getElementById(button.dataset.copy!)!.textContent,
      );
      button.textContent = "Copied!";
    } catch {
      button.textContent = "Select & copy the key";
    }
  }
  document.addEventListener("htmx:responseError", () => {
    const results = document.getElementById("results");
    if (results) {
      const message = document.createElement("p");
      message.className = "notice";
      message.textContent =
        "The request could not be completed. Refresh the page to try again.";
      results.prepend(message);
    }
  });
}
