import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { emptyTree } from "../../src/components/libera/api-client";
import type { ReferencesPanelProps } from "../../src/components/libera/references/references-panel";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import {
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_REVEAL_EVENT,
  type CslItem,
  type ReferenceEntry,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
} from "../../src/lib/references/types";
import type { LiberaFileNode, LiberaTree } from "../../src/lib/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement", "Element", "Node", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
after(() => dom.window.close());

// React DOM and the components load after the DOM globals exist, so React uses real input events.
async function loadModules() {
  const [client, panel, library, undo, leftPanel] = await Promise.all([
    import("react-dom/client"),
    import("../../src/components/libera/references/references-panel"),
    import("../../src/components/libera/references/use-reference-library"),
    import("../../src/components/libera/references/use-reference-undo"),
    import("../../src/components/libera/left-panel"),
  ]);
  return { ...client, ...panel, ...library, ...undo, ...leftPanel };
}
let m: Awaited<ReturnType<typeof loadModules>>;
before(async () => {
  m = await loadModules();
});

const NOW = "2026-10-01T00:00:00.000Z";

function makeEntry(id: string, key: string, csl: CslItem, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl, identifiers: {}, provenance: {}, status: "confirmed", attachments: [],
    createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

function libraryOf(entries: ReferenceEntry[], extra: Partial<ReferenceLibrary> = {}): ReferenceLibrary {
  return { ...emptyReferenceLibrary(), revision: 1, entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])), ...extra };
}

type Request = { url: string; method: string; body: unknown };

/** A fake reference API: the library routes use the real pure ops; import, export and citations are canned. */
function fakeServer(library: ReferenceLibrary) {
  const server = {
    library,
    requests: [] as Request[],
    citations: { byFile: {} as Record<string, string[]>, byKey: {} as Record<string, string[]> },
    importResult: null as null | ((body: { text?: string; path?: string }) => unknown),
    /** POST /api/references/resolve; without one the route is missing (404). */
    resolveResult: null as null | ((body: { input?: string; path?: string; webSearch?: boolean }) => unknown),
    patches(): ReferenceLibraryOp[][] {
      return server.requests.filter((request) => request.method === "PATCH").map((request) => (request.body as { ops: ReferenceLibraryOp[] }).ops);
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    server.requests.push({ url, method, body });
    if (url.startsWith("/api/references/citations")) return Response.json(server.citations);
    if (url === "/api/references/resolve" && server.resolveResult) {
      return Response.json(server.resolveResult(body as { input?: string; path?: string }));
    }
    if (url === "/api/references/import") {
      const result = server.importResult?.(body as { text?: string; path?: string });
      return Response.json(result);
    }
    if (url === "/api/references/export") {
      return new Response("@article{x}", { headers: { "Content-Disposition": "attachment; filename=\"Notes.bib\"" } });
    }
    if (url.startsWith("/api/references?")) return Response.json({ library: server.library });
    if (url === "/api/references" && method === "PATCH") {
      const { revision, ops } = body as { revision: number; ops: ReferenceLibraryOp[] };
      if (revision !== server.library.revision) return Response.json({ error: "Conflict", library: server.library }, { status: 409 });
      try {
        const result = applyLibraryOps(server.library, ops, new Date().toISOString());
        if (result.changed) server.library = { ...result.library, revision: server.library.revision + 1 };
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      return Response.json({ library: server.library });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
  return server;
}

function treeWith(paths: string[]): LiberaTree {
  const tree = emptyTree();
  tree.notebooks = [{
    kind: "notebook", name: "Notes", path: "Notes", color: "#008888", emoji: "📓", groupId: null, createdAt: NOW, updatedAt: NOW,
    children: paths.map((path) => ({
      kind: "file", name: path.split("/").at(-1)!, path, notebook: "Notes",
      fileType: path.endsWith(".pdf") ? "pdf" : path.endsWith(".md") ? "markdown" : "text", createdAt: NOW, updatedAt: NOW, size: 1,
    } satisfies LiberaFileNode)),
  }];
  return tree;
}

async function settle(ms = 0) {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  }
}

/** Wait (up to a few seconds) for something asynchronous, such as the first citeproc load. */
async function waitFor(check: () => boolean, what: string) {
  for (let index = 0; index < 200 && !check(); index += 1) await settle(20);
  assert.ok(check(), what);
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  document.body.innerHTML = "";
  m.resetReferenceLibraryCache();
  m.resetReferenceUndo();
  m.resetReferencesPanelState();
});

async function renderPanel(props: Partial<ReferencesPanelProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  const calls = { cited: [] as string[], opened: [] as string[], uploaded: [] as File[][] };
  let current: ReferencesPanelProps = {
    notebook: "Notes",
    tree: treeWith([]),
    activeMarkdownDraft: null,
    openDrafts: [],
    canCite: true,
    onCite: (key) => calls.cited.push(key),
    onOpenPath: (path) => calls.opened.push(path),
    ...props,
  };
  await act(async () => root.render(createElement(m.ReferencesPanel, current)));
  await settle();
  return {
    host,
    calls,
    async update(patch: Partial<ReferencesPanelProps>) {
      current = { ...current, ...patch };
      await act(async () => root.render(createElement(m.ReferencesPanel, current)));
      await settle();
    },
  };
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
    : element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  if (element instanceof dom.window.HTMLSelectElement) {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    return;
  }
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

async function type(element: Element | null, value: string) {
  assert.ok(element, "field is mounted");
  await act(async () => setValue(element as HTMLInputElement, value));
  await settle();
}

async function click(element: Element | null | undefined) {
  assert.ok(element, "element is mounted");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function key(element: Element, keyName: string, init: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, ...init })); });
  await settle();
}

function byLabel(host: ParentNode, label: string) {
  return host.querySelector(`[aria-label="${label}"]`);
}

function buttonByText(host: ParentNode, text: string | RegExp) {
  return [...host.querySelectorAll("button")].find((button) => typeof text === "string" ? button.textContent?.trim() === text : text.test(button.textContent?.trim() ?? ""));
}

function rowKeys(host: ParentNode) {
  return [...host.querySelectorAll("[role=option][data-entry-id]")].map((row) => row.querySelector(".font-mono")?.textContent);
}

