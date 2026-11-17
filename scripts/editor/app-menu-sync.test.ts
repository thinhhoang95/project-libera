import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppMenuItems } from "../../src/components/libera/app-menu";

test("a burst of renders syncs the menus once, when idle, and never while the window is unfocused", async (context) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let focused = true;
  dom.window.document.hasFocus = () => focused;
  let reads = 0;
  const updates: unknown[] = [];
  (window as unknown as { liberaAppMenu: unknown }).liberaAppMenu = { onSelect: () => () => {}, update: (menus: unknown) => { updates.push(menus); } };
  let idleRequests = 0;
  let idleCallbacks: Array<() => void> = [];
  Object.assign(window, { requestIdleCallback: (callback: () => void) => { idleRequests++; idleCallbacks.push(callback); return idleRequests; }, cancelIdleCallback: () => undefined });
  let rerender!: () => void;
  let label = "one";
  function Harness() {
    const [, setCount] = useState(0);
    rerender = () => setCount((count) => count + 1);
    useAppMenuItems("view", 0, () => { reads++; return [{ id: "x", label, onSelect: () => undefined }]; });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const flushIdle = async () => { const run = idleCallbacks; idleCallbacks = []; await act(async () => { run.forEach((callback) => callback()); await Promise.resolve(); }); };
  try {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    await act(async () => root.render(createElement(Harness)));
    await act(async () => context.mock.timers.tick(120));
    assert.equal(updates.length, 1, "mounting syncs promptly");
    const readsAfterMount = reads;

    // Fifty renders 20 ms apart: nothing runs while they keep coming, then one sync.
    label = "two";
    for (let i = 0; i < 50; i++) {
      await act(async () => rerender());
      await act(async () => context.mock.timers.tick(20));
    }
    assert.equal(reads, readsAfterMount, "no menu is read during the burst");
    assert.equal(idleRequests, 0);
    await act(async () => context.mock.timers.tick(300));
    assert.equal(idleRequests, 1, "one idle sync is requested once the renders settle");
    await flushIdle();
    assert.equal(reads - readsAfterMount, 1, "the burst read the menus once");
    assert.equal(updates.length, 2, "and sent the changed menu");

    // Renders that change nothing read once and send nothing.
    await act(async () => rerender());
    await act(async () => context.mock.timers.tick(300));
    await flushIdle();
    assert.equal(updates.length, 2, "an unchanged menu is not resent");

    // Renders never stretch the wait past two seconds.
    const idleBefore = idleRequests;
    for (let i = 0; i < 30; i++) {
      await act(async () => rerender());
      await act(async () => context.mock.timers.tick(100));
    }
    assert.ok(idleRequests > idleBefore, "continuous renders still sync within the maximum wait");
    await flushIdle();

    // An unfocused window skips the sync; regaining focus syncs promptly.
    focused = false;
    label = "three";
    const readsBefore = reads;
    await act(async () => rerender());
    await act(async () => context.mock.timers.tick(3_000));
    await flushIdle();
    assert.equal(reads, readsBefore, "an unfocused window does not rebuild menus");
    focused = true;
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); context.mock.timers.tick(120); });
    assert.equal(reads - readsBefore, 1, "focus syncs promptly");
    assert.equal(updates.length, 3);
  } finally {
    context.mock.timers.reset();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
