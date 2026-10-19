// The ReconcileView component in jsdom: the comparison renders through
// @codemirror/merge, the pair toggles are exposed as pressed buttons, and
// keeping a text posts it to the reconciliation route.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "MouseEvent", "KeyboardEvent", "Event", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key],
    configurable: true,
  });
}
for (const target of [globalThis, dom.window]) {
  Object.assign(target, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
after(() => dom.window.close());

test("ReconcileView compares the three texts and keeps the merged result", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReconcileView } = await import("../../src/components/libera/collab/reconcile");

  const calls: Array<{ url: string; body: unknown }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ docId: "doc_1", text: "from disk\n" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const resolved: unknown[] = [];
  try {
    await act(async () => {
      root.render(
        createElement(ReconcileView, {
          reconciliation: {
            id: "rec_1",
            docId: "doc_1",
            path: "Research/main.tex",
            base: "base line\n",
            disk: "from disk\n",
            shared: "from shared\n",
            detectedAt: 1,
          },
          onResolved: (result) => resolved.push(result),
        }),
      );
    });
    assert.ok(container.querySelector(".cm-mergeView"), "a merge view is rendered");
    assert.ok(container.textContent?.includes("from shared"), "the default pair shows the shared text");
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    assert.equal(toggles.length, 3);
    assert.deepEqual(toggles.map((button) => button.getAttribute("aria-pressed")), ["false", "false", "true"]);
    await act(async () => toggles[0].click());
    assert.equal(toggles[0].getAttribute("aria-pressed"), "true");
    assert.ok(container.textContent?.includes("base line"), "the base is shown against the disk");

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    assert.equal(textarea.value, "from shared\n", "the merged text starts from the shared document");
    assert.ok(container.querySelector(`label[for="${textarea.id}"]`), "the textarea is labelled");
    const fromDisk = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("file on disk") && button.type === "button" && !button.hasAttribute("aria-pressed"));
    assert.ok(fromDisk);
    await act(async () => fromDisk.click());
    assert.equal(textarea.value, "from disk\n");

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/collab/reconciliations/rec_1");
    assert.deepEqual(calls[0].body, { text: "from disk\n" });
    assert.deepEqual(resolved, [{ docId: "doc_1", text: "from disk\n" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = previousFetch;
  }
});