async function drop(target: Element, data: { types: string[]; getData?: (type: string) => string; files?: File[] }) {
  await act(async () => {
    const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: data.types, getData: data.getData ?? (() => ""), files: data.files ?? [], dropEffect: "none" },
    });
    target.dispatchEvent(event);
  });
  await settle();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleLibrary() {
  return libraryOf([
    makeEntry("ref_godel", "godel1931", {
      type: "article-journal", title: "On formally undecidable propositions", author: [{ family: "Gödel", given: "Kurt" }],
      issued: { "date-parts": [[1931]] }, "container-title": "Monatshefte für Mathematik",
    }, { attachments: [{ kind: "pdf", path: "Notes/papers/godel.pdf" }], tags: ["logic"], createdAt: "2026-01-01T00:00:00.000Z" }),
    makeEntry("ref_smith", "smith2020sparse", {
      type: "article-journal", title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }, { family: "Lee", given: "Kim" }],
      issued: { "date-parts": [[2020]] }, "container-title": "Journal of Sparse Things", DOI: "10.1000/sparse",
    }, { identifiers: { doi: "10.1000/sparse" }, status: "needs-review", notes: "An important baseline", aliases: ["smith2020"], createdAt: "2026-02-01T00:00:00.000Z" }),
    makeEntry("ref_preprint", "smith2020sparsea", {
      type: "article", title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }],
      issued: { "date-parts": [[2020]] }, DOI: "10.1000/sparse",
    }, { identifiers: { doi: "10.1000/sparse" }, status: "unresolved", createdAt: "2026-03-01T00:00:00.000Z" }),
    makeEntry("ref_anon", "uncited2019", { type: "report", title: "An uncited report", issued: { "date-parts": [[2019]] } }, { createdAt: "2026-04-01T00:00:00.000Z" }),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("the rail registers References with ⌘/Ctrl+7 and shows the panel for the selected notebook", async () => {
  fakeServer(libraryOf([]));
  const { LeftPanel } = m;
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  const changes: string[] = [];
  const props = {
    workspaceManager: { activeWorkspace: null },
    fullTree: emptyTree(),
    tree: emptyTree(),
    selectedNotebookName: "",
    activePanel: "references",
    onPanelChange: (panel: string) => changes.push(panel),
    collapsed: false,
    textareaRef: { current: null },
    onLogout: async () => undefined,
    onSetDraft: () => undefined,
    onToggleCollapsed: () => undefined,
    onGeneratedFilesSaved: () => undefined,
    onOpenFile: () => undefined,
  } as unknown as Parameters<typeof LeftPanel>[0];
  await act(async () => root.render(createElement(LeftPanel, props)));
  await settle();
  const tab = host.querySelector<HTMLButtonElement>("#left-panel-tab-references");
  assert.ok(tab, "the rail has a References tab");
  assert.equal(tab.getAttribute("aria-label"), "References tab");
  assert.equal(tab.getAttribute("aria-selected"), "true");
  assert.match(host.textContent ?? "", /Select a notebook to see its references/);
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "7", code: "Digit7", ctrlKey: true, bubbles: true })); });
  assert.deepEqual(changes, ["references"]);
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "7", code: "Digit7", metaKey: true, bubbles: true })); });
  assert.deepEqual(changes, ["references", "references"]);
  await click(tab);
  assert.equal(changes.at(-1), "references");
});

test("the list shows rows, searches accent-insensitively with every word, marks matches and filters", async () => {
  const server = fakeServer(sampleLibrary());
  server.citations = { byFile: { "Notes/paper.md": ["godel1931"] }, byKey: { godel1931: ["Notes/paper.md"] } };
  const draft = "See [@smith2020, p. 3] and [@missingkey].";
  const { host } = await renderPanel({ activeMarkdownDraft: draft, openDrafts: [{ path: "Notes/draft.md", text: draft }] });
  await settle(320);

  // Sorted by author: Gödel, Smith (2 authors), Smith, then no author.
  assert.deepEqual(rowKeys(host), ["godel1931", "smith2020sparse", "smith2020sparsea", "uncited2019"]);
  const godel = host.querySelector('[data-entry-id="ref_godel"]')!;
  assert.match(godel.textContent ?? "", /Gödel \(1931\)/);
  assert.match(godel.textContent ?? "", /Monatshefte für Mathematik/);
  assert.ok(godel.querySelector('[aria-label="PDF attached"]'));
  assert.equal(godel.querySelector(".libera-backlink-count")?.textContent, "1", "cited by one saved document");
  const smith = host.querySelector('[data-entry-id="ref_smith"]')!;
  assert.match(smith.textContent ?? "", /Smith & Lee \(2020\)/);
  assert.match(smith.textContent ?? "", /Needs review/);
  assert.match(smith.textContent ?? "", /Duplicate/);
  assert.equal(smith.getAttribute("data-cited"), "true", "an alias cited in the open draft highlights the entry");
  assert.ok(smith.querySelector('[aria-label="Cited in the open document"]'));
  assert.equal(godel.getAttribute("data-cited"), null);
  assert.match(host.querySelector('[data-entry-id="ref_preprint"]')!.textContent ?? "", /Unresolved/);

  const search = byLabel(host, "Search references")!;
  await type(search, "godel");
  assert.deepEqual(rowKeys(host), ["godel1931"]);
  assert.equal(host.querySelector("mark")?.textContent, "Gödel");
  await type(search, "smith sparse 2020");
  assert.deepEqual(rowKeys(host), ["smith2020sparse", "smith2020sparsea"]);
  await type(search, "smith 1931");
  assert.deepEqual(rowKeys(host), [], "every word must match");
  await type(search, "IMPORTANT");
  assert.deepEqual(rowKeys(host), ["smith2020sparse"], "notes are searched");
  await type(search, "logic");
  assert.deepEqual(rowKeys(host), ["godel1931"], "tags are searched");
  await type(search, "");

  const filter = byLabel(host, "Filter references") as HTMLSelectElement;
  const expectations: Record<string, string[]> = {
    cited: ["smith2020sparse"],
    review: ["smith2020sparse", "smith2020sparsea"],
    uncited: ["smith2020sparsea", "uncited2019"],
    "missing-pdf": ["smith2020sparse", "smith2020sparsea", "uncited2019"],
    all: ["godel1931", "smith2020sparse", "smith2020sparsea", "uncited2019"],
  };
  for (const [value, keys] of Object.entries(expectations)) {
    await type(filter, value);
    assert.deepEqual(rowKeys(host), keys, `filter ${value}`);
  }
  await type(filter, "cited");
  const missing = host.querySelector('[data-missing-key="missingkey"]');
  assert.ok(missing, "unresolved cited keys are listed first");
  assert.equal(host.querySelector("[role=option]"), missing);
  await click(buttonByText(missing!, /Add to library/));
  assert.equal((byLabel(host, "Reference to add") as HTMLTextAreaElement).value, "missingkey");

  await type(filter, "duplicates");
  const group = host.querySelector("[data-duplicate-kind]");
  assert.equal(group?.getAttribute("data-duplicate-kind"), "doi");
  assert.match(group?.textContent ?? "", /Same DOI/);

  await type(byLabel(host, "Sort references")!, "added");
  await type(filter, "all");
  assert.deepEqual(rowKeys(host), ["uncited2019", "smith2020sparsea", "smith2020sparse", "godel1931"]);
});

