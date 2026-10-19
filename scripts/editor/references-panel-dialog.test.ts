import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import {
  authorYearLabel,
  chooseKeptEntry,
  formatPlainReference,
  highlightSegments,
  sortEntries,
} from "../../src/components/libera/references/reference-display";
import { buildEditOp, validateReferenceFields } from "../../src/components/libera/references/reference-edit-form";
import { buildUndoRecord, isUndoStale } from "../../src/components/libera/references/use-reference-undo";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import type { CslItem, ReferenceEntry, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement", "Element", "Node", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
after(() => dom.window.close());

async function loadModules() {
  const [client, form, dialog, library, undo] = await Promise.all([
    import("react-dom/client"),
    import("../../src/components/libera/references/reference-edit-form"),
    import("../../src/components/libera/references/manage-references-dialog"),
    import("../../src/components/libera/references/use-reference-library"),
    import("../../src/components/libera/references/use-reference-undo"),
  ]);
  return { ...client, ...form, ...dialog, ...library, ...undo };
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

function libraryOf(entries: ReferenceEntry[]): ReferenceLibrary {
  return { ...emptyReferenceLibrary(), revision: 1, entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])) };
}

function apply(library: ReferenceLibrary, ops: ReferenceLibraryOp[]) {
  return { ...applyLibraryOps(library, ops, "2026-10-02T00:00:00.000Z").library, revision: library.revision + 1 };
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
});

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(element));
  await settle();
  return { host, rerender: (next: ReturnType<typeof createElement>) => act(async () => root.render(next)) };
}

