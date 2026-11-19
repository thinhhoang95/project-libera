import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppMenuItems } from "../../src/components/libera/app-menu";

type Sent = Record<string, Array<{ id?: string; label?: string }>>;

test("a render re-reads only its own menu and keeps the other menus' actions", async (context) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.document.hasFocus = () => true;
  const updates: Sent[] = [];
  let select: (id: string) => void = () => undefined;
  (window as unknown as { liberaAppMenu: unknown }).liberaAppMenu = { onSelect: (callback: (id: string) => void) => { select = callback; return () => {}; }, update: (menus: Sent) => { updates.push(menus); } };
  Object.assign(window, { requestIdleCallback: (callback: () => void) => { callback(); return 1; }, cancelIdleCallback: () => undefined });
  const reads = { view: 0, tab: 0 };
  const ran: string[] = [];
  let viewLabel = "one";
  let rerenderView: () => void = () => undefined;
  let rerenderTab: () => void = () => undefined;
  function View() {
    const [, setCount] = useState(0);
    rerenderView = () => setCount((count) => count + 1);
    useAppMenuItems("view", 0, () => { reads.view++; return [{ id: "v", label: viewLabel, onSelect: () => { ran.push(`view:${viewLabel}`); } }]; });
    return null;
  }
  function Tab() {
    const [, setCount] = useState(0);
    rerenderTab = () => setCount((count) => count + 1);
    useAppMenuItems("tab", 0, () => { reads.tab++; return [{ id: "t", label: "Tab", onSelect: () => { ran.push("tab"); } }]; });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    await act(async () => root.render(createElement("div", null, createElement(View), createElement(Tab))));
    await act(async () => context.mock.timers.tick(120));
    assert.equal(updates.length, 1);
    const before = { ...reads };

    // A render that changes nothing reads only its own menu and sends nothing.
    await act(async () => rerenderTab());
    await act(async () => context.mock.timers.tick(400));
    assert.deepEqual({ view: reads.view - before.view, tab: reads.tab - before.tab }, { view: 0, tab: 1 }, "the view provider is not read");
    assert.equal(updates.length, 1);

    // A change in one menu re-reads only that menu; the other menu's action still runs.
    viewLabel = "two";
    await act(async () => rerenderView());
    await act(async () => context.mock.timers.tick(400));
    assert.deepEqual({ view: reads.view - before.view, tab: reads.tab - before.tab }, { view: 1, tab: 1 }, "the tab provider is not read");
    assert.equal(updates.length, 2);
    assert.equal(updates[1].view[0].label, "two");
    assert.equal(updates[1].tab[0].label, "Tab");
    select("tab:t");
    select("view:v");
    assert.deepEqual(ran, ["tab", "view:two"]);

    // Regaining focus rebuilds everything.
    const readsBefore = { ...reads };
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); context.mock.timers.tick(120); });
    assert.deepEqual({ view: reads.view - readsBefore.view, tab: reads.tab - readsBefore.tab }, { view: 1, tab: 1 });
  } finally {
    context.mock.timers.reset();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
