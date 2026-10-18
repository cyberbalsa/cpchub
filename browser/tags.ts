import { array, number, object, optional, string } from "zod/mini";
const tagsSchema = array(
  object({ name: string(), item_count: optional(number()) }),
);
import type { BrowserWindow } from "./types";
export function initialize(window: BrowserWindow) {
  const { document, location, URL, AbortController, clearTimeout } = window;
  (() => {
    const bindings = new WeakMap<HTMLInputElement, AbortController>();
    function initialize() {
      document
        .querySelectorAll<HTMLInputElement>("input[data-tag-input]")
        .forEach((input) => {
          if (input.dataset.tagReady) return;
          input.dataset.tagReady = "true";
          bindings.get(input)?.abort();
          const binding = new AbortController();
          bindings.set(input, binding);
          const choices = document.querySelectorAll<HTMLButtonElement>(
            `[data-tag-target="${input.id}"] [data-tag-value]`,
          );
          const selected = () =>
            input.value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean);
          function syncChoices() {
            const parts = selected();
            choices.forEach((choice) => {
              const name = choice.dataset.tagValue!;
              const active = parts.some((part) => part.toLowerCase() === name);
              choice.setAttribute("aria-pressed", String(active));
              choice.disabled =
                !active &&
                input.maxLength >= 0 &&
                [...parts, name].join(", ").length > input.maxLength;
            });
          }
          choices.forEach((choice) => {
            choice.addEventListener(
              "click",
              () => {
                const name = choice.dataset.tagValue!;
                const parts = selected();
                input.value = (
                  parts.some((part) => part.toLowerCase() === name)
                    ? parts.filter((part) => part.toLowerCase() !== name)
                    : [...parts, name]
                ).join(", ");
                input.dispatchEvent(
                  new window.Event("input", { bubbles: true }),
                );
              },
              { signal: binding.signal },
            );
          });
          syncChoices();
          const list = document.createElement("datalist");
          list.id = `${input.id}-suggestions`;
          input.setAttribute("list", list.id);
          input.after(list);
          let timer: number | undefined,
            controller: AbortController | undefined;
          binding.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            controller?.abort();
          });
          async function suggest() {
            controller?.abort();
            controller = new AbortController();
            const value = input.value;
            const multiple = input.dataset.tagMultiple === "true";
            const parts = multiple ? value.split(",") : [value];
            const query = parts.pop()!.trim();
            const prefix = parts.length
              ? parts.map((part) => part.trim()).join(", ") + ", "
              : "";
            try {
              const url = new URL(input.dataset.tagInput!, location.origin);
              url.searchParams.set("q", query);
              const response = await window.fetch(url, {
                signal: controller.signal,
                credentials: "same-origin",
                headers: { Accept: "application/json" },
              });
              if (!response.ok) return;
              const data: unknown = await response.json();
              if (input.value !== value || !input.isConnected) return;
              const tags = tagsSchema.parse(
                Array.isArray(data)
                  ? data
                  : object({ results: tagsSchema }).parse(data).results,
              );
              list.replaceChildren(
                ...tags
                  .filter(
                    (tag) =>
                      !parts.some(
                        (part) => part.trim().toLowerCase() === tag.name,
                      ),
                  )
                  .slice(0, 200)
                  .map((tag) => {
                    const option = document.createElement("option");
                    option.value = prefix + tag.name;
                    if (tag.item_count !== undefined)
                      option.label = `${tag.name} (${tag.item_count})`;
                    return option;
                  }),
              );
            } catch (error) {
              // The input remains usable when suggestions cannot be loaded.
            }
          }
          input.addEventListener(
            "input",
            () => {
              syncChoices();
              clearTimeout(timer);
              controller?.abort();
              list.replaceChildren();
              timer = window.setTimeout(() => {
                void suggest();
              }, 180);
            },
            { signal: binding.signal },
          );
          input.addEventListener(
            "focus",
            () => {
              void suggest();
            },
            { signal: binding.signal },
          );
        });
    }
    initialize();
    document.addEventListener("htmx:afterSwap", initialize);
    document.addEventListener("htmx:historyRestore", () => {
      document
        .querySelectorAll<HTMLInputElement>("input[data-tag-input]")
        .forEach((input) => {
          delete input.dataset.tagReady;
          document.getElementById(input.getAttribute("list")!)?.remove();
        });
      initialize();
    });
  })();
}
