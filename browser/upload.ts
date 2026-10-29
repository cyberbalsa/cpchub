import { array, number, object, optional, string } from "zod/mini";
const replySchema = object({
  redirect_url: optional(string()),
  errors: optional(array(string())),
  retry_after: optional(number()),
});
const csrfSchema = object({ csrf_token: string() });
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
    let refreshCSRF = false;

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
        // A sign-in in another tab changes the token, but needn't lose this form.
        if (refreshCSRF) {
          const response = await window.fetch("/accounts/csrf/", {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          const result = csrfSchema.safeParse(
            await response.json().catch(() => null),
          );
          if (!response.ok || !result.success) {
            showErrors(
              ["Your sign-in could not be checked. Try again in a moment."],
              response,
              true,
            );
            return;
          }
          form.querySelector<HTMLInputElement>(
            '[name="csrfmiddlewaretoken"]',
          )!.value = result.data.csrf_token;
          refreshCSRF = false;
        }
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
        if (
          response.status === 401 ||
          (response.redirected &&
            new URL(response.url).pathname === "/accounts/login/")
        ) {
          signInError(response);
          return;
        }
        if (response.headers.get("cf-mitigated") === "challenge") {
          showErrors(
            [
              "A browser security check interrupted the upload. Open CPC Hub in a new tab to complete the check, then return here and try again.",
            ],
            response,
          );
          addLink("Open CPC Hub in a new tab", "/");
          return;
        }
        const parsed = replySchema.safeParse(
          await response.json().catch(() => null),
        );
        const data = parsed.success ? parsed.data : {};
        if (!response.redirected && response.ok && data.redirect_url) {
          window.location.assign(data.redirect_url);
          return;
        }
        if (
          response.status === 403 &&
          data.errors?.some((e) => /csrf/i.test(e))
        ) {
          signInError(response);
          return;
        }
        if (data.errors?.length && response.status < 500) {
          showErrors(data.errors, response);
          return;
        }
        let message: string;
        if (response.status === 403)
          message =
            "The site's security checks blocked this upload. If it keeps happening, contact the site admin and include the error details below.";
        else if (response.status === 413)
          message =
            "The upload is too large. Choose smaller files or fewer screenshots, then try again.";
        else if (response.status === 429) {
          const seconds = Number(
            response.headers.get("Retry-After") || data.retry_after,
          );
          message =
            Number.isFinite(seconds) && seconds > 0
              ? `Too many upload attempts. Wait ${Math.ceil(seconds)} seconds and try again.`
              : "Too many upload attempts. Wait a few minutes and try again.";
        } else if (response.status >= 500)
          message =
            "The upload service is having trouble. Check My uploads before trying again in a few minutes.";
        else
          message =
            "The server returned an unexpected response. Check My uploads before retrying.";
        showErrors([...(data.errors || []), message], response);
      } catch {
        showErrors([
          window.navigator.onLine === false
            ? "You're offline. Reconnect, then check My uploads before retrying."
            : "The connection was interrupted before the upload could be confirmed. Check your connection and My uploads before retrying.",
        ]);
      } finally {
        submitting = false;
        button.disabled = false;
        button.textContent = label;
        form.removeAttribute("aria-busy");
      }
    }

    function signInError(response: Response) {
      refreshCSRF = true;
      showErrors(
        [
          "Your sign-in changed or expired. Sign in in a new tab, then return here and try again.",
        ],
        response,
        true,
      );
    }

    function addLink(label: string, href: string) {
      const paragraph = document.createElement("p");
      const link = document.createElement("a");
      link.textContent = label;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      paragraph.append(link);
      notice.append(paragraph);
    }

    function showErrors(errors: string[], response?: Response, signIn = false) {
      const list = document.createElement("ul");
      list.className = "errorlist";
      errors.forEach((message) => {
        const item = document.createElement("li");
        item.textContent = message;
        list.append(item);
      });
      notice.replaceChildren(list);
      const retained = document.createElement("p");
      retained.textContent =
        "Your details and selected files are still here. Keep this tab open.";
      notice.append(retained);
      addLink("Check My uploads in a new tab", "/?view=mine");
      if (signIn) addLink("Sign in in a new tab", "/accounts/login/");
      if (response) {
        const reference = document.createElement("p");
        const ray = response.headers.get("cf-ray");
        reference.textContent = `HTTP ${response.status}${ray ? ` · Request ID: ${ray}` : ""}`;
        notice.append(reference);
      }
      notice.hidden = false;
      notice.focus();
    }
  })();
}