test("search, filter and sort persist per notebook for the session", async () => {
  fakeServer(sampleLibrary());
  const first = await renderPanel();
  await type(byLabel(first.host, "Search references"), "godel");
  await type(byLabel(first.host, "Filter references"), "missing-pdf");
  await first.update({ notebook: "" });
  await first.update({ notebook: "Notes" });
  assert.equal((byLabel(first.host, "Search references") as HTMLInputElement).value, "godel");
  assert.equal((byLabel(first.host, "Filter references") as HTMLSelectElement).value, "missing-pdf");
});

test("keyboard moves the selection, Enter opens the card and ⌘/Ctrl+Enter cites at the cursor", async () => {
  fakeServer(sampleLibrary());
  const { host, calls } = await renderPanel();
  const list = byLabel(host, "References")!;
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  assert.equal(host.querySelector('[aria-selected="true"][data-entry-id]')?.getAttribute("data-entry-id"), "ref_smith");
  await key(list, "Enter", { ctrlKey: true });
  assert.deepEqual(calls.cited, ["smith2020sparse"]);
  await key(list, "ArrowUp");
  await key(list, "Enter");
  assert.ok(host.querySelector('[aria-label="Reference godel1931"]'), "Enter opens the card");

  await click(byLabel(host, "Back to references"));
  await click(byLabel(host, "Cite smith2020sparsea at cursor"));
  assert.deepEqual(calls.cited, ["smith2020sparse", "smith2020sparsea"]);
});

test("Cite at cursor is disabled with a tooltip without an active Markdown editor", async () => {
  fakeServer(sampleLibrary());
  const { host, calls } = await renderPanel({ canCite: false });
  const cite = byLabel(host, "Cite godel1931 at cursor") as HTMLButtonElement;
  assert.equal(cite.disabled, true);
  assert.match(cite.title, /Open a Markdown document/);
  await key(byLabel(host, "References")!, "ArrowDown");
  await key(byLabel(host, "References")!, "Enter", { metaKey: true });
  assert.deepEqual(calls.cited, []);
});

test("rows open PDFs and citing documents from the actions menu, and copy formatted references", async () => {
  const server = fakeServer(sampleLibrary());
  server.citations = { byFile: { "Notes/paper.md": ["godel1931"] }, byKey: { godel1931: ["Notes/paper.md"] } };
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true });
  const { host, calls } = await renderPanel();
  await click(byLabel(host, "Open PDF of godel1931"));
  assert.deepEqual(calls.opened, ["Notes/papers/godel.pdf"]);
  await click(byLabel(host, "Actions for godel1931"));
  // The row's actions menu is portaled to document.body, outside the panel.
  const menu = host.ownerDocument.querySelector('[role=menu][aria-label="Actions for godel1931"]')!;
  await click(buttonByText(menu, /Citing documents \(1\)/));
  await click(buttonByText(menu, "paper.md"));
  assert.deepEqual(calls.opened, ["Notes/papers/godel.pdf", "Notes/paper.md"]);
  await click(byLabel(host, "Actions for godel1931"));
  await click(buttonByText(host.ownerDocument.querySelector('[role=menu][aria-label="Actions for godel1931"]')!, "Copy formatted reference"));
  // Formatted with the notebook's style (APA) through citeproc; plain text where only writeText exists.
  await waitFor(() => copied.length === 1, "the formatted reference is copied");
  assert.deepEqual(copied, ["Gödel, K. (1931). On formally undecidable propositions. Monatshefte Für Mathematik."]);
  await click(byLabel(host, "Actions for godel1931"));
  await click(buttonByText(host.ownerDocument.querySelector('[role=menu][aria-label="Actions for godel1931"]')!, "Copy key"));
  assert.equal(copied.at(-1), "godel1931");
});

test("the card shows provenance chips, applies a conflict choice, edits inline with user provenance and confirms", async () => {
  const crossref = { source: "crossref" as const, confidence: 0.95, retrievedAt: NOW };
  const web = { source: "llm-web" as const, confidence: 0.5, url: "https://example.org/source", retrievedAt: NOW };
  const alternative = { value: "Nature", provenance: { source: "crossref" as const, confidence: 0.9, retrievedAt: NOW } };
  const server = fakeServer(libraryOf([makeEntry("ref_x", "doe2021x", {
    type: "article-journal", title: "A title", author: [{ family: "Doe", given: "Jo" }], issued: { "date-parts": [[2021]] }, "container-title": "Natur",
  }, {
    status: "needs-review",
    provenance: { title: crossref, "container-title": web },
    conflicts: { "container-title": [alternative] },
  })]));
  const { host } = await renderPanel();
  await click(host.querySelector('[data-entry-id="ref_x"]'));
  const card = host.querySelector('[aria-label="Reference doe2021x"]')!;
  assert.ok(card);
  const chips = [...card.querySelectorAll(".libera-reference-chip")];
  const titleChip = card.querySelector('[data-field="title"] .libera-reference-chip')!;
  assert.equal(titleChip.textContent, "Crossref");
  assert.match(titleChip.getAttribute("title") ?? "", /confidence 95%/);
  const webChip = card.querySelector('[data-field="container-title"] dt .libera-reference-chip') as HTMLAnchorElement;
  assert.equal(webChip.textContent, "LLM + web");
  assert.equal(webChip.getAttribute("href"), "https://example.org/source");
  assert.ok(chips.length >= 3);

  await click(byLabel(card, "Use Nature from Crossref"));
  assert.deepEqual(server.patches().at(-1), [{
    op: "update", id: "ref_x",
    csl: { "container-title": "Nature" },
    provenance: { "container-title": alternative.provenance },
    conflicts: { "container-title": null },
  }]);

  const title = byLabel(host.querySelector('[aria-label="Reference doe2021x"]')!, "Title") as HTMLInputElement;
  await act(async () => title.focus());
  await type(title, "A better title");
  await act(async () => title.blur());
  await settle();
  const edit = server.patches().at(-1)![0] as Extract<ReferenceLibraryOp, { op: "update" }>;
  assert.deepEqual(edit.csl, { title: "A better title" });
  assert.equal(edit.provenance?.title?.source, "user");
  assert.equal(edit.provenance?.title?.confidence, 1);

  await click(buttonByText(host, /Confirm/));
  assert.deepEqual(server.patches().at(-1), [{ op: "update", id: "ref_x", status: "confirmed" }]);
  assert.equal(server.library.entries.ref_x.status, "confirmed");
  assert.equal(server.library.entries.ref_x.csl.title, "A better title", "Confirm clears nothing else");
  // Confirmed and confident: fields are no longer inputs.
  assert.equal(byLabel(host.querySelector('[aria-label="Reference doe2021x"]')!, "Title"), null);
});

