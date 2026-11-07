import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { CollabTooltip, type TooltipTriggerProps } from "../../src/components/libera/collab/collab-tooltip";

const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 20, bottom: 50, height: 30, x: left, y: 20 }) as DOMRect;

test("a tooltip opens at its trigger, wherever that is in the window", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1000 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return rect(Number(this.dataset.left), 30);
  };
  const root = createRoot(document.getElementById("root") as HTMLElement);
  const placed = async (triggerLeft: number) => {
    await act(async () => {
      const trigger = (props: TooltipTriggerProps) => createElement("button", { ...props, "data-left": triggerLeft });
      root.render(createElement(CollabTooltip, { content: "Thinh Hoang" } as never, trigger as never));
    });
    const button = document.querySelector("button") as HTMLElement;
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
    const { left, right } = (document.querySelector('[role="tooltip"]') as HTMLElement).style;
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })); });
    return { left, right };
  };
  try {
    await t.test("it starts at the trigger's left edge when the widest tooltip fits", async () => {
      assert.deepEqual(await placed(600), { left: "600px", right: "" });
    });
    await t.test("near the window's edge it ends at the trigger's right edge", async () => {
      assert.deepEqual(await placed(800), { left: "", right: "170px" }, "the old 296px allowance left it at 704px, away from the trigger");
    });
    await t.test("it stays inside the window", async () => {
      assert.deepEqual(await placed(0), { left: "8px", right: "" });
      assert.deepEqual(await placed(975), { left: "", right: "8px" });
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
