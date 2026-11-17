import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the document carries data-window-inactive and data-on-battery for the glow animations", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  let focused = true;
  dom.window.document.hasFocus = () => focused;
  const battery = Object.assign(new dom.window.EventTarget(), { charging: true });
  Object.defineProperty(dom.window.navigator, "getBattery", { configurable: true, value: async () => battery });
  const { installWindowActivityAttributes } = await import("../../src/lib/window-activity");
  const root = dom.window.document.documentElement;
  try {
    installWindowActivityAttributes();
    installWindowActivityAttributes();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.hasAttribute("data-window-inactive"), false);
    assert.equal(root.hasAttribute("data-on-battery"), false);

    focused = false;
    dom.window.dispatchEvent(new dom.window.Event("blur"));
    assert.equal(root.getAttribute("data-window-inactive"), "true");
    focused = true;
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    assert.equal(root.hasAttribute("data-window-inactive"), false);

    battery.charging = false;
    battery.dispatchEvent(new dom.window.Event("chargingchange"));
    assert.equal(root.getAttribute("data-on-battery"), "true");
    battery.charging = true;
    battery.dispatchEvent(new dom.window.Event("chargingchange"));
    assert.equal(root.hasAttribute("data-on-battery"), false);

    // Idempotent: a second install added no second set of listeners.
    let writes = 0;
    const set = root.setAttribute.bind(root);
    root.setAttribute = (name: string, value: string) => { writes++; set(name, value); };
    focused = false;
    dom.window.dispatchEvent(new dom.window.Event("blur"));
    assert.equal(writes, 1);
  } finally {
    dom.window.close();
  }
});