test("renaming a key sends rename-key and shows the old key as an alias", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  await click(host.querySelector('[data-entry-id="ref_godel"]'));
  await click(buttonByText(host, "Rename key"));
  const input = byLabel(host, "New citation key") as HTMLInputElement;
  await type(input, "smith2020");
  assert.match(host.textContent ?? "", /already used by smith2020sparse/);
  await type(input, "kurt1931");
  assert.match(host.textContent ?? "", /godel1931 stays as an alias/);
  await click(buttonByText(host, "Rename"));
  assert.deepEqual(server.patches().at(-1), [{ op: "rename-key", id: "ref_godel", key: "kurt1931" }]);
  assert.match(byLabel(host, "Aliases")?.textContent ?? "", /godel1931/);
});

test("notes autosave debounced and tags are edited as chips", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  await click(host.querySelector('[data-entry-id="ref_godel"]'));
  await type(byLabel(host, "Notes"), "First thoughts");
  await type(byLabel(host, "Notes"), "First thoughts, revised");
  assert.equal(server.patches().length, 0, "nothing is saved while typing");
  await settle(300);
  assert.deepEqual(server.patches(), [[{ op: "update", id: "ref_godel", notes: "First thoughts, revised" }]]);
  const tagInput = byLabel(host, "Add tag")!;
  await type(tagInput, "incompleteness");
  await key(tagInput, "Enter");
  assert.deepEqual(server.patches().at(-1), [{ op: "update", id: "ref_godel", tags: ["logic", "incompleteness"] }]);
  await click(byLabel(host, "Remove tag logic"));
  assert.deepEqual(server.patches().at(-1), [{ op: "update", id: "ref_godel", tags: ["incompleteness"] }]);
});

