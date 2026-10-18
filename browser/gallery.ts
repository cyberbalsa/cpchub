import type { BrowserWindow } from "./types";
export function initialize(window: BrowserWindow) {
  const { document, Image, HTMLImageElement } = window;

  const initialized = new WeakSet<HTMLElement>();
  function setup() {
    const gallery = document.querySelector<HTMLElement>(
      "[data-screenshot-gallery]",
    );
    if (!gallery || initialized.has(gallery)) return;
    initialized.add(gallery);
    const links = [
      ...gallery.querySelectorAll<HTMLAnchorElement>("[data-screenshot]"),
    ];
    const preview = gallery.querySelector<HTMLAnchorElement>(
      "[data-screenshot-preview]",
    )!;
    const maybeDialog =
      gallery.querySelector<HTMLDialogElement>("#screenshot-viewer");
    if (
      !links.length ||
      !maybeDialog ||
      typeof maybeDialog.showModal !== "function"
    )
      return;
    const dialog = maybeDialog;
    const stage = dialog.querySelector<HTMLElement>("[data-screenshot-stage]")!;
    const zoom = dialog.querySelector<HTMLButtonElement>(
      "[data-screenshot-zoom]",
    )!;
    const status = dialog.querySelector<HTMLElement>(
      "[data-screenshot-status]",
    )!;
    let selected = 0;
    let revision = 0;

    function setZoom(enabled: boolean) {
      const image = stage.querySelector("img");
      if (image) {
        const fitScale = Math.min(
          stage.clientWidth / image.naturalWidth,
          stage.clientHeight / image.naturalHeight,
        );
        const scale = Math.max(1, fitScale * 2);
        image.style.width = enabled
          ? `${Math.round(image.naturalWidth * scale)}px`
          : "";
        image.style.height = enabled
          ? `${Math.round(image.naturalHeight * scale)}px`
          : "";
      }
      stage.classList.toggle("is-zoomed", enabled);
      zoom.setAttribute("aria-pressed", String(enabled));
      zoom.textContent = enabled ? "Fit image" : "Zoom in";
      stage.scrollTo(0, 0);
    }

    async function paint(
      container: HTMLElement,
      index: number,
      ticket: number,
      inDialog = false,
    ) {
      const link = links[index]!;
      let image = container.querySelector("img");
      try {
        if (!image || image.src !== link.href || !image.naturalWidth) {
          image = new Image();
          image.decoding = "async";
          image.alt = link.querySelector("img")!.alt;
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
          status.textContent =
            "This screenshot could not load. Close the viewer and try again.";
          status.hidden = false;
        }
      }
    }

    function choose(index: number) {
      selected = (index + links.length) % links.length;
      const ticket = ++revision;
      for (const [number, link] of links.entries()) {
        if (number === selected) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
      preview.href = links[selected]!.href;
      void paint(preview, selected, ticket);
      if (dialog.open) {
        setZoom(false);
        stage.replaceChildren();
        stage.setAttribute("aria-busy", "true");
        zoom.disabled = true;
        status.textContent = "Loading screenshot…";
        status.hidden = false;
        dialog.querySelector<HTMLElement>(
          "[data-screenshot-position]",
        )!.textContent = `${selected + 1} / ${links.length}`;
        dialog.querySelector<HTMLElement>(
          "[data-screenshot-caption]",
        )!.textContent = links[selected]!.dataset.caption ?? "";
        void paint(stage, selected, ticket, true);
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
      if (!(event.target instanceof window.Element)) return;
      const link = event.target.closest<HTMLAnchorElement>(
        "[data-screenshot], [data-screenshot-preview]",
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
      // Focus provides a consistent return point for keyboard and touch users.
      link.focus({ preventScroll: true });
      dialog.showModal();
      document.documentElement.classList.add("screenshot-viewer-open");
      choose(link === preview ? selected : links.indexOf(link));
    });
    dialog
      .querySelector<HTMLButtonElement>("[data-close-screenshots]")!
      .addEventListener("click", () => dialog.close());
    dialog
      .querySelector<HTMLButtonElement>("[data-screenshot-previous]")!
      .addEventListener("click", () => choose(selected - 1));
    dialog
      .querySelector<HTMLButtonElement>("[data-screenshot-next]")!
      .addEventListener("click", () => choose(selected + 1));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>(
      "[data-screenshot-previous], [data-screenshot-next]",
    ))
      button.hidden = links.length < 2;
    zoom.addEventListener("click", () =>
      setZoom(!stage.classList.contains("is-zoomed")),
    );
    stage.addEventListener("click", (event) => {
      if (event.target instanceof HTMLImageElement)
        setZoom(!stage.classList.contains("is-zoomed"));
    });
    dialog.addEventListener("keydown", (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        stage.classList.contains("is-zoomed")
      )
        return;
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      choose(selected + (event.key === "ArrowRight" ? 1 : -1));
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dialog.close();
    });
    dialog.addEventListener("close", () => {
      document.documentElement.classList.remove("screenshot-viewer-open");
      stage.replaceChildren();
      setZoom(false);
    });
  }
  setup();
  document.addEventListener("htmx:afterSwap", setup);
  document.addEventListener("htmx:historyRestore", setup);
}
