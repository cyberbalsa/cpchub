import { JSDOM, VirtualConsole } from "jsdom";
import type { BrowserWindow } from "../../browser/types";
import assert from "node:assert/strict";
export function dom(html = "") {
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => {
    if (!("type" in error) || error.type !== "not-implemented")
      errors.push(error);
  });
  const instance = new JSDOM(html, {
    url: "https://cpchub.net/",
    virtualConsole: console,
    pretendToBeVisual: true,
  });
  const actual = instance.window as unknown as BrowserWindow;
  const navigated: string[] = [];
  const location: Location = {
    ancestorOrigins: actual.location.ancestorOrigins,
    hash: "",
    host: "cpchub.net",
    hostname: "cpchub.net",
    href: "https://cpchub.net/",
    origin: "https://cpchub.net",
    pathname: "/",
    port: "",
    protocol: "https:",
    search: "",
    assign(url) {
      navigated.push(String(url));
    },
    replace(url) {
      navigated.push(String(url));
    },
    reload() {},
    toString() {
      return this.href;
    },
  };
  const window = new Proxy(actual, {
    get(target, name) {
      if (name === "location") return location;
      if (name === "addEventListener")
        return target.addEventListener.bind(target);
      if (name === "removeEventListener")
        return target.removeEventListener.bind(target);
      if (name === "dispatchEvent") return target.dispatchEvent.bind(target);
      return Reflect.get(target, name, target) as unknown;
    },
  });
  window.fetch = async () => Response.json({});
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(window.HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: async function (this: HTMLImageElement) {},
  });
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get() {
      return 100;
    },
  });
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalHeight", {
    configurable: true,
    get() {
      return 100;
    },
  });
  Object.defineProperty(window.HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(window.HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new window.Event("close"));
    },
  });
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const el = window.document.querySelector<T>(selector);
    assert(el, selector);
    return el;
  };
  const click = (
    target: EventTarget,
    values: MouseEventInit = {},
    prevent = false,
  ) => {
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...values,
    });
    if (prevent) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  const submit = (target: EventTarget) =>
    target.dispatchEvent(
      new window.SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
  const custom = (name: string, detail: unknown) =>
    window.document.dispatchEvent(new window.CustomEvent(name, { detail }));
  return {
    window,
    query,
    click,
    submit,
    custom,
    navigated,
    errors,
    close() {
      instance.window.close();
      assert.deepEqual(errors, []);
    },
  };
}
export const flush = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