test("the Add box classifies input, looks identifiers up and adds them through a confirmation step", async () => {
  const server = fakeServer(sampleLibrary());
  const crossref = { source: "crossref" as const, confidence: 0.95, retrievedAt: NOW };
  server.resolveResult = (body) => {
    const doi = String(body.input).replace(/^https:\/\/doi\.org\//, "").toLowerCase();
    const csl: CslItem = { type: "article-journal", title: `Looked up ${doi}`, DOI: doi };
    return {
      candidates: [{ csl, identifiers: { doi }, provenance: { title: crossref, DOI: crossref }, status: "needs-review" }],
      duplicates: doi === "10.1000/sparse" ? [{ candidateIndex: 0, entryId: "ref_smith", reason: "doi", score: 1 }] : [],
      updates: [],
      warnings: [],
    };
  };
  const { host } = await renderPanel();
  await click(byLabel(host, "Add references"));
  const input = byLabel(host, "Reference to add")!;
  await type(input, "https://doi.org/10.1000/SPARSE");
  assert.match(host.textContent ?? "", /Detected: DOI 10\.1000\/sparse/);
  await click(buttonByText(host, /Look up/));
  assert.deepEqual(server.requests.find((request) => request.url === "/api/references/resolve")?.body, { notebook: "Notes", input: "https://doi.org/10.1000/SPARSE", webSearch: false });
  assert.match(host.textContent ?? "", /Already in your library as smith2020sparse/);
  assert.equal(server.patches().length, 0, "nothing is added before confirmation");
  await click(byLabel(host, "Back to the input"));

  const cases: Array<[string, string]> = [
    ["10.5555/new", "DOI"],
    ["arXiv:2101.00001v2", "arXiv ID"],
    ["ISBN 978-0-262-03384-8", "ISBN"],
    ["PMID: 12345", "PubMed ID"],
    ["https://example.org/post", "Web address"],
  ];
  for (const [text, label] of cases) {
    if (!byLabel(host, "Reference to add")) await click(byLabel(host, "Add references"));
    await type(byLabel(host, "Reference to add"), text);
    assert.match(host.textContent ?? "", new RegExp(`Detected: ${label}`));
    await click(buttonByText(host, /Look up/));
    assert.equal((server.requests.filter((request) => request.url === "/api/references/resolve").at(-1)?.body as { input: string }).input, text);
    await click(buttonByText(host, /^Add$/));
    const [op] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
    assert.equal(op.op, "add");
    assert.equal(op.entry.csl.title, `Looked up ${text.toLowerCase()}`, text);
    assert.equal(op.entry.status, "needs-review", "Add keeps the status the lookup returned");
  }
  // The last added entry is revealed in its card.
  assert.ok(host.querySelector('[aria-label^="Reference "]'));
});

test("the Add box imports BibTeX and reports added, renamed and duplicate entries with a Merge offer", async () => {
  const server = fakeServer(sampleLibrary());
  server.importResult = (body) => {
    assert.equal((body as { format: string }).format, "bibtex");
    const result = applyLibraryOps(server.library, [
      { op: "add", entry: { key: "godel1931a", csl: { type: "article-journal", title: "Gödel's theorem revisited", issued: { "date-parts": [[1999]] } }, status: "confirmed" } },
      { op: "add", entry: { key: "anon2019", csl: { type: "report", title: "An uncited report", issued: { "date-parts": [[2019]] } }, status: "needs-review" } },
    ], NOW).library;
    server.library = { ...result, revision: server.library.revision + 1 };
    const added = Object.keys(server.library.entries).filter((id) => !id.startsWith("ref_godel") && !["ref_smith", "ref_preprint", "ref_anon"].includes(id));
    const fuzzy = added.find((id) => server.library.entries[id].key === "anon2019")!;
    return { library: server.library, added, errors: [{ line: 9, message: "Unknown entry type @foo" }], duplicates: [
      { entryId: fuzzy, existingId: "ref_anon", reason: "fuzzy" },
      { entryId: "skipped", existingId: "ref_smith", reason: "doi" },
    ] };
  };
  const { host } = await renderPanel();
  await click(byLabel(host, "Add references"));
  const bibtex = "@article{godel1931,\n  title = {Gödel's theorem revisited},\n  year = {1999}\n}\n@techreport{anon2019,\n title={An uncited report}, year={2019}}";
  await type(byLabel(host, "Reference to add"), bibtex);
  assert.match(host.textContent ?? "", /Detected: BibTeX/);
  await click(buttonByText(host, "Import"));
  const request = server.requests.find((item) => item.url === "/api/references/import")!;
  assert.deepEqual(request.body, { notebook: "Notes", format: "bibtex", text: bibtex });
  const result = byLabel(host, "Import result")!;
  assert.match(result.textContent ?? "", /2 added, 1 already in the library/);
  assert.match(result.textContent ?? "", /godel1931 → godel1931a/);
  assert.match(result.textContent ?? "", /anon2019 looks like uncited2019/);
  assert.match(result.textContent ?? "", /Line 9: Unknown entry type @foo/);
  await click(buttonByText(result, /Merge/));
  const dialog = document.querySelector('[role=dialog]')!;
  assert.match(dialog.textContent ?? "", /Merge 2 references/);
  assert.match(byLabel(dialog, "Aliases after merge")?.textContent ?? "", /anon2019/);
  await click(buttonByText(dialog, /Merge into uncited2019/));
  const merge = server.patches().at(-1)![0] as Extract<ReferenceLibraryOp, { op: "merge" }>;
  assert.equal(merge.keepId, "ref_anon");
  assert.equal(merge.mergeIds.length, 1);
});

test("a pasted bibliography is looked up and added only after confirmation; free text can be edited before adding", async () => {
  const server = fakeServer(sampleLibrary());
  const llm = { source: "llm" as const, confidence: 0.5, retrievedAt: NOW };
  server.resolveResult = (body) => {
    const items = String(body.input).split("\n").map((line) => line.replace(/^\d+\.\s*/, ""));
    return {
      candidates: items.map((item) => ({ csl: { type: "article-journal", title: item.split(". ")[2] ?? item, note: item }, provenance: { title: llm }, status: "unresolved" })),
      duplicates: [], updates: [], warnings: [],
    };
  };
  const { host } = await renderPanel();
  await click(byLabel(host, "Add references"));
  const bibliography = "1. Smith J. 2020. A study of sparse things. Journal of Things.\n2. Lee K. 2019. Another careful study. Journal of Stuff.\n3. Park S. 2018. Yet another study. Annals.";
  await type(byLabel(host, "Reference to add"), bibliography);
  assert.match(host.textContent ?? "", /Detected: Bibliography/);
  await click(buttonByText(host, "Look up all"));
  assert.equal((server.requests.find((request) => request.url === "/api/references/resolve")?.body as { input: string }).input, bibliography);
  assert.equal(host.querySelectorAll('[aria-label^="Include candidate"]').length, 3);
  assert.equal(server.patches().length, 0);
  await act(async () => (byLabel(host, "Include candidate 2") as HTMLInputElement).click());
  await settle();
  await click(buttonByText(host, "Add selected (2)"));
  const ops = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
  assert.deepEqual(ops.map((op) => op.entry.csl.note), [
    "Smith J. 2020. A study of sparse things. Journal of Things.",
    "Park S. 2018. Yet another study. Annals.",
  ]);
  assert.ok(ops.every((op) => op.entry.status === "unresolved"));

  await click(byLabel(host, "Add references"));
  const reference = "Smith, J. (2020) Sparse things in practice, Journal of Things 4.";
  await type(byLabel(host, "Reference to add"), reference);
  assert.match(host.textContent ?? "", /Detected: Reference text/);
  await click(buttonByText(host, /Look up/));
  await click(buttonByText(host, /Edit before adding/));
  const form = document.querySelector('form[aria-label="New reference"]')!;
  assert.equal((form.querySelector("#reference-field-note") as HTMLTextAreaElement).value, reference);
  await type(form.querySelector("#reference-field-title"), "Sparse things in practice");
  await click(buttonByText(document.querySelector("[role=dialog]")!, "Add reference"));
  const [add] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
  assert.equal(add.entry.csl.title, "Sparse things in practice");
  assert.equal(add.entry.provenance?.title?.source, "user", "an edited field is the user's");
});

test("dropped notebook files that cannot be looked up become unresolved entries; attached ones are revealed; .bib files import", async () => {
  const server = fakeServer(sampleLibrary());
  const uploads: File[][] = [];
  const { host } = await renderPanel({
    onUploadFiles: async (_notebook, files) => {
      uploads.push(files);
      return files.map((file) => ({ kind: "file", name: file.name, path: `Notes/${file.name}`, notebook: "Notes", fileType: "pdf", createdAt: NOW, updatedAt: NOW, size: 1 } satisfies LiberaFileNode));
    },
  });
  const panel = host.querySelector(".libera-references-panel")!;
  const tree = (path: string) => ({ types: ["application/x-libera-file-path"], getData: (type: string) => type === "application/x-libera-file-path" ? path : "" });

  await drop(panel, tree("Notes/papers/Attention Is All You Need.pdf"));
  const [pdf] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
  assert.deepEqual(pdf.entry, {
    csl: { type: "document", title: "Attention Is All You Need" },
    status: "unresolved",
    attachments: [{ kind: "pdf", path: "Notes/papers/Attention Is All You Need.pdf" }],
  });
  assert.match(host.querySelector('[aria-label^="Reference "]')?.getAttribute("aria-label") ?? "", /Reference /, "the new entry's card opens");

  await drop(panel, tree("Notes/notes/reading.md"));
  const [markdown] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
  assert.equal(markdown.entry.csl.type, "manuscript");
  assert.deepEqual(markdown.entry.attachments, [{ kind: "markdown", path: "Notes/notes/reading.md" }]);

  const patchCount = server.patches().length;
  await click(byLabel(host, "Back to references"));
  await drop(panel, tree("Notes/papers/godel.pdf"));
  assert.equal(server.patches().length, patchCount, "an attached file is not added again");
  assert.ok(host.querySelector('[aria-label="Reference godel1931"]'), "the entry it belongs to is revealed");

  await drop(panel, tree("Other/paper.pdf"));
  assert.match(host.querySelector("[role=alert]")?.textContent ?? "", /Only files in Notes/);

  server.importResult = (body) => {
    assert.equal(body.path, "Notes/refs.bib");
    return { library: server.library, added: [], errors: [], duplicates: [] };
  };
  await drop(panel, tree("Notes/refs.bib"));
  assert.deepEqual(server.requests.find((request) => request.url === "/api/references/import")?.body, { notebook: "Notes", path: "Notes/refs.bib" });

  await drop(panel, { types: ["Files"], files: [new File(["%PDF"], "scan.pdf", { type: "application/pdf" })] });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][0].name, "scan.pdf");
  const [uploaded] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "add" }>>;
  assert.deepEqual(uploaded.entry.attachments, [{ kind: "pdf", path: "Notes/scan.pdf" }]);
});

test("deleting a cited entry asks for confirmation naming the citing documents; an uncited one is deleted with undo", async () => {
  const server = fakeServer(sampleLibrary());
  server.citations = { byFile: { "Notes/paper.md": ["godel1931"], "Notes/thesis.md": ["godel1931"] }, byKey: { godel1931: ["Notes/paper.md", "Notes/thesis.md"] } };
  const { host } = await renderPanel();
  await click(byLabel(host, "Actions for godel1931"));
  await click(buttonByText(host.ownerDocument.querySelector('[role=menu][aria-label="Actions for godel1931"]')!, "Delete…"));
  const dialog = document.querySelector("[role=dialog]")!;
  assert.match(dialog.textContent ?? "", /Delete godel1931\?/);
  assert.match(dialog.textContent ?? "", /Notes\/paper\.md/);
  assert.match(dialog.textContent ?? "", /Notes\/thesis\.md/);
  assert.equal(server.patches().length, 0);
  await click(buttonByText(dialog, "Delete"));
  assert.deepEqual(server.patches().at(-1), [{ op: "delete", id: "ref_godel" }]);

  await click(byLabel(host, "Actions for uncited2019"));
  await click(buttonByText(host.ownerDocument.querySelector('[role=menu][aria-label="Actions for uncited2019"]')!, "Delete…"));
  assert.equal(document.querySelector("[role=dialog]"), null, "no confirmation for an uncited entry");
  assert.deepEqual(server.patches().at(-1), [{ op: "delete", id: "ref_anon" }]);
  const deleted = sampleLibrary().entries.ref_anon;
  await click(buttonByText(host.querySelector("[role=status]")!, "Undo"));
  assert.deepEqual(server.patches().at(-1), [{ op: "put", entry: deleted }]);
  assert.ok(server.library.entries.ref_anon);
});

