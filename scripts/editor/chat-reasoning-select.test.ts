import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { ChatReasoningSelect, effortAfterDrag } from "../../src/components/libera/chat-reasoning-select";
import type { ChatReasoningEffort } from "../../src/lib/document-chat";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLSelectElement", "Element", "Node", "MouseEvent", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key as keyof typeof dom.window] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("a drag steps through the levels and stops at either end", () => {
  assert.equal(effortAfterDrag("medium", 0), "medium");
  assert.equal(effortAfterDrag("medium", 22), "high");
  assert.equal(effortAfterDrag("medium", 44), "xhigh");
  assert.equal(effortAfterDrag("medium", -22), "low");
  assert.equal(effortAfterDrag("medium", 500), "max");
  assert.equal(effortAfterDrag("medium", -500), "low");
});

async function mount(disabled = false) {
  const { createRoot } = await import("react-dom/client");
  const changes: string[] = [];
  function Harness() {
    const [value, setValue] = useState<ChatReasoningEffort>("medium");
    return createElement(ChatReasoningSelect, { value, disabled, onChange: (effort) => { changes.push(effort); setValue(effort); } });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  const select = host.querySelector("select")!;
  let opened = 0;
  select.setPointerCapture = () => {};
  select.showPicker = () => { opened++; };
  const pointer = (type: string, clientX: number) => act(async () => {
    select.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
  });
  return { select, changes, pointer, opened: () => opened, close: () => { root.unmount(); host.remove(); } };
}

test("dragging changes the level without opening the list", async () => {
  const view = await mount();
  try {
    await view.pointer("pointerdown", 100);
    await view.pointer("pointermove", 124);
    assert.equal(view.select.value, "high");
    assert.equal(view.select.dataset.dragging, "true");
    await view.pointer("pointermove", 150);
    assert.equal(view.select.value, "xhigh");
    await view.pointer("pointermove", 60);
    assert.equal(view.select.value, "low");
    await view.pointer("pointerup", 60);
    assert.deepEqual(view.changes, ["high", "xhigh", "low"]);
    assert.equal(view.select.dataset.dragging, undefined);
    assert.equal(view.opened(), 0);
    // After release, moving the pointer does nothing.
    await view.pointer("pointermove", 200);
    assert.equal(view.select.value, "low");
  } finally { view.close(); }
});

test("a click, even an unsteady one, opens the list and changes nothing", async () => {
  const view = await mount();
  try {
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => { view.select.dispatchEvent(press); });
    assert.equal(press.defaultPrevented, true, "The list must not open on mouse down.");
    await view.pointer("pointerdown", 100);
    await view.pointer("pointermove", 101);
    await view.pointer("pointerup", 101);
    assert.equal(view.opened(), 1);
    assert.deepEqual(view.changes, []);
  } finally { view.close(); }
});

test("choosing from the list still works, and a disabled select ignores a drag", async () => {
  const view = await mount();
  try {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(view.select, "max");
      view.select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(view.changes, ["max"]);
  } finally { view.close(); }
  const disabled = await mount(true);
  try {
    await disabled.pointer("pointerdown", 100);
    await disabled.pointer("pointermove", 160);
    await disabled.pointer("pointerup", 160);
    assert.deepEqual(disabled.changes, []);
    assert.equal(disabled.opened(), 0);
  } finally { disabled.close(); }
});
