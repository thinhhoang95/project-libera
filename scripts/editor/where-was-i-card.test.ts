import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WhereWasICard } from "../../src/components/libera/where-was-i-card";
import type { LiberaFileNode, LiberaNotebookNode } from "../../src/lib/types";
import type { RecapView } from "../../src/lib/where-was-i";

test("returning from Preferences updates the mounted card and ignores stale responses", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of ["window", "document", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const originalFetch = globalThis.fetch;
  const date = new Date().toISOString();
  const file: LiberaFileNode = { kind: "file", name: "a.md", path: "Preferences/a.md", notebook: "Preferences", fileType: "markdown", size: 1, createdAt: date, updatedAt: date };
  const notebook = { kind: "notebook", name: "Preferences", path: "Preferences", color: "#123456", children: [file] } as unknown as LiberaNotebookNode;
  const enabled: RecapView = {
    session: { id: "card-session", startedAt: date, endedAt: date, files: [{ path: "a.md", name: "a.md", fileType: "markdown", lastAt: date, edited: false }] },
    summary: null, summariesEnabled: false, shared: false,
  };
  let value: RecapView | { disabled: true } = enabled;
  let nextResponse: Promise<Response> | null = null;
  let summaryCalls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      summaryCalls++;
      return Response.json({ summary: { sessionId: "card-session", bullets: ["You reviewed a.md."], model: "test", generatedAt: date } });
    }
    const response = nextResponse;
    nextResponse = null;
    return response ?? Response.json(value);
  }) as typeof fetch;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(WhereWasICard, { notebook, files: [file], onOpenFile: () => {} })));
    assert.match(document.body.textContent ?? "", /Where you left off/);
    assert.equal(summaryCalls, 0);

    let release!: (response: Response) => void;
    nextResponse = new Promise((resolve) => { release = resolve; });
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    value = { disabled: true };
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(document.querySelector("section"), null);
    await act(async () => { release(Response.json(enabled)); });
    assert.equal(document.querySelector("section"), null, "an older request must not undo an opt-out");

    value = { ...enabled, summariesEnabled: true };
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.match(document.body.textContent ?? "", /You reviewed a.md/);
    assert.equal(summaryCalls, 1);
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(summaryCalls, 1, "focus refresh must reuse the session's summary request");

    await act(async () => root.unmount());
    window.dispatchEvent(new dom.window.Event("focus"));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