test("the style picker sets the style from bundled styles and the notebook's .csl files", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel({ tree: treeWith(["Notes/styles/my-journal.csl", "Notes/a.md"]) });
  assert.match(host.textContent ?? "", /Notes · APA 7th edition/);
  await click(byLabel(host, "References menu"));
  const styles = byLabel(host, "Citation style")!;
  assert.equal(styles.querySelector('[aria-checked="true"]')?.textContent, "APA 7th edition");
  assert.ok(buttonByText(styles, "my-journal.csl"));
  await click(buttonByText(styles, "IEEE"));
  assert.deepEqual(server.patches().at(-1), [{ op: "set-style", style: "ieee" }]);
  await click(byLabel(host, "References menu"));
  await click(buttonByText(byLabel(host, "Citation style")!, "my-journal.csl"));
  assert.deepEqual(server.patches().at(-1), [{ op: "set-style", style: "Notes/styles/my-journal.csl" }]);
  assert.match(host.textContent ?? "", /Notes · my-journal\.csl/);
});

test("export posts the format and saves the response as a download", async () => {
  const server = fakeServer(sampleLibrary());
  const downloads: string[] = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  try {
    const { host } = await renderPanel();
    await click(byLabel(host, "References menu"));
    await click(buttonByText(host.querySelector('[role=menu][aria-label="References menu"]')!, /BibLaTeX/));
    await settle();
    assert.deepEqual(server.requests.find((request) => request.url === "/api/references/export")?.body, { notebook: "Notes", format: "biblatex" });
    assert.deepEqual(downloads, ["Notes.bib"]);
    assert.match(host.textContent ?? "", /Exported Notes\.bib/);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("reveal and add events switch to the panel, select the notebook and open the entry or the Add box", async () => {
  fakeServer(sampleLibrary());
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  const shown: string[] = [];
  function Harness() {
    const [notebook, setNotebook] = useState("");
    const requests = m.useReferencesPanelRequests((name) => {
      shown.push(name);
      setNotebook(name);
    });
    return createElement(m.ReferencesPanel, {
      notebook, tree: treeWith([]), activeMarkdownDraft: null, openDrafts: [], canCite: false,
      onCite: () => undefined, onOpenPath: () => undefined, request: requests.request, onRequestHandled: requests.handled,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await settle();
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent(REFERENCES_REVEAL_EVENT, { detail: { notebook: "Notes", key: "smith2020" } })); });
  await settle();
  assert.deepEqual(shown, ["Notes"]);
  assert.ok(host.querySelector('[aria-label="Reference smith2020sparse"]'), "an alias reveals its entry's card");

  await click(byLabel(host, "Back to references"));
  assert.equal(host.querySelector('[aria-selected="true"][data-entry-id]')?.getAttribute("data-entry-id"), "ref_smith");
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent(REFERENCES_REVEAL_EVENT, { detail: { notebook: "Notes", entryId: "ref_godel" } })); });
  await settle();
  assert.ok(host.querySelector('[aria-label="Reference godel1931"]'));

  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent(REFERENCES_ADD_REQUEST_EVENT, { detail: { notebook: "Notes", query: "10.1000/xyz" } })); });
  await settle();
  assert.equal((byLabel(host, "Reference to add") as HTMLTextAreaElement).value, "10.1000/xyz");
  assert.match(host.textContent ?? "", /Detected: DOI/);
});

test("empty, loading and error states", async () => {
  const server = fakeServer(libraryOf([]));
  const empty = await renderPanel();
  assert.match(byLabel(empty.host, "Empty library")?.textContent ?? "", /paste|pasting/i);
  assert.match(byLabel(empty.host, "Empty library")?.textContent ?? "", /\.bib/);
  await act(async () => mounted!.root.unmount());
  mounted = null;
  m.resetReferenceLibraryCache();

  let fail = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/references?") && fail) return Response.json({ error: "Disk unavailable" }, { status: 500 });
    return Response.json(String(input).startsWith("/api/references?") ? { library: server.library } : { byFile: {}, byKey: {} });
  }) as typeof fetch;
  const failing = await renderPanel();
  assert.match(failing.host.querySelector("[role=alert]")?.textContent ?? "", /Disk unavailable/);
  fail = false;
  await click(buttonByText(failing.host, "Retry"));
  assert.ok(byLabel(failing.host, "Empty library"));
});

test("long libraries render only the rows in view", async () => {
  const entries = Array.from({ length: m.REFERENCE_WINDOW_THRESHOLD + 200 }, (_, index) => makeEntry(`ref_${index}`, `author${index}`, {
    type: "article-journal", title: `Title ${index}`, author: [{ family: `Author${String(index).padStart(4, "0")}` }], issued: { "date-parts": [[2000]] },
  }));
  fakeServer(libraryOf(entries));
  const { host } = await renderPanel();
  const rendered = host.querySelectorAll("[role=option][data-entry-id]").length;
  assert.ok(rendered > 0 && rendered < 60, `rendered ${rendered} rows`);
  const list = byLabel(host, "References") as HTMLElement;
  for (let index = 0; index < 120; index += 1) await act(async () => { list.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await act(async () => list.dispatchEvent(new dom.window.Event("scroll")));
  await settle();
  assert.equal(host.querySelector('[aria-selected="true"][data-entry-id]')?.getAttribute("data-entry-id"), "ref_119");
});

test("insertCitation puts [@key] at the caret in the source editor and queues an inline insertion in the visual editor", async () => {
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  const { emptyWorkspaceLibrary } = await import("../../src/lib/workspaces");
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("/api/workspaces")) return Response.json(init?.method === "PUT" ? { saved: true } : emptyWorkspaceLibrary());
    return Response.json({ ...emptyTree(), root: "/test/references" });
  }) as typeof fetch;
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() {
    workspace = useLiberaWorkspace(true).workspace;
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(createElement(Harness)));
  await settle();
  assert.equal(workspace.insertCitation("nobody"), false, "no Markdown editor, nothing to insert into");
  assert.equal(workspace.activeMarkdownDraft, null);

  await act(async () => { workspace.createUntitledFile("", undefined, { fileName: "Draft.md", content: "Hello world" }); });
  await settle();
  assert.equal(workspace.activeMarkdownDraft, "Hello world");
  const tabId = workspace.activeTab!.id;
  await act(async () => { workspace.insertCitation("smith2020"); });
  await settle();
  const pending = workspace.pendingVisualInsertions[tabId];
  assert.equal(pending?.markdown, "[@smith2020]");
  assert.equal(pending?.inline, true, "the visual editor inserts at the caret, not as a block");

  await act(async () => { workspace.setActiveTabViewState({ markdown: { editorMode: "source" } }); });
  const textarea = document.createElement("textarea");
  textarea.value = "Hello world";
  document.body.append(textarea);
  textarea.setSelectionRange(5, 5);
  workspace.textareaRef.current = textarea;
  await act(async () => { workspace.insertCitation("smith2020"); });
  await settle();
  assert.equal(workspace.activeTab!.draft, "Hello[@smith2020] world");
  textarea.remove();
});

