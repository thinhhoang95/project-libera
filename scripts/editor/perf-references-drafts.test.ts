import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import {
  CITATION_SCAN_DELAY_MS, projectReferenceDrafts, useOpenReferenceDrafts, useReferenceCitations, type OpenReferenceDraft,
} from "../../src/components/libera/references/use-reference-citations";
import type { OpenTab } from "../../src/components/libera/types";

function setupDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
}

const files = new Map<string, OpenTab["file"]>();
function tabOf(name: string, patch: Partial<OpenTab> = {}): OpenTab {
  const path = `Notes/${name}`;
  if (!files.has(path)) files.set(path, { path, name, fileType: name.endsWith(".md") ? "markdown" : "text", notebook: "Notes" } as OpenTab["file"]);
  return { id: path, draft: "", saved: "", status: "clean", file: files.get(path)!, ...patch };
}

test("the reference drafts keep their array and entries until a relevant text changes", () => {
  const a = tabOf("a.md", { draft: "[@x]", saved: "" });
  const clean = tabOf("c.md", { draft: "same", saved: "same" });
  const notes = tabOf("n.txt", { draft: "typed", saved: "" });
  const first = projectReferenceDrafts([], [a, clean, notes]);
  assert.deepEqual(first, [{ path: "Notes/a.md", text: "[@x]" }]);
  assert.equal(projectReferenceDrafts(first, [{ ...a, viewState: { markdown: { line: 3 } } }, clean, notes]), first, "a caret report");
  assert.equal(projectReferenceDrafts(first, [a, clean, { ...notes, draft: "typed more" }]), first, "text of a file that is not cited from");
  const b = tabOf("b.md", { draft: "[@y]", saved: "" });
  const grown = projectReferenceDrafts(first, [a, b]);
  assert.notEqual(grown, first);
  assert.equal(grown[0], first[0], "the unchanged draft keeps its entry");
  const typed = projectReferenceDrafts(grown, [{ ...a, draft: "[@x] [@z]" }, b]);
  assert.notEqual(typed[0], grown[0]);
  assert.equal(typed[1], grown[1]);
});

test("no drafts are collected while the References rail is closed", async () => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let reads = 0;
  const tabs = new Proxy([tabOf("a.md", { draft: "[@x]" })], { get(target, key, receiver) { if (key === "length" || key === Symbol.iterator) reads++; return Reflect.get(target, key, receiver); } });
  const seen: OpenReferenceDraft[][] = [];
  function Probe({ enabled }: { enabled: boolean }) {
    seen.push(useOpenReferenceDrafts(tabs, enabled));
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe, { enabled: false })));
    await act(async () => root.render(createElement(Probe, { enabled: false })));
    assert.equal(reads, 0, "the tabs were not read");
    assert.deepEqual(seen.at(-1), []);
    assert.equal(seen[0], seen.at(-1), "the same empty list each time");
    await act(async () => root.render(createElement(Probe, { enabled: true })));
    assert.ok(reads > 0);
    assert.equal(seen.at(-1)?.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("an identical draft list does not restart the scan debounce or rebuild the merged index", async () => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ byFile: {}, byKey: {} });
  const win = dom.window as unknown as { setTimeout: (fn: () => void, ms?: number) => number };
  const realSetTimeout = win.setTimeout.bind(win);
  let debounces = 0;
  win.setTimeout = (fn, ms = 0) => { if (ms === CITATION_SCAN_DELAY_MS) debounces++; return realSetTimeout(fn, ms); };
  const merged: Map<string, Set<string>>[] = [];
  function Probe({ drafts }: { drafts: OpenReferenceDraft[] }) {
    merged.push(useReferenceCitations("Notes", drafts).byKey);
    return null;
  }
  const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  try {
    await act(async () => root.render(createElement(Probe, { drafts: [{ path: "Notes/a.md", text: "[@x]" }] })));
    await wait(CITATION_SCAN_DELAY_MS + 80);
    assert.ok(merged.at(-1)?.has("x"), "the first scan lands");
    const timers = debounces;
    const index = merged.at(-1);
    for (let i = 0; i < 3; i++) await act(async () => root.render(createElement(Probe, { drafts: [{ path: "Notes/a.md", text: "[@x]" }] })));
    await wait(CITATION_SCAN_DELAY_MS + 80);
    assert.equal(debounces, timers, "no debounce restarted for an identical list");
    assert.equal(merged.at(-1), index, "the merged index was not rebuilt");
    await act(async () => root.render(createElement(Probe, { drafts: [{ path: "Notes/a.md", text: "[@x] [@y]" }] })));
    await wait(CITATION_SCAN_DELAY_MS + 80);
    assert.ok(debounces > timers, "a changed text still debounces");
    assert.ok(merged.at(-1)?.has("y"), "and is scanned");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    dom.window.close();
  }
});