async function settle(ms = 0) {
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function setValue(element: Element | null, value: string) {
  assert.ok(element, "field is mounted");
  const prototype = element instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
    : element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new dom.window.Event(element instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function type(element: Element | null, value: string) {
  await act(async () => setValue(element, value));
  await settle();
}

async function click(element: Element | null | undefined, init: MouseEventInit = {}) {
  assert.ok(element, "element is mounted");
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
  await settle();
}

function byLabel(root: ParentNode, label: string) {
  return root.querySelector(`[aria-label="${label}"]`);
}

function buttonByText(root: ParentNode, text: string | RegExp) {
  return [...root.querySelectorAll("button")].find((button) => typeof text === "string" ? button.textContent?.trim() === text : text.test(button.textContent?.trim() ?? ""));
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

test("display helpers label authors and years, format a plain reference and mark accent-insensitive matches", () => {
  const csl: CslItem = { type: "article-journal", title: "Über formal unentscheidbare Sätze", author: [{ family: "Gödel", given: "Kurt" }, { family: "Lee", given: "Ann Marie" }, { literal: "WHO" }], issued: { "date-parts": [[1931, 3]] }, "container-title": "Monatshefte", volume: "38", issue: "1", page: "173–198" };
  assert.equal(authorYearLabel(csl), "Gödel et al. (1931)");
  assert.equal(authorYearLabel({ type: "book", editor: [{ family: "Ito" }, { family: "Kim" }] }), "Ito & Kim (n.d.)");
  assert.equal(formatPlainReference(csl), "Gödel, K., Lee, A. M., & WHO (1931). Über formal unentscheidbare Sätze. Monatshefte, 38(1), 173–198.");
  assert.deepEqual(highlightSegments("Gödel’s Sätze", ["godel", "satze"]), [
    { text: "Gödel", match: true }, { text: "’s ", match: false }, { text: "Sätze", match: true },
  ]);
  const a = makeEntry("a", "a", { type: "book", title: "B", author: [{ family: "Zed" }], issued: { "date-parts": [[2001]] } }, { createdAt: "2026-01-02T00:00:00.000Z" });
  const b = makeEntry("b", "b", { type: "book", title: "A", author: [{ family: "Abe" }], issued: { "date-parts": [[2010]] } }, { createdAt: "2026-01-01T00:00:00.000Z" });
  const c = makeEntry("c", "c", { type: "book", title: "C" }, { createdAt: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(sortEntries([a, b, c], "author").map((entry) => entry.id), ["b", "a", "c"]);
  assert.deepEqual(sortEntries([a, b, c], "year").map((entry) => entry.id), ["b", "a", "c"]);
  assert.deepEqual(sortEntries([a, b, c], "title").map((entry) => entry.id), ["b", "a", "c"]);
  assert.deepEqual(sortEntries([a, b, c], "added").map((entry) => entry.id), ["c", "a", "b"]);
  const preprint = makeEntry("p", "p", { type: "article", title: "T", DOI: "10.48550/arXiv.2101.00001" }, { identifiers: { doi: "10.48550/arxiv.2101.00001", arxiv: "2101.00001" }, createdAt: "2025-01-01T00:00:00.000Z" });
  const published = makeEntry("j", "j", { type: "article-journal", title: "T", "container-title": "Journal" }, { identifiers: { arxiv: "2101.00001" }, createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(chooseKeptEntry([preprint, published]).id, "j", "the published version is kept even when newer");
  assert.equal(chooseKeptEntry([a, b]).id, "b", "otherwise the oldest");
});

// ---------------------------------------------------------------------------
// Edit all fields
// ---------------------------------------------------------------------------

const editable = makeEntry("ref_e", "smith2020", {
  type: "article-journal", title: "Old title", author: [{ family: "Smith", given: "Jane" }, { family: "Lee", given: "Kim" }],
  issued: { "date-parts": [[2020, 5]] }, "container-title": "Journal", volume: "4", DOI: "10.1000/ABC", "original-date": { "date-parts": [[1999]] },
}, { identifiers: { doi: "10.1000/abc", arxiv: "2101.00001" }, provenance: { title: { source: "crossref", confidence: 0.9, retrievedAt: NOW } } });

test("buildEditOp sends changed fields with user provenance, removes cleared ones and syncs identifiers", () => {
  const next: CslItem = { ...editable.csl, title: "New title", volume: undefined, DOI: "10.2000/xyz", publisher: "ACM" };
  const op = buildEditOp(editable, next, NOW)!;
  assert.deepEqual(op, {
    op: "update",
    id: "ref_e",
    csl: { title: "New title", DOI: "10.2000/xyz", publisher: "ACM" },
    removeFields: ["volume"],
    provenance: {
      title: { source: "user", confidence: 1, retrievedAt: NOW },
      DOI: { source: "user", confidence: 1, retrievedAt: NOW },
      publisher: { source: "user", confidence: 1, retrievedAt: NOW },
    },
    identifiers: { doi: "10.2000/xyz", arxiv: "2101.00001" },
  });
  assert.equal(buildEditOp(editable, structuredClone(editable.csl), NOW), null, "no change, no op");
  assert.deepEqual(validateReferenceFields({ type: "book", DOI: "nope", URL: "example.org", ISBN: "978-0-262-03384-9", author: [{ given: "Ann" }] }, { requireTitle: true }), {
    title: "A title is needed.",
    author: "Each name needs a family name, or switch it to an institution.",
    DOI: "This is not a DOI. DOIs look like 10.1234/abcd.",
    URL: "Web addresses start with http:// or https://.",
    ISBN: "The ISBN's check digit does not match.",
  });
});

test("the edit form sends one update with only the changed fields, and validates on the client", async () => {
  const submitted: ReferenceLibraryOp[][] = [];
  let closed = 0;
  const { host } = await render(createElement(m.ReferenceEditForm, {
    open: true, entry: editable, onClose: () => { closed += 1; },
    onSubmit: async (ops: ReferenceLibraryOp[]) => { submitted.push(ops); },
  }));
  const dialog = document.querySelector("[role=dialog]")!;
  assert.ok(dialog);
  assert.ok(host);
  assert.equal((dialog.querySelector("#reference-field-type") as HTMLSelectElement).value, "article-journal");
  assert.ok(dialog.querySelector("#reference-field-ISSN"), "journal fields are shown for journal articles");
  assert.equal(dialog.querySelector("#reference-field-ISBN"), null);
  assert.equal((byLabel(dialog, "Other field 1 name") as HTMLInputElement).value, "original-date", "other CSL variables are listed");

  await type(dialog.querySelector("#reference-field-DOI"), "not a doi");
  await click(buttonByText(dialog, "Save"));
  assert.match(dialog.textContent ?? "", /This is not a DOI/);
  assert.equal(submitted.length, 0);
  await type(dialog.querySelector("#reference-field-DOI"), "10.1000/ABC");

  await type(dialog.querySelector("#reference-field-title"), "New title");
  await type(dialog.querySelector("#reference-field-volume"), "");
  await click(byLabel(dialog, "Move Authors 2 up"));
  await type(byLabel(dialog, "Month"), "6");
  await click(buttonByText(dialog, /Add field/));
  await type(byLabel(dialog, "Other field 2 name"), "number");
  await type(byLabel(dialog, "Other field 2 value"), "TR-7");
  await click(buttonByText(dialog, "Save"));
  assert.equal(submitted.length, 1);
  const [op] = submitted[0] as Array<Extract<ReferenceLibraryOp, { op: "update" }>>;
  assert.deepEqual(op.csl, {
    title: "New title",
    author: [{ family: "Lee", given: "Kim" }, { family: "Smith", given: "Jane" }],
    issued: { "date-parts": [[2020, 6]] },
    number: "TR-7",
  });
  assert.deepEqual(op.removeFields, ["volume"]);
  assert.deepEqual(Object.keys(op.provenance ?? {}).sort(), ["author", "issued", "number", "title"]);
  assert.ok(Object.values(op.provenance ?? {}).every((provenance) => provenance?.source === "user" && provenance.confidence === 1));
  assert.equal(op.identifiers, undefined, "the DOI did not change");
  assert.equal(closed, 1);
});

test("changing the type shows its fields, and the name editor adds institutions", async () => {
  const submitted: ReferenceLibraryOp[][] = [];
  await render(createElement(m.ReferenceEditForm, {
    open: true, entry: editable, onClose: () => undefined,
    onSubmit: async (ops: ReferenceLibraryOp[]) => { submitted.push(ops); },
  }));
  const dialog = document.querySelector("[role=dialog]")!;
  await type(dialog.querySelector("#reference-field-type"), "book");
  assert.ok(dialog.querySelector("#reference-field-ISBN"));
  assert.ok(dialog.querySelector("#reference-field-publisher"));
  await click(buttonByText(dialog, /Add author/));
  await click(byLabel(dialog, "Authors 3: switch to institution"));
  await type(byLabel(dialog, "Authors 3 name"), "World Health Organization");
  await click(byLabel(dialog, "Remove Authors 1"));
  await click(buttonByText(dialog, "Save"));
  const [op] = submitted[0] as Array<Extract<ReferenceLibraryOp, { op: "update" }>>;
  assert.equal(op.csl?.type, "book");
  assert.deepEqual(op.csl?.author, [{ family: "Lee", given: "Kim" }, { literal: "World Health Organization" }]);
  assert.equal(op.provenance?.type, undefined, "the type has no provenance");
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

test("undo records invert adds, updates, deletes, merges, key renames and style changes", () => {
  const a = makeEntry("ref_a", "a2020", { type: "book", title: "A" });
  const b = makeEntry("ref_b", "b2020", { type: "book", title: "B" }, { aliases: ["bee"] });
  const before = libraryOf([a, b]);

  const added = apply(before, [{ op: "add", entry: { csl: { type: "book", title: "C" } } }]);
  const newId = Object.keys(added.entries).find((id) => !before.entries[id])!;
  assert.deepEqual(buildUndoRecord(before, added, "Add", [])!.inverse, [{ op: "delete", id: newId }]);

  const updated = apply(before, [{ op: "update", id: "ref_a", csl: { title: "A2" } }, { op: "rename-key", id: "ref_b", key: "bnew" }]);
  assert.deepEqual(buildUndoRecord(before, updated, "Edit", ["ref_a", "ref_b"])!.inverse, [{ op: "put", entry: a }, { op: "put", entry: b }]);

  const merged = apply(before, [{ op: "merge", keepId: "ref_a", mergeIds: ["ref_b"] }]);
  const mergeRecord = buildUndoRecord(before, merged, "Merge", ["ref_a", "ref_b"])!;
  assert.deepEqual(mergeRecord.inverse, [{ op: "put", entry: a }, { op: "put", entry: b }], "the kept entry gives back its aliases before the merged one returns");
  // The inverse applies cleanly and restores the library.
  assert.deepEqual(apply(merged, mergeRecord.inverse).entries, before.entries);

  const deleted = apply(before, [{ op: "delete", id: "ref_b" }]);
  assert.deepEqual(buildUndoRecord(before, deleted, "Delete", ["ref_b"])!.inverse, [{ op: "put", entry: b }]);

  const styled = apply(before, [{ op: "set-style", style: "ieee" }, { op: "set-settings", settings: { autoCreateForPdfs: true } }]);
  const styleRecord = buildUndoRecord(before, styled, "Style", [])!;
  assert.deepEqual(styleRecord.inverse, [{ op: "set-style", style: "apa" }, { op: "set-settings", settings: { autoCreateForPdfs: null } }]);
  assert.equal(isUndoStale(styleRecord, styled), false);
  assert.equal(isUndoStale(styleRecord, apply(styled, [{ op: "set-style", style: "nature" }])), true);

  const record = buildUndoRecord(before, updated, "Edit", ["ref_a", "ref_b"])!;
  assert.equal(isUndoStale(record, updated), false);
  assert.equal(isUndoStale(record, apply(updated, [{ op: "update", id: "ref_b", tags: ["x"] }])), true, "another change to a touched entry makes it stale");
  const unrelated = apply(apply(updated, [{ op: "add", entry: { csl: { type: "book", title: "Z" } } }]), []);
  assert.equal(isUndoStale(record, unrelated), false, "changes to other entries do not");
  assert.equal(buildUndoRecord(before, before, "Nothing"), null);
});

type Probe = { api: ReturnType<typeof import("../../src/components/libera/references/use-reference-undo").useReferenceUndo> | null };

test("the undo hook applies the inverse as one transaction and is disabled once another window changes the same entry", async () => {
  let server = libraryOf([makeEntry("ref_a", "a2020", { type: "book", title: "A" }), makeEntry("ref_b", "b2020", { type: "book", title: "B" })]);
  const patches: ReferenceLibraryOp[][] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const { revision, ops } = JSON.parse(String(init.body)) as { revision: number; ops: ReferenceLibraryOp[] };
      patches.push(ops);
      if (revision !== server.revision) return Response.json({ error: "Conflict", library: server }, { status: 409 });
      server = apply(server, ops);
      return Response.json({ library: server });
    }
    assert.match(String(input), /\/api\/references\?notebook=Notes/);
    return Response.json({ library: server });
  }) as typeof fetch;
  const probe: Probe = { api: null };
  function Probe() {
    const { library } = m.useReferenceLibrary("Notes");
    probe.api = m.useReferenceUndo("Notes", library);
    return null;
  }
  await render(createElement(Probe));
  const original = structuredClone(server.entries.ref_a);
  await act(async () => { await probe.api!.apply([{ op: "update", id: "ref_a", csl: { title: "A2" } }], "Edit A"); });
  await settle();
  assert.equal(probe.api!.canUndo, true);
  assert.equal(probe.api!.undoLabel, "Edit A");
  await act(async () => { await probe.api!.undo(); });
  await settle();
  assert.deepEqual(patches.at(-1), [{ op: "put", entry: original }]);
  assert.equal(server.entries.ref_a.csl.title, "A");
  assert.equal(probe.api!.canUndo, false, "the stack is empty");

  await act(async () => { await probe.api!.apply([{ op: "update", id: "ref_b", csl: { title: "B2" } }], "Edit B"); });
  await settle();
  // Another window changes the same entry.
  server = apply(server, [{ op: "update", id: "ref_b", notes: "from elsewhere" }]);
  await act(async () => { await m.fetchReferenceLibrary("Notes"); });
  await settle();
  assert.equal(probe.api!.stale, true);
  assert.equal(probe.api!.canUndo, false);
  const before = patches.length;
  await act(async () => { await assert.rejects(probe.api!.undo(), /can no longer be undone/); });
  assert.equal(patches.length, before, "a stale undo sends nothing");
});

test("the undo stack keeps the last 20 transactions", () => {
  assert.equal(m.REFERENCE_UNDO_LIMIT, 20);
  let library = libraryOf([makeEntry("ref_a", "a2020", { type: "book", title: "A" })]);
  for (let index = 0; index < 25; index += 1) {
    const next = apply(library, [{ op: "update", id: "ref_a", csl: { title: `A${index}` } }]);
    m.recordReferenceTransaction("Limit", library, next, `Edit ${index}`, ["ref_a"]);
    library = next;
  }
  // Only reachable through the hook; check through a fresh record that the oldest were dropped.
  let depth = 0;
  function Probe() {
    depth = m.useReferenceUndo("Limit", library).depth;
    return null;
  }
  return render(createElement(Probe)).then(() => assert.equal(depth, 20));
});

// ---------------------------------------------------------------------------
// Manage references dialog
// ---------------------------------------------------------------------------

function dialogLibrary() {
  return libraryOf([
    makeEntry("ref_1", "alpha2001", { type: "book", title: "Zebra studies", author: [{ family: "Alpha" }], issued: { "date-parts": [[2001]] }, publisher: "Press" }, { updatedAt: "2026-01-03T00:00:00.000Z" }),
    makeEntry("ref_2", "beta1999", { type: "article-journal", title: "Apple studies", author: [{ family: "Beta" }], issued: { "date-parts": [[1999]] }, "container-title": "Fruit" }, { status: "needs-review", updatedAt: "2026-01-01T00:00:00.000Z" }),
    makeEntry("ref_3", "gamma2010", { type: "article-journal", title: "Mango studies", author: [{ family: "Gamma" }], issued: { "date-parts": [[2010]] }, "container-title": "Fruit", DOI: "10.1/m" }, { identifiers: { doi: "10.1/m" }, status: "unresolved", attachments: [{ kind: "pdf", path: "Notes/m.pdf" }], updatedAt: "2026-01-02T00:00:00.000Z" }),
    makeEntry("ref_4", "gamma2010b", { type: "article", title: "Mango studies", author: [{ family: "Gamma" }], issued: { "date-parts": [[2010]] }, DOI: "10.1/m", note: "preprint" }, { identifiers: { doi: "10.1/m" }, aliases: ["mango"], createdAt: "2025-01-01T00:00:00.000Z" }),
  ]);
}

async function renderDialog(library = dialogLibrary(), citations = new Map<string, Set<string>>()) {
  const applied: Array<{ ops: ReferenceLibraryOp[]; label: string }> = [];
  let undone = 0;
  const { findDuplicateGroups } = await import("../../src/lib/references/dedupe");
  const props = {
    open: true, notebook: "Notes", library, citations,
    duplicateGroups: findDuplicateGroups(Object.values(library.entries)),
    apply: async (ops: ReferenceLibraryOp[], label: string) => { applied.push({ ops, label }); },
    undo: { canUndo: true, stale: false, label: "Edit", run: async () => { undone += 1; } },
    onClose: () => undefined,
  };
  await render(createElement(m.ManageReferencesDialog, props));
  const dialog = document.querySelector("[role=dialog]")!;
  return { dialog, applied, undone: () => undone };
}

function tableKeys(dialog: Element) {
  return [...dialog.querySelectorAll("tbody tr[data-entry-id]")].map((row) => row.querySelector("td.font-mono")?.textContent);
}

test("the dialog sorts by column, filters columns and selects with shift-click ranges", async () => {
  const { dialog } = await renderDialog();
  assert.deepEqual(tableKeys(dialog), ["alpha2001", "beta1999", "gamma2010", "gamma2010b"], "sorted by authors");
  const header = (label: string) => [...dialog.querySelectorAll("thead button")].find((button) => button.textContent === label)!;
  await click(header("Year"));
  assert.deepEqual(tableKeys(dialog), ["beta1999", "alpha2001", "gamma2010", "gamma2010b"]);
  await click(header("Year"));
  assert.deepEqual(tableKeys(dialog), ["gamma2010", "gamma2010b", "alpha2001", "beta1999"]);
  await click(header("Title"));
  assert.deepEqual(tableKeys(dialog), ["beta1999", "gamma2010", "gamma2010b", "alpha2001"]);
  await click(header("Updated"));
  assert.deepEqual(tableKeys(dialog), ["beta1999", "gamma2010", "alpha2001", "gamma2010b"]);

  await type(byLabel(dialog, "Filter Venue"), "fruit");
  assert.deepEqual(tableKeys(dialog).sort(), ["beta1999", "gamma2010"]);
  await type(byLabel(dialog, "Filter Venue"), "");

  await click(header("Key"));
  await click(byLabel(dialog, "Select alpha2001"));
  await click(byLabel(dialog, "Select gamma2010"), { shiftKey: true });
  assert.match(byLabel(dialog, "Bulk actions")?.textContent ?? "", /3 selected/);
  await click(byLabel(dialog, "Select beta1999"));
  assert.match(byLabel(dialog, "Bulk actions")?.textContent ?? "", /2 selected/);
  await click(byLabel(dialog, "Select all"));
  assert.match(byLabel(dialog, "Bulk actions")?.textContent ?? "", /4 selected/);
  await click(byLabel(dialog, "Select all"));
  assert.match(byLabel(dialog, "Bulk actions")?.textContent ?? "", /0 selected/);
});

test("bulk actions confirm, change type, export the selection and delete with the cited ones named", async () => {
  const citations = new Map([["beta1999", new Set(["Notes/essay.md"])]]);
  const { dialog, applied } = await renderDialog(dialogLibrary(), citations);
  await click(byLabel(dialog, "Select alpha2001"));
  await click(byLabel(dialog, "Select beta1999"));
  await click(buttonByText(dialog, "Mark confirmed"));
  assert.deepEqual(applied.at(-1)!.ops, [{ op: "update", id: "ref_2", status: "confirmed" }], "only unconfirmed entries change");
  await type(byLabel(dialog, "Change type of selected"), "report");
  assert.deepEqual(applied.at(-1)!.ops, [
    { op: "update", id: "ref_1", csl: { type: "report" } },
    { op: "update", id: "ref_2", csl: { type: "report" } },
  ]);

  const requests: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response("TY  - BOOK", { headers: { "Content-Disposition": "attachment; filename*=UTF-8''Notes%20selection.ris" } });
  }) as typeof fetch;
  const downloads: string[] = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  try {
    await type(byLabel(dialog, "Export selected"), "ris");
    await settle();
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
  assert.deepEqual(requests, [{ notebook: "Notes", format: "ris", ids: ["ref_1", "ref_2"] }]);
  assert.deepEqual(downloads, ["Notes selection.ris"]);

  await click(buttonByText(dialog, "Delete"));
  const confirm = [...document.querySelectorAll("[role=dialog]")].at(-1)!;
  assert.match(confirm.textContent ?? "", /Delete 2 references\?/);
  assert.match(byLabel(confirm, "Cited references")?.textContent ?? "", /beta1999 is cited in:Notes\/essay\.md/);
  await click(buttonByText(confirm, "Delete"));
  assert.deepEqual(applied.at(-1)!.ops, [{ op: "delete", id: "ref_1" }, { op: "delete", id: "ref_2" }]);
});

test("merging selected entries previews the result and sends the merge op for the chosen entry", async () => {
  const { dialog, applied } = await renderDialog();
  await click(byLabel(dialog, "Select gamma2010"));
  await click(byLabel(dialog, "Select gamma2010b"));
  await click(buttonByText(dialog, "Merge selected"));
  const merge = [...document.querySelectorAll("[role=dialog]")].at(-1)!;
  assert.match(merge.textContent ?? "", /Merge 2 references/);
  assert.equal((byLabel(merge, "Keep gamma2010") as HTMLInputElement).checked, true, "the published version is suggested");
  assert.match(byLabel(merge, "Aliases after merge")?.textContent ?? "", /gamma2010b, mango/);
  const preview = byLabel(merge, "Merge preview")!;
  assert.ok(preview.querySelector("[data-filled]"), "fields the kept entry lacks are filled in");
  assert.match(preview.textContent ?? "", /preprint\(filled in\)/);
  await click(byLabel(merge, "Keep gamma2010b"));
  assert.match(byLabel(merge, "Aliases after merge")?.textContent ?? "", /mango, gamma2010/);
  await click(buttonByText(merge, "Merge into gamma2010b"));
  assert.deepEqual(applied.at(-1)!.ops, [{ op: "merge", keepId: "ref_4", mergeIds: ["ref_3"] }]);
});

test("cells edit inline with user provenance, the Duplicates tab merges groups and Undo runs", async () => {
  const { dialog, applied, undone } = await renderDialog();
  await act(async () => { byLabel(dialog, "title of beta1999: Apple studies")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  const input = byLabel(dialog, "Edit title of beta1999")!;
  await type(input, "Apple studies, revised");
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
  const [titleOp] = applied.at(-1)!.ops as Array<Extract<ReferenceLibraryOp, { op: "update" }>>;
  assert.deepEqual(titleOp.csl, { title: "Apple studies, revised" });
  assert.equal(titleOp.provenance?.title?.source, "user");

  await act(async () => { byLabel(dialog, "year of alpha2001: 2001")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  await type(byLabel(dialog, "Edit year of alpha2001"), "2002");
  await act(async () => { byLabel(dialog, "Edit year of alpha2001")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
  assert.deepEqual((applied.at(-1)!.ops[0] as Extract<ReferenceLibraryOp, { op: "update" }>).csl, { issued: { "date-parts": [[2002]] } });

  await act(async () => { byLabel(dialog, "venue of alpha2001: Press")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  await type(byLabel(dialog, "Edit venue of alpha2001"), "MIT Press");
  await act(async () => { byLabel(dialog, "Edit venue of alpha2001")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
  assert.deepEqual((applied.at(-1)!.ops[0] as Extract<ReferenceLibraryOp, { op: "update" }>).csl, { publisher: "MIT Press" });

  await click(buttonByText(dialog, "Undo"));
  assert.equal(undone(), 1);
  await act(async () => { dialog.querySelector("table")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })); });
  await settle();
  assert.equal(undone(), 2, "⌘/Ctrl+Z in the dialog undoes");

  await click(buttonByText(dialog, /Duplicates/));
  const groups = byLabel(dialog, "Duplicate groups")!;
  assert.match(groups.textContent ?? "", /Preprint and published version/);
  await click(buttonByText(groups, /Merge/));
  const merge = [...document.querySelectorAll("[role=dialog]")].at(-1)!;
  await click(buttonByText(merge, /Merge into gamma2010$/));
  assert.deepEqual(applied.at(-1)!.ops, [{ op: "merge", keepId: "ref_3", mergeIds: ["ref_4"] }]);
});

test("Content-Disposition file names are read in both forms", () => {
  assert.equal(m.contentDispositionFileName('attachment; filename="Notes.bib"'), "Notes.bib");
  assert.equal(m.contentDispositionFileName("attachment; filename*=UTF-8''G%C3%B6del.ris; filename=\"x.ris\""), "Gödel.ris");
  assert.equal(m.contentDispositionFileName(null), null);
});
