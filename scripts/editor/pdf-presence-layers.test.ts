import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { PdfPresenceLayer } from "../../src/components/libera/collab/pdf-presence";
import { PdfPresenceStore } from "../../src/lib/collab/pdf/presence";
import type { PdfAnnotation } from "../../src/lib/types";

/** A remote client's awareness state, set directly on the local replica. */
function remote(awareness: Awareness, clientId: number, pdf: Record<string, unknown>) {
  awareness.getStates().set(clientId, { user: { name: "Ada", color: "#112233" }, pdf });
  awareness.emit("change", [{ added: [clientId], updated: [], removed: [] }, "test"]);
}

test("a collaborator's pointer re-renders only the layer of the page it is on", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const awareness = new Awareness(new Y.Doc());
  const store = new PdfPresenceStore(awareness, () => ({ cancel: () => {} }));
  const renders: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const marks = (page: number): PdfAnnotation[] => [{ id: `mark-${page}`, type: "text", pageNumber: page, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } } as unknown as PdfAnnotation];
  const layer = (page: number) => createElement(Profiler, { key: page, id: String(page), onRender: () => { renders[page]++; } }, createElement(PdfPresenceLayer, { store, pageNumber: page, width: 100, height: 100, zoom: 1, marks: marks(page) }));
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement("div", null, layer(1), layer(2), layer(3))));
    const reset = () => { renders[1] = 0; renders[2] = 0; renders[3] = 0; };

    reset();
    await act(async () => remote(awareness, 7, { page: 3, top: 0, bottom: 1, pointer: { page: 3, x: 0.2, y: 0.3 } }));
    assert.deepEqual(renders, { 1: 0, 2: 0, 3: 1 }, "a pointer on page 3");
    assert.equal(document.querySelectorAll(".pdf-presence-pointer").length, 1);

    reset();
    await act(async () => remote(awareness, 7, { page: 3, top: 0, bottom: 1, pointer: { page: 3, x: 0.4, y: 0.3 } }));
    assert.deepEqual(renders, { 1: 0, 2: 0, 3: 1 }, "the pointer moving on page 3");

    // A selection of a mark on page 2 reaches page 2 only; one of an unknown mark nobody.
    reset();
    await act(async () => remote(awareness, 7, { page: 3, top: 0, bottom: 1, pointer: { page: 3, x: 0.4, y: 0.3 }, selection: ["mark-2"] }));
    assert.deepEqual(renders, { 1: 0, 2: 1, 3: 0 }, "a selection of a page 2 mark");
    assert.equal(document.querySelectorAll(".pdf-presence-layer rect").length, 1);

    // The pointer moving to page 1 updates the layer it leaves and the one it joins.
    reset();
    await act(async () => remote(awareness, 7, { page: 1, top: 0, bottom: 1, pointer: { page: 1, x: 0.4, y: 0.3 }, selection: ["mark-2"] }));
    assert.deepEqual(renders, { 1: 1, 2: 0, 3: 1 }, "the pointer changes page");
  } finally {
    await act(async () => root.unmount());
    store.destroy();
    awareness.destroy();
    dom.window.close();
  }
});
