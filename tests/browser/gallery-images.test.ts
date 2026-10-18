import test from "node:test";
import assert from "node:assert/strict";
import { dom, flush, deferred } from "./helpers";
import { initialize as gallery } from "../../browser/gallery";
import { initialize as images } from "../../browser/images";
function markup(two = true) {
  return (
    '<section data-screenshot-gallery><a data-screenshot-preview href="/one.webp"><img src="/one.webp"></a><a data-screenshot href="/one.webp" data-caption="First"><img alt="First"></a>' +
    (two
      ? '<a data-screenshot href="/two.webp" data-caption="&lt;script&gt;"><img alt="Second"></a>'
      : "") +
    '<dialog id="screenshot-viewer"><div data-screenshot-stage></div><p data-screenshot-status></p><button data-screenshot-zoom>Zoom</button><span data-screenshot-position></span><span data-screenshot-caption></span><button data-close-screenshots>Close</button><button data-screenshot-previous>Previous</button><button data-screenshot-next>Next</button></dialog></section>'
  );
}
void test("screenshot gallery supports preview, keyboard, zoom, modal controls and escaped captions", async (t) => {
  const absent = dom();
  t.after(absent.close);
  gallery(absent.window);
  const empty = dom("<section data-screenshot-gallery></section>");
  t.after(empty.close);
  gallery(empty.window);
  const f = dom(markup());
  t.after(f.close);
  gallery(f.window);
  const dialog = f.query<HTMLDialogElement>("dialog"),
    preview = f.query<HTMLAnchorElement>("[data-screenshot-preview]"),
    links = [
      ...f.window.document.querySelectorAll<HTMLAnchorElement>(
        "[data-screenshot]",
      ),
    ];
  f.click(preview);
  await flush();
  assert(dialog.open);
  assert.equal(f.query("[data-screenshot-position]").textContent, "1 / 2");
  f.click(f.query("[data-screenshot-next]"));
  await flush();
  assert.equal(f.query("[data-screenshot-caption]").textContent, "<script>");
  assert.equal(dialog.querySelector("script"), null);
  const zoom = f.query<HTMLButtonElement>("[data-screenshot-zoom]"),
    stage = f.query<HTMLElement>("[data-screenshot-stage]");
  f.click(zoom);
  assert.equal(zoom.getAttribute("aria-pressed"), "true");
  assert.equal(stage.querySelector("img")!.style.width, "100px");
  dialog.dispatchEvent(
    new f.window.KeyboardEvent("keydown", { key: "ArrowRight" }),
  );
  assert.equal(f.query("[data-screenshot-position]").textContent, "2 / 2");
  f.click(stage.querySelector("img")!);
  assert.equal(zoom.getAttribute("aria-pressed"), "false");
  f.click(stage);
  for (const key of ["ArrowLeft", "ArrowRight"]) {
    dialog.dispatchEvent(new f.window.KeyboardEvent("keydown", { key }));
    await flush();
  }
  for (const values of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }])
    dialog.dispatchEvent(
      new f.window.KeyboardEvent("keydown", { key: "ArrowRight", ...values }),
    );
  dialog.dispatchEvent(
    new f.window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  f.click(f.query("[data-screenshot-previous]"));
  await flush();
  f.click(dialog);
  assert(dialog.open);
  f.click(dialog, { clientX: -1 });
  assert.equal(dialog.open, false);
  assert.equal(stage.childElementCount, 0);
  links[0]!.dispatchEvent(new f.window.FocusEvent("focus"));
  links[1]!.dispatchEvent(new f.window.FocusEvent("focus"));
  await flush();
  assert(preview.href.endsWith("two.webp"));
  links[0]!.dispatchEvent(
    new f.window.PointerEvent("pointerenter", { pointerType: "touch" }),
  );
  assert(preview.href.endsWith("two.webp"));
  links[0]!.dispatchEvent(
    new f.window.PointerEvent("pointerenter", { pointerType: "mouse" }),
  );
  await flush();
  assert(preview.href.endsWith("one.webp"));
  links[0]!.dispatchEvent(
    new f.window.PointerEvent("pointerenter", { pointerType: "mouse" }),
  );
  links[0]!.dispatchEvent(new f.window.FocusEvent("focus"));
  for (const values of [
    { button: 1 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ])
    f.click(links[0]!, values);
  f.click(links[0]!, {}, true);
  assert.equal(dialog.open, false);
  f.click(links[1]!);
  await flush();
  assert(dialog.open);
  f.click(f.query("[data-close-screenshots]"));
  assert.equal(dialog.open, false);
  const text = f.window.document.createTextNode("text");
  f.query("section").append(text);
  f.click(text);
});
void test("gallery handles one image, unsupported dialogs, failed decodes and obsolete in-flight images", async (t) => {
  const single = dom(markup(false));
  t.after(single.close);
  gallery(single.window);
  assert(single.query<HTMLButtonElement>("[data-screenshot-next]").hidden);
  single.query("[data-screenshot]").removeAttribute("data-caption");
  single.click(single.query("[data-screenshot]"));
  await flush();
  assert.equal(single.query("[data-screenshot-caption]").textContent, "");
  const unsupported = dom(markup());
  t.after(unsupported.close);
  Object.defineProperty(
    unsupported.window.HTMLDialogElement.prototype,
    "showModal",
    { value: undefined },
  );
  gallery(unsupported.window);
  const f = dom(markup());
  t.after(f.close);
  const waiting: ReturnType<typeof deferred<void>>[] = [];
  Object.defineProperty(f.window.HTMLImageElement.prototype, "decode", {
    value: () => {
      const result = deferred<void>();
      waiting.push(result);
      return result.promise;
    },
  });
  gallery(f.window);
  const links = [...f.window.document.querySelectorAll("[data-screenshot]")];
  links[1]!.dispatchEvent(new f.window.FocusEvent("focus"));
  f.click(f.query("[data-screenshot-preview]"));
  waiting[0]!.reject(Error("obsolete"));
  for (const pending of waiting.slice(1)) pending.reject(Error("failed"));
  await flush();
  assert.match(
    f.query("[data-screenshot-status]").textContent,
    /could not load/,
  );
  const start = waiting.length;
  f.click(f.query("[data-screenshot-next]"));
  f.query<HTMLDialogElement>("dialog").close();
  for (const pending of waiting.slice(start)) pending.resolve();
  await flush();
  assert.equal(f.query("[data-screenshot-stage]").childElementCount, 0);
  const begin = waiting.length;
  links[0]!.dispatchEvent(new f.window.FocusEvent("focus"));
  links[1]!.dispatchEvent(new f.window.FocusEvent("focus"));
  for (const pending of waiting.slice(begin)) pending.resolve();
  await flush();
  assert(
    f
      .query<HTMLAnchorElement>("[data-screenshot-preview]")
      .href.endsWith("two.webp"),
  );
});
void test("image enhancement waits for decoding, handles failed and duplicate events, and initializes HTMX content", async (t) => {
  const f = dom(
    '<img id="good" data-image><img id="bad" data-image><img id="plain"><img id="loading" data-image>',
  );
  t.after(f.close);
  const good = f.query<HTMLImageElement>("#good"),
    bad = f.query<HTMLImageElement>("#bad"),
    loading = f.query<HTMLImageElement>("#loading");
  const ready = deferred<void>();
  Object.defineProperty(good, "decode", { value: () => ready.promise });
  Object.defineProperty(bad, "decode", {
    value: async () => {
      throw Error("unavailable");
    },
  });
  Object.defineProperty(bad, "naturalWidth", { value: 0 });
  Object.defineProperty(loading, "complete", { value: false });
  loading.dataset.imageState = "old";
  images(f.window);
  f.window.document.dispatchEvent(new f.window.Event("DOMContentLoaded"));
  good.dispatchEvent(new f.window.Event("load"));
  f.query("#plain").dispatchEvent(new f.window.Event("load"));
  f.window.document.dispatchEvent(new f.window.Event("load"));
  assert.equal(good.dataset.imageState, undefined);
  ready.resolve();
  await flush();
  assert.equal(good.dataset.imageState, "ready");
  assert.equal(bad.dataset.imageState, "failed");
  assert.equal(loading.dataset.imageState, undefined);
  loading.dispatchEvent(new f.window.Event("error"));
  assert.equal(loading.dataset.imageState, "failed");
  f.query("#plain").dispatchEvent(new f.window.Event("error"));
  f.window.document.dispatchEvent(new f.window.Event("error"));
  f.custom("htmx:afterSwap", { elt: good });
  f.custom("htmx:oobAfterSwap", { elt: f.window.document.body });
  f.custom("htmx:afterSwap", { elt: null });
  f.custom("htmx:historyRestore", {});
  await flush();
  assert(
    f.window.document.documentElement.classList.contains("enhanced-images"),
  );
});