test("References uses native row menus for right-click and more actions", async () => {
  const server = fakeServer(sampleLibrary());
  server.citations = { byFile: { "Notes/paper.md": ["godel1931"] }, byKey: { godel1931: ["Notes/paper.md"] } };
  type Input = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0];
  const menus: Input[] = [];
  let selection: string | null = "citing:0";
  window.liberaMenu = { popup: async (input) => { menus.push(input); return selection; } };
  try {
    const { host, calls } = await renderPanel({ canCite: false });
    const row = host.querySelector('[data-entry-id="ref_godel"]')!;
    await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 80 })); });
    await settle();
    assert.deepEqual(calls.opened, ["Notes/paper.md"]);
    assert.equal(menus[0].x, 42);
    assert.equal(menus[0].y, 80);
    const cite = menus[0].items.find((item) => "id" in item && item.id === "cite");
    assert.ok(cite && "enabled" in cite && cite.enabled === false);
    assert.equal(document.querySelector('[role="menu"]'), null);
    selection = "open-pdf";
    await click(byLabel(host, "Actions for godel1931"));
    assert.deepEqual(calls.opened, ["Notes/paper.md", "Notes/papers/godel.pdf"]);
    selection = null;
    await click(byLabel(host, "Actions for godel1931"));
    assert.equal(document.querySelector('[role="menu"]'), null, "dismissal does not open a web menu");
    assert.equal(menus.length, 3);
  } finally { delete window.liberaMenu; }
});

test("References native panel menu preserves styles, export choices and disabled actions", async () => {
  const server = fakeServer(sampleLibrary());
  type Input = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0];
  const menus: Input[] = [];
  let selection: string | null = null;
  window.liberaMenu = { popup: async (input) => { menus.push(input); return selection; } };
  try {
    const { host } = await renderPanel();
    await click(byLabel(host, "References menu"));
    assert.equal(document.querySelector('[role="menu"]'), null);
    const items = menus[0].items;
    const styles = items.find((item) => "id" in item && item.id === "style");
    assert.ok(styles && "submenu" in styles && styles.submenu?.some((item) => "checked" in item && item.checked));
    const exports = items.find((item) => "id" in item && item.id === "export-document");
    assert.ok(exports && "enabled" in exports && exports.enabled === false && exports.submenu!.length > 0);
    selection = "auto-create:true";
    await click(byLabel(host, "References menu"));
    assert.equal(server.library.settings?.autoCreateForPdfs, true);
    selection = "import";
    await click(byLabel(host, "References menu"));
    assert.ok(byLabel(host, "Add references"));
    window.liberaMenu.popup = async () => { throw new Error("IPC unavailable"); };
    await click(byLabel(host, "References menu"));
    assert.ok(document.querySelector('[role="menu"][aria-label="References menu"]'), "IPC failure falls back to the web menu");
  } finally { delete window.liberaMenu; }
});


// ---------------------------------------------------------------------------
// Selection, bulk actions, tags, reading, review and citing documents
// ---------------------------------------------------------------------------

async function modifiedClick(element: Element, init: MouseEventInit) {
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...init })); });
  await settle();
}

test("⌘/Ctrl-click and Shift-click select several rows; the bulk bar cites, tags and clears them", async () => {
  const server = fakeServer(sampleLibrary());
  const many: string[][] = [];
  const { host } = await renderPanel({ onCiteMany: (keys) => many.push(keys) });
  const row = (id: string) => host.querySelector(`[data-entry-id="${id}"]`)!;
  const inSelection = () => [...host.querySelectorAll('[data-in-selection="true"]')].map((item) => item.getAttribute("data-entry-id"));

  await modifiedClick(row("ref_godel"), { ctrlKey: true });
  await modifiedClick(row("ref_anon"), { metaKey: true });
  assert.deepEqual(inSelection(), ["ref_godel", "ref_anon"]);
  assert.equal(host.querySelector('[aria-label="Reference godel1931"]'), null, "a modified click does not open the card");
  assert.ok(byLabel(host, "2 selected references"));
  await click(byLabel(host, "Cite the selection at the cursor"));
  assert.deepEqual(many, [["godel1931", "uncited2019"]], "one citation, in list order");

  // Shift-click selects from the focused row (the last ⌘/Ctrl-clicked one) to the clicked row.
  await modifiedClick(row("ref_preprint"), { shiftKey: true });
  assert.deepEqual(inSelection(), ["ref_preprint", "ref_anon"]);

  await click(byLabel(host, "Edit tags of the selection"));
  await type(byLabel(host, "Tag to add to the selection"), "batch");
  await click(host.querySelector('[aria-label="Tags of the selection"] button[type="submit"]'));
  assert.deepEqual(server.library.entries.ref_preprint.tags, ["batch"]);
  assert.deepEqual(server.library.entries.ref_anon.tags, ["batch"]);
  assert.equal(server.library.entries.ref_godel.tags?.includes("batch"), false);
  assert.match(host.textContent ?? "", /Added “batch” to 2 references\./);

  await click(byLabel(host, "Mark as To read"));
  assert.equal(server.library.entries.ref_preprint.reading, "to-read");
  assert.equal(server.library.entries.ref_anon.reading, "to-read");

  await key(byLabel(host, "References")!, "Escape");
  assert.deepEqual(inSelection(), []);
  assert.equal(byLabel(host, "2 selected references"), null);
});

