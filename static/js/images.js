"use strict";

// Run before the body is parsed so a partially decoded image never flashes first.
// If this script is unavailable, images retain normal browser loading behavior.
(() => {
  const selector = "img[data-image]";
  const decoding = new WeakSet();

  async function reveal(image) {
    if (!image.matches(selector) || decoding.has(image)) return;
    decoding.add(image);
    try {
      await image.decode();
    } catch {
      // An unavailable image should show its alt text, not an endless placeholder.
    }
    image.dataset.imageState = image.naturalWidth ? "ready" : "failed";
    decoding.delete(image);
  }

  function prepare(root) {
    if (!root?.querySelectorAll) return;
    const images = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) images.unshift(root);
    for (const image of images) {
      if (image.complete) reveal(image);
      else delete image.dataset.imageState;
    }
  }

  document.addEventListener("load", (event) => {
    if (event.target instanceof HTMLImageElement) reveal(event.target);
  }, true);
  document.addEventListener("error", (event) => {
    if (event.target.matches?.(selector)) event.target.dataset.imageState = "failed";
  }, true);
  document.addEventListener("DOMContentLoaded", () => prepare(document));
  // Filters, pagination, the overview panel, and cached history all insert images.
  for (const eventName of ["htmx:afterSwap", "htmx:oobAfterSwap"]) {
    document.addEventListener(eventName, (event) => prepare(event.detail.elt));
  }
  document.addEventListener("htmx:historyRestore", () => prepare(document));
  document.documentElement.classList.add("enhanced-images");
})();
