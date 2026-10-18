"use strict";
(() => {
  const gallery = document.querySelector("[data-screenshot-gallery]");
  if (!gallery) return;
  const links = [...gallery.querySelectorAll("[data-screenshot]")];
  const preview = gallery.querySelector("[data-screenshot-preview]");
  const dialog = gallery.querySelector("#screenshot-viewer");
  if (!links.length || !dialog || typeof dialog.showModal !== "function") return;
  const stage = dialog.querySelector("[data-screenshot-stage]");
  const zoom = dialog.querySelector("[data-screenshot-zoom]");
  const status = dialog.querySelector("[data-screenshot-status]");
  let selected = 0;
  let revision = 0;

  function setZoom(enabled) {
    const image = stage.querySelector("img");
    if (image) {
      const fitScale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
      const scale = Math.max(1, fitScale * 2);
      image.style.width = enabled ? `${Math.round(image.naturalWidth * scale)}px` : "";
      image.style.height = enabled ? `${Math.round(image.naturalHeight * scale)}px` : "";
    }
    stage.classList.toggle("is-zoomed", enabled);
    zoom.setAttribute("aria-pressed", String(enabled));
    zoom.textContent = enabled ? "Fit image" : "Zoom in";
    stage.scrollTo(0, 0);
  }

  async function paint(container, index, ticket, inDialog = false) {
    const link = links[index];
    let image = container.querySelector("img");
    try {
      if (!image || image.src !== link.href || !image.naturalWidth) {
        image = new Image();
        image.decoding = "async";
        image.alt = link.querySelector("img").alt;
        image.src = link.href;
      }
      await image.decode();
      if (ticket !== revision || (inDialog && !dialog.open)) return;
      image.dataset.image = "";
      image.dataset.imageState = "ready";
      // Replace only after decoding, so the previous preview stays visible.
      container.replaceChildren(image);
      if (inDialog) {
        status.hidden = true;
        stage.removeAttribute("aria-busy");
        zoom.disabled = false;
      }
    } catch {
      if (ticket !== revision) return;
      if (inDialog && dialog.open) {
        stage.replaceChildren();
        stage.removeAttribute("aria-busy");
        status.textContent = "This screenshot could not load. Close the viewer and try again.";
        status.hidden = false;
      }
    }
  }

  function choose(index) {
    selected = (index + links.length) % links.length;
    const ticket = ++revision;
    for (const [number, link] of links.entries()) {
      if (number === selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    preview.href = links[selected].href;
    paint(preview, selected, ticket);
    if (dialog.open) {
      setZoom(false);
      stage.replaceChildren();
      stage.setAttribute("aria-busy", "true");
      zoom.disabled = true;
      status.textContent = "Loading screenshot…";
      status.hidden = false;
      dialog.querySelector("[data-screenshot-position]").textContent = `${selected + 1} / ${links.length}`;
      dialog.querySelector("[data-screenshot-caption]").textContent = links[selected].dataset.caption;
      paint(stage, selected, ticket, true);
    }
  }

  for (const [index, link] of links.entries()) {
    link.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch" && index !== selected) choose(index);
    });
    link.addEventListener("focus", () => {
      if (index !== selected) choose(index);
    });
  }
  gallery.addEventListener("click", (event) => {
    const link = event.target.closest("[data-screenshot], [data-screenshot-preview]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Focus provides a consistent return point for keyboard and touch users.
    link.focus({preventScroll: true});
    dialog.showModal();
    document.documentElement.classList.add("screenshot-viewer-open");
    choose(link === preview ? selected : links.indexOf(link));
  });
  dialog.querySelector("[data-close-screenshots]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-screenshot-previous]").addEventListener("click", () => choose(selected - 1));
  dialog.querySelector("[data-screenshot-next]").addEventListener("click", () => choose(selected + 1));
  for (const button of dialog.querySelectorAll("[data-screenshot-previous], [data-screenshot-next]")) button.hidden = links.length < 2;
  zoom.addEventListener("click", () => setZoom(!stage.classList.contains("is-zoomed")));
  stage.addEventListener("click", (event) => {
    if (event.target instanceof HTMLImageElement) setZoom(!stage.classList.contains("is-zoomed"));
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || stage.classList.contains("is-zoomed")) return;
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    choose(selected + (event.key === "ArrowRight" ? 1 : -1));
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("screenshot-viewer-open");
    stage.replaceChildren();
    setZoom(false);
  });
})();
