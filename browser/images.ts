import type { BrowserWindow } from "./types";
export function initialize(window: BrowserWindow) {
  const { document, HTMLImageElement, Element, Document } = window;
  const selector = "img[data-image]";
  const decoding = new WeakSet<HTMLImageElement>();
  async function reveal(image: HTMLImageElement) {
    if (!image.matches(selector) || decoding.has(image)) return;
    decoding.add(image);
    try {
      await image.decode();
    } catch {
      /* Failed images retain their alt text. */
    }
    image.dataset.imageState = image.naturalWidth ? "ready" : "failed";
    decoding.delete(image);
  }
  function prepare(root: unknown) {
    if (!(root instanceof Element || root instanceof Document)) return;
    const images = [...root.querySelectorAll<HTMLImageElement>(selector)];
    if (root instanceof HTMLImageElement && root.matches(selector))
      images.unshift(root);
    for (const image of images) {
      if (image.complete) void reveal(image);
      else delete image.dataset.imageState;
    }
  }
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLImageElement) void reveal(event.target);
    },
    true,
  );
  document.addEventListener(
    "error",
    (event) => {
      if (
        event.target instanceof HTMLImageElement &&
        event.target.matches(selector)
      )
        event.target.dataset.imageState = "failed";
    },
    true,
  );
  document.addEventListener("DOMContentLoaded", () => prepare(document));
  for (const eventName of ["htmx:afterSwap", "htmx:oobAfterSwap"]) {
    document.addEventListener(eventName, (event) =>
      prepare((event as CustomEvent<{ elt: unknown }>).detail.elt),
    );
  }
  document.addEventListener("htmx:historyRestore", () => prepare(document));
  document.documentElement.classList.add("enhanced-images");
}
