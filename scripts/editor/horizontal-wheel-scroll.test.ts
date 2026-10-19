import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { horizontalWheelDelta, useHorizontalWheelScroll } from "../../src/components/libera/use-horizontal-wheel-scroll";

test("vertical wheel movement becomes horizontal; trackpads and Shift+wheel are left alone", () => {
  assert.equal(horizontalWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: false }, 300), 40);
  assert.equal(horizontalWheelDelta({ deltaX: 0, deltaY: -3, deltaMode: 1, shiftKey: false }, 300), -48);
  assert.equal(horizontalWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, 300), 300);
  assert.equal(horizontalWheelDelta({ deltaX: 30, deltaY: 5, deltaMode: 0, shiftKey: false }, 300), 0, "a horizontal trackpad swipe scrolls natively");
  assert.equal(horizontalWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }, 300), 0, "Shift+wheel scrolls natively");
});

test("the hook scrolls an overflowing toolbar and only blocks the page when it moved", async () => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    let toolbar: HTMLDivElement | null = null;
    function Toolbar() {
      const ref = useRef<HTMLDivElement>(null);
      useHorizontalWheelScroll(ref);
      return createElement("div", {
        ref: (element: HTMLDivElement | null) => {
          ref.current = element;
          toolbar = element;
        },
      });
    }
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => root.render(createElement(Toolbar)));
    const element = toolbar!;
    // jsdom has no layout: give the toolbar an overflowing size and a clamped scrollLeft.
    let scrollLeft = 0;
    Object.defineProperty(element, "scrollWidth", { value: 600 });
    Object.defineProperty(element, "clientWidth", { value: 200 });
    Object.defineProperty(element, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.max(0, Math.min(400, value));
      },
    });
    const wheel = (deltaY: number) => {
      const event = new dom.window.WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(wheel(100), true);
    assert.equal(scrollLeft, 100);
    assert.equal(wheel(1000), true);
    assert.equal(scrollLeft, 400);
    assert.equal(wheel(50), false, "at the end the wheel reaches the page");
    assert.equal(wheel(-150), true);
    assert.equal(scrollLeft, 250);
    await act(async () => root.unmount());
  } finally {
    globals.window = saved.window;
    globals.document = saved.document;
    globals.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
  }
});
