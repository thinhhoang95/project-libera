import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ReadingModelUnavailableError, ReferenceImageImport, importReferenceImage, isReferenceImage, mergeResolveResults,
  referenceListItems, referenceListText, type ReferenceImageProgress,
} from "../../src/components/libera/references/reference-image-import";
import type { ResolveRequest, ResolveResponse } from "../../src/components/libera/references/reference-candidates";
import type { ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

// A reference list from a screenshot or photo: local OCR (mocked here; the
// real one is POST /api/document-ocr/convert) → splitBibliography → one
// /api/references/resolve lookup per reference, at most four at a time → the
// Add box's candidate cards.

const OCR_MARKDOWN = [
  "## References",
  "",
  "1. Smith, J. (2020). Sparse attention. *Journal of Tests*, 3, 1\\-10. [https://doi.org/10.1000/sparse](https://doi.org/10.1000/sparse)",
  "2. Lee, A. (2019). *Graphs*. Press.",
  "3. Kim, B., & Doe, C. (2018). Long titles that the model",
  "   wraps onto a second line. **Proceedings**.",
  "4. Park, D. (2021). Dense retrieval. arXiv:2101.00001",
  "5. Ng, E. (2017). Fifth work.",
].join("\n");

const ITEMS = [
  "Smith, J. (2020). Sparse attention. Journal of Tests, 3, 1-10. https://doi.org/10.1000/sparse",
  "Lee, A. (2019). Graphs. Press.",
  "Kim, B., & Doe, C. (2018). Long titles that the model wraps onto a second line. Proceedings.",
  "Park, D. (2021). Dense retrieval. arXiv:2101.00001",
  "Ng, E. (2017). Fifth work.",
];

test("the model's Markdown becomes one reference per item, without headings or markup", () => {
  assert.deepEqual(referenceListItems(OCR_MARKDOWN), ITEMS);
  const bullets = "Bibliography\n\n- Smith, J. (2020). *Sparse* attention.\n- Lee, A. (2019). Graphs,\n  continued.\n\n![figure](picture:1)";
  assert.deepEqual(referenceListItems(bullets), ["Smith, J. (2020). Sparse attention.", "Lee, A. (2019). Graphs, continued."]);
  assert.equal(referenceListText("[Link text](https://x.org) and <b>bold</b> \\_x\\_"), "Link text https://x.org and bold _x_");
  assert.equal(isReferenceImage({ type: "image/webp" }), true);
  assert.equal(isReferenceImage({ type: "", name: "list.JPG" }), true);
  assert.equal(isReferenceImage({ type: "application/pdf", name: "a.pdf" }), false);
});

function candidate(title: string): ReferenceEntryInput {
  return { csl: { type: "article-journal", title } };
}

test("lookups are merged in item order with duplicate indexes shifted, and failures become warnings", () => {
  const merged = mergeResolveResults([
    { item: "A", result: { candidates: [candidate("A1"), candidate("A2")], duplicates: [{ candidateIndex: 1, entryId: "ref_9" }], updates: [], warnings: [] } },
    { item: "B", result: null, error: "Rate limited." },
    { item: "C", result: { candidates: [candidate("C1")], duplicates: [{ candidateIndex: 0, entryId: "ref_8", reason: "doi" }], updates: [], warnings: ["Web search was off."] } },
    { item: "D", result: { candidates: [], duplicates: [], updates: [], warnings: [] } },
  ]);
  assert.deepEqual(merged.candidates.map((value) => value.csl.title), ["A1", "A2", "C1"]);
  assert.deepEqual(merged.duplicates, [{ candidateIndex: 1, entryId: "ref_9" }, { candidateIndex: 2, entryId: "ref_8", reason: "doi" }]);
  assert.deepEqual(merged.warnings, ["Could not look up “B”: Rate limited.", "Web search was off.", "Nothing was found for “D”."]);
});

function mockResolver(delay = 5) {
  const calls: ResolveRequest[] = [];
  let active = 0;
  let peak = 0;
  const resolve = async (request: ResolveRequest): Promise<ResolveResponse> => {
    calls.push(request);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, delay));
    active -= 1;
    const input = "input" in request ? request.input : "";
    if (input.startsWith("Park")) throw new Error("The lookup failed.");
    return {
      candidates: [candidate(input.split(". ")[1] ?? input)],
      duplicates: input.startsWith("Lee") ? [{ candidateIndex: 0, entryId: "ref_lee" }] : [],
      updates: [], warnings: [],
    };
  };
  return { resolve, calls, peak: () => peak };
}

