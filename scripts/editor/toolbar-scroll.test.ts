import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachHorizontalToolbarScroll } from "../../src/components/libera/use-horizontal-toolbar-scroll";

test("vertical wheel scrolls toolbar, normalizes mouse units, and releases scrolling at edges", () => {
  const dom = new JSDOM("<div></div>");
  const toolbar = dom.window.document.querySelector("div")!;
  Object.defineProperties(toolbar, { clientWidth: { value: 300 }, scrollWidth: { value: 1000, configurable: true } });
  const cleanup = attachHorizontalToolbarScroll(toolbar);
  function wheel(options: WheelEventInit) {
    const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...options });
    toolbar.dispatchEvent(event);
    return event.defaultPrevented;
  }
  try {
    assert.equal(wheel({ deltaY: 50 }), true);
    assert.equal(toolbar.scrollLeft, 50);
    assert.equal(wheel({ deltaY: 3, deltaMode: 1 }), true);
    assert.equal(toolbar.scrollLeft, 98);
    wheel({ deltaY: 1, deltaMode: 2 });
    assert.equal(toolbar.scrollLeft, 398);
    wheel({ deltaY: 1000 });
    assert.equal(toolbar.scrollLeft, 700);
    assert.equal(wheel({ deltaY: 50 }), false, "Do not trap scrolling at the right edge");
    assert.equal(wheel({ deltaY: -80 }), true);
    assert.equal(toolbar.scrollLeft, 620);
    for (const options of [{ deltaX: 40 }, { deltaX: 4, deltaY: 40 }, { deltaY: 40, ctrlKey: true }, { deltaY: 40, metaKey: true }]) {
      assert.equal(wheel(options), false, "Keep native trackpad scrolling and browser zoom");
      assert.equal(toolbar.scrollLeft, 620);
    }
    wheel({ deltaY: -1000 });
    assert.equal(toolbar.scrollLeft, 0);
    assert.equal(wheel({ deltaY: -50 }), false);
    Object.defineProperty(toolbar, "scrollWidth", { value: 300, configurable: true });
    assert.equal(wheel({ deltaY: 50 }), false, "Fitting toolbars do not consume wheel input");
    Object.defineProperty(toolbar, "scrollWidth", { value: 1000 });
    cleanup();
    assert.equal(wheel({ deltaY: 50 }), false);
    assert.equal(toolbar.scrollLeft, 0, "Listener is removed on unmount");
  } finally {
    cleanup();
    dom.window.close();
  }
});
