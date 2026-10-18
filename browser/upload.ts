import { array, object, optional, string } from "zod/mini";
const replySchema = object({
  redirect_url: optional(string()),
  errors: optional(array(string())),
});
import type { BrowserWindow } from "./types";
export function initialize(window: BrowserWindow) {
  const { document, FormData } = window;
  (() => {
    const candidate = document.querySelector<HTMLFormElement>(
      "[data-creation-upload]",
    );
    if (!candidate || !window.fetch || !window.FormData) return;
    const form = candidate;

    const contentType = form.querySelector<HTMLSelectElement>(
      '[name="content_type"]',
    )!;
    const gameFile = form.querySelector<HTMLInputElement>('[name="file"]')!;
    function updateFileType() {
      gameFile.accept = contentType.value === "blueprints" ? ".cpbp" : ".cpcs";
    }
    updateFileType();
    contentType.addEventListener("change", () => {
      gameFile.value = "";
      updateFileType();
    });

    const notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.tabIndex = -1;
    notice.hidden = true;
    form.prepend(notice);
    let submitting = false;

    form.addEventListener("submit", (event) => {
      void handleSubmit(event);
    });
    async function handleSubmit(event: SubmitEvent) {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Uploading…";
      form.setAttribute("aria-busy", "true");
      notice.hidden = true;
      form.querySelectorAll(".errorlist").forEach((list) => list.remove());

      try {
        // The hidden input named "action" shadows form.action.
        const response = await window.fetch(
          form.getAttribute("action") || window.location.href,
          {
            method: "POST",
            body: new FormData(form),
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        );
        if (response.redirected) throw new Error("Unexpected redirect");
        const data = replySchema.parse(await response.json());
        if (response.ok && data.redirect_url) {
          window.location.assign(data.redirect_url);
          return;
        }
        if (!Array.isArray(data.errors) || !data.errors.length)
          throw new Error("Unexpected response");
        showErrors(data.errors);
      } catch (error) {
        showErrors([
          "The upload could not be confirmed. Your details and selected files are still here. Check My uploads before retrying.",
        ]);
      } finally {
        submitting = false;
        button.disabled = false;
        button.textContent = label;
        form.removeAttribute("aria-busy");
      }
    }

    function showErrors(errors: string[]) {
      const list = document.createElement("ul");
      list.className = "errorlist";
      errors.forEach((message) => {
        const item = document.createElement("li");
        item.textContent = message;
        list.append(item);
      });
      notice.replaceChildren(list);
      notice.hidden = false;
      notice.focus();
    }
  })();
}