test("list keys: ⌘/Ctrl+A selects all, Shift+↓ extends, Delete asks to delete the selection, / focuses search", async () => {
  fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  const list = byLabel(host, "References")!;
  await key(list, "ArrowDown");
  await key(list, "ArrowDown", { shiftKey: true });
  assert.deepEqual([...host.querySelectorAll('[data-in-selection="true"]')].map((item) => item.getAttribute("data-entry-id")), ["ref_godel", "ref_smith"]);
  await key(list, "a", { ctrlKey: true });
  assert.equal(host.querySelectorAll('[data-in-selection="true"]').length, 4);
  await key(list, "Delete");
  assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /Delete 4 references\?/);
  await click(buttonByText(document.querySelector("[role=dialog]")!, "Cancel"));
  await key(list, "/");
  assert.equal(document.activeElement, byLabel(host, "Search references"));
});

test("tags filter the list from a row, the tag menu and a removable chip, and the view is remembered", async () => {
  fakeServer(sampleLibrary());
  const first = await renderPanel();
  await click(first.host.querySelector('[data-entry-id="ref_godel"] [title="Show references tagged logic"]'));
  assert.deepEqual(rowKeys(first.host), ["godel1931"]);
  assert.equal((byLabel(first.host, "Filter by tag") as HTMLSelectElement).value, "logic");
  assert.ok(byLabel(first.host, "Clear the tag filter"));
  assert.match(window.localStorage.getItem("libera:references-view:Notes") ?? "", /"tag":"logic"/);
  await click(byLabel(first.host, "Clear the tag filter"));
  assert.equal(rowKeys(first.host).length, 4);
  await type(byLabel(first.host, "Filter by tag"), "logic");
  assert.deepEqual(rowKeys(first.host), ["godel1931"]);
});

test("the card steps through the list, confirms and moves to the next entry to review, and sets the reading flag", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  await type(byLabel(host, "Filter references"), "review");
  assert.deepEqual(rowKeys(host), ["smith2020sparse", "smith2020sparsea"]);
  await click(host.querySelector('[data-entry-id="ref_smith"]'));
  assert.ok(byLabel(host, "Reference 1 of 2"));
  await click(buttonByText(host, /Confirm & next/));
  assert.equal(server.library.entries.ref_smith.status, "confirmed");
  assert.ok(host.querySelector('[aria-label="Reference smith2020sparsea"]'), "the next entry to review opens");
  assert.equal(buttonByText(host, /Confirm & next/), undefined, "nothing else is left to review");

  await click(byLabel(host, "Reading")!.querySelector("button"));
  assert.equal(server.library.entries.ref_preprint.reading, "to-read");
  assert.equal(byLabel(host, "Next reference"), null, "a list of one has no previous/next");
  await click(byLabel(host, "Back to references"));
  await type(byLabel(host, "Filter references"), "to-read");
  assert.deepEqual(rowKeys(host), ["smith2020sparsea"]);
});

test("the card attaches notebook files and links, removes attachments, and lists where it is cited", async () => {
  const server = fakeServer(sampleLibrary());
  server.citations = { byFile: { "Notes/paper.md": ["godel1931"] }, byKey: { godel1931: ["Notes/paper.md"] } };
  const opened: Array<{ path: string; start: number; end: number; line: number }> = [];
  const text = "# Paper\n\nAs shown [@godel1931, p. 3], it holds.";
  const { host } = await renderPanel({
    tree: treeWith(["Notes/papers/godel.pdf", "Notes/papers/other.pdf", "Notes/paper.md"]),
    openDrafts: [{ path: "Notes/paper.md", text }],
    onOpenCitation: (path, range) => opened.push({ path, ...range }),
  });
  await click(host.querySelector('[data-entry-id="ref_godel"]'));

  await click(byLabel(host, "Show citations in paper.md"));
  const snippet = host.querySelector('[aria-label="Citations in paper.md"] button')!;
  assert.match(snippet.textContent ?? "", /As shown \[@godel1931, p\. 3\], it holds\./);
  await click(snippet);
  assert.deepEqual(opened, [{ path: "Notes/paper.md", start: text.indexOf("[@"), end: text.indexOf("],") + 1, line: 3 }]);

  await click(buttonByText(host, /Attach file/));
  const choices = [...host.querySelectorAll('[aria-label="Files to attach"] button')].map((button) => button.textContent?.trim());
  assert.deepEqual(choices, ["paper.md", "other.pdf"], "attached files are not offered");
  await click(buttonByText(host.querySelector('[aria-label="Files to attach"]')!, "other.pdf"));
  assert.deepEqual(server.patches().at(-1), [{ op: "attach", id: "ref_godel", attachment: { kind: "pdf", path: "Notes/papers/other.pdf" } }]);

  await click(buttonByText(host, /Add link/));
  await type(byLabel(host, "Web address to attach"), "not a link");
  assert.match(host.textContent ?? "", /Enter a web address/);
  await type(byLabel(host, "Web address to attach"), "https://example.org/paper");
  await click(buttonByText(host, "Add"));
  assert.deepEqual(server.patches().at(-1), [{ op: "attach", id: "ref_godel", attachment: { kind: "url", url: "https://example.org/paper" } }]);

  await click(byLabel(host, "Remove attachment other.pdf"));
  assert.deepEqual(server.patches().at(-1), [{ op: "detach", id: "ref_godel", attachment: { kind: "pdf", path: "Notes/papers/other.pdf" } }]);
});

test("reference files dropped from the computer are imported from their text without uploading", async () => {
  const server = fakeServer(sampleLibrary());
  const uploads: File[][] = [];
  server.importResult = () => ({ library: server.library, added: ["ref_x"], errors: [], duplicates: [] });
  const { host } = await renderPanel({ onUploadFiles: async (_notebook, files) => { uploads.push(files); } });
  await drop(host.querySelector(".libera-references-panel")!, { types: ["Files"], files: [new File(["@article{a, title={A}}"], "refs.bib")] });
  assert.deepEqual(server.requests.find((request) => request.url === "/api/references/import")?.body, { notebook: "Notes", format: "auto", text: "@article{a, title={A}}" });
  assert.equal(uploads.length, 0);
  assert.match(host.textContent ?? "", /Imported 1 reference from refs\.bib\./);
});

test("Insert bibliography here is offered for a Markdown document without a marker", async () => {
  fakeServer(sampleLibrary());
  let inserted = 0;
  const { host, update } = await renderPanel({ activeMarkdownDraft: "Text [@godel1931].", onInsertBibliography: () => { inserted += 1; } });
  await click(byLabel(host, "References menu"));
  const item = buttonByText(document.querySelector('[role="menu"][aria-label="References menu"]')!, /Insert bibliography here/) as HTMLButtonElement;
  assert.equal(item.disabled, false);
  await click(item);
  assert.equal(inserted, 1);
  await update({ activeMarkdownDraft: "Text [@godel1931].\n\n:::bibliography\n:::\n" });
  await click(byLabel(host, "References menu"));
  const again = buttonByText(document.querySelector('[role="menu"][aria-label="References menu"]')!, /Insert bibliography here/) as HTMLButtonElement;
  assert.equal(again.disabled, true);
  assert.match(again.title, /already places its bibliography/);
});