test("importReferenceImage: OCR → split → resolve (at most four at a time) → candidates", async () => {
  const progress: ReferenceImageProgress[] = [];
  const read: Array<{ type: string; maxEdge: number }> = [];
  const resolver = mockResolver();
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const imported = await importReferenceImage(image, {
    notebook: "Notes", webSearch: true,
    ensureModel: async () => true,
    readImage: async (blob, options) => { read.push({ type: blob.type, maxEdge: options.maxEdge }); return { markdown: OCR_MARKDOWN }; },
    resolve: resolver.resolve,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(read, [{ type: "image/png", maxEdge: 2048 }]);
  assert.deepEqual(imported.items, ITEMS);
  assert.deepEqual(resolver.calls.map((call) => "input" in call ? call.input : ""), ITEMS, "one lookup per reference");
  assert.ok(resolver.calls.every((call) => call.notebook === "Notes" && call.webSearch === true));
  assert.ok(resolver.peak() <= 4 && resolver.peak() > 1, `peak concurrency ${resolver.peak()}`);
  assert.deepEqual(imported.result.candidates.map((value) => value.csl.title), ["(2020)", "(2019)", "(2018)", "(2017)"]);
  assert.deepEqual(imported.result.duplicates, [{ candidateIndex: 1, entryId: "ref_lee" }]);
  assert.deepEqual(imported.result.warnings, ["Could not look up “Park, D. (2021). Dense retrieval. arXiv:2101.00001”: The lookup failed."]);
  assert.deepEqual(progress.slice(0, 3), [{ phase: "model" }, { phase: "reading" }, { phase: "resolving", done: 0, total: 5 }]);
  assert.deepEqual(progress.at(-1), { phase: "resolving", done: 5, total: 5 });
});

test("importReferenceImage: a missing model, an unreadable image, no references, cancelling", async () => {
  const image = new Blob(["x"], { type: "image/jpeg" });
  let read = 0;
  await assert.rejects(importReferenceImage(image, {
    notebook: "Notes", ensureModel: async () => false, readImage: async () => { read += 1; return { markdown: "" }; },
  }), ReadingModelUnavailableError);
  assert.equal(read, 0, "nothing is read without the model");
  await assert.rejects(importReferenceImage(new Blob(["%PDF"], { type: "application/pdf" }), { notebook: "Notes", ensureModel: async () => true }), /PNG, JPEG or WebP/);
  await assert.rejects(importReferenceImage(image, { notebook: "Notes", ensureModel: async () => true, readImage: async () => ({ markdown: "## References\n" }) }), /No references were found/);
  const controller = new AbortController();
  await assert.rejects(importReferenceImage(image, {
    notebook: "Notes", signal: controller.signal, ensureModel: async () => true,
    readImage: async () => { controller.abort(); return { markdown: OCR_MARKDOWN }; },
    resolve: async () => assert.fail("no lookups after cancelling"),
  }), (error: Error) => error.name === "AbortError");
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

let dom: JSDOM;
before(() => {
  dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Candidate cards format their reference with the notebook's style.
  globalThis.fetch = (async () => Response.json({ error: "Not found" }, { status: 404 })) as typeof fetch;
});
after(() => dom.window.close());

const LIBRARY: ReferenceLibrary = { version: 1, revision: 1, style: "apa", entries: {} };

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function drop(target: Element, files: File[]) {
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  target.dispatchEvent(event);
}

test("dropping a screenshot shows the found references as candidate cards to confirm", async () => {
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const commits: Array<{ ops: ReferenceLibraryOp[]; label: string }> = [];
  const resolver = mockResolver(1);
  await act(async () => root.render(createElement(ReferenceImageImport, {
    notebook: "Notes", library: LIBRARY, webSearch: false,
    onCommit: async (ops: ReferenceLibraryOp[], label: string) => { commits.push({ ops, label }); },
    onEdit: () => {}, onReveal: () => {},
    importOptions: { ensureModel: async () => true, readImage: async () => ({ markdown: OCR_MARKDOWN }), resolve: resolver.resolve },
  })));
  try {
    const zone = host.querySelector("[data-reference-image-import] [role=button]")!;
    await act(async () => drop(zone, [new dom.window.File(["png"], "list.png", { type: "image/png" }) as unknown as File]));
    for (let waited = 0; waited < 2000 && !host.querySelector("[aria-label='Candidates']"); waited += 20) await settle(20);
    assert.match(host.textContent!, /5 references read from the image\./);
    assert.match(host.textContent!, /4 references found\. Untick the ones you do not want\./);
    assert.match(host.textContent!, /Could not look up “Park/);
    const addSelected = [...host.querySelectorAll("button")].find((button) => /Add selected/.test(button.textContent!))!;
    assert.match(addSelected.textContent!, /Add selected \(3\)/, "the duplicate starts unticked");
    await act(async () => addSelected.click());
    assert.equal(commits.length, 1);
    assert.equal(commits[0].label, "Add 3 references");
    assert.equal(commits[0].ops.filter((op) => op.op === "add").length, 3);
  } finally {
    await act(async () => root.unmount());
  }
});

test("without the reading model the control says how to set it up", async () => {
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  let checks = 0;
  await act(async () => root.render(createElement(ReferenceImageImport, {
    notebook: "Notes", library: LIBRARY, webSearch: false, onCommit: async () => {}, onEdit: () => {}, onReveal: () => {},
    importOptions: { ensureModel: async () => { checks += 1; return checks > 1; }, readImage: async () => assert.fail("not read") },
  })));
  try {
    const zone = host.querySelector("[data-reference-image-import] [role=button]")!;
    await act(async () => drop(zone, [new dom.window.File(["png"], "list.png", { type: "image/png" }) as unknown as File]));
    await settle(20);
    const alert = host.querySelector("[role=alert]")!;
    assert.match(alert.textContent!, /needs the local reading model\. Set it up in Preferences → Search/);
    const setUp = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Set up")!;
    await act(async () => setUp.click());
    await settle(10);
    assert.equal(checks, 2);
    assert.equal(host.querySelector("[role=alert]"), null, "ready: back to the drop zone");
    await act(async () => drop(zone, [new dom.window.File(["%PDF"], "a.pdf", { type: "application/pdf" }) as unknown as File]));
    assert.match(host.querySelector("[role=alert]")!.textContent!, /PNG, JPEG or WebP/);
  } finally {
    await act(async () => root.unmount());
  }
});
