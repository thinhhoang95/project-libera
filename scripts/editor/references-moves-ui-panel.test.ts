import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyTree } from "../../src/components/libera/api-client";
import type { ReferencesPanelProps } from "../../src/components/libera/references/references-panel";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import { FACT_CHECK_REQUEST_EVENT, type CslItem, type ReferenceEntry, type ReferenceLibrary, type ReferenceLibraryOp } from "../../src/lib/references/types";

// The moves-ui half of the References panel: Update citations after a key
// rename or a merge (the rewrite dialog: preview, apply into open tabs, skips,
// undo), the formatted reference list and document bibliography in the panel
// menu, the preference defaults from GET /api/references/settings, and the
// source toolbar's Fact-check guard for untitled drafts. The reference API is
// a fake: library routes run the real pure ops; the others are scripted.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement", "Element", "Node", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
after(() => dom.window.close());

async function loadModules() {
  const [client, panel, library, undo, candidates, jobs, dialog, preferences, rewrite, toolbar, bibliography] = await Promise.all([
    import("react-dom/client"),
    import("../../src/components/libera/references/references-panel"),
    import("../../src/components/libera/references/use-reference-library"),
    import("../../src/components/libera/references/use-reference-undo"),
    import("../../src/components/libera/references/reference-candidates"),
    import("../../src/components/libera/references/use-reference-jobs"),
    import("../../src/components/libera/references/manage-references-dialog"),
    import("../../src/components/libera/references/use-reference-preferences"),
    import("../../src/components/libera/references/rewrite-citations-dialog"),
    import("../../src/components/libera/markdown-toolbar"),
    import("../../src/components/libera/references/bibliography-actions"),
  ]);
  return { ...client, ...panel, ...library, ...undo, ...candidates, ...jobs, ...dialog, ...preferences, ...rewrite, ...toolbar, ...bibliography };
}
let m: Awaited<ReturnType<typeof loadModules>>;
before(async () => {
  m = await loadModules();
});

const NOW = "2026-10-01T00:00:00.000Z";

function makeEntry(id: string, key: string, csl: CslItem, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return { id, key, aliases: [], csl, identifiers: {}, provenance: {}, status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra };
}

function sampleLibrary(): ReferenceLibrary {
  const entries = [
    makeEntry("ref_smith", "smith2020sparse", { type: "article-journal", title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, DOI: "10.1000/sparse" }, { identifiers: { doi: "10.1000/sparse" } }),
    makeEntry("ref_gamma", "gamma2010", { type: "article-journal", title: "Gamma rays in the garden", author: [{ family: "Gamma", given: "Ann" }], issued: { "date-parts": [[2010]] }, DOI: "10.1000/gamma", "container-title": "Garden Physics" }, { identifiers: { doi: "10.1000/gamma" } }),
    makeEntry("ref_gamma_b", "gamma2010b", { type: "article-journal", title: "Gamma rays in the garden", author: [{ family: "Gamma", given: "Ann" }], issued: { "date-parts": [[2010]] }, DOI: "10.1000/gamma" }, { identifiers: { doi: "10.1000/gamma" }, aliases: ["gammaOld"] }),
  ];
  return { ...emptyReferenceLibrary(), revision: 1, entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])) };
}

type Request = { url: string; method: string; body: Record<string, unknown>; headers?: HeadersInit };
type Handler = (body: Record<string, unknown>) => unknown;

function fakeServer(library: ReferenceLibrary, options: { settings?: Record<string, boolean> | null; citations?: Record<string, string[]> } = {}) {
  const server = {
    library,
    requests: [] as Request[],
    rewrite: null as Handler | null,
    bibliography: null as Handler | null,
    exportResponse: null as ((body: Record<string, unknown>) => Response) | null,
    files: {} as Record<string, string>,
    bodies(url: string) {
      return server.requests.filter((request) => request.url === url).map((request) => request.body);
    },
    count(url: string) {
      return server.requests.filter((request) => request.url === url).length;
    },
  };
  const byFile = options.citations ?? {};
  const byKey: Record<string, string[]> = {};
  for (const [path, keys] of Object.entries(byFile)) for (const key of keys) (byKey[key] ??= []).push(path);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    server.requests.push({ url, method, body });
    const json = async (handler: Handler | null) => {
      if (!handler) return Response.json({ error: "Not found" }, { status: 404 });
      const result = await handler(body);
      return result instanceof Response ? result : Response.json(result);
    };
    if (url === "/api/references/settings") return options.settings ? Response.json(options.settings) : Response.json({ error: "Not found" }, { status: 404 });
    if (url.startsWith("/api/references/citations")) return Response.json({ byFile, byKey });
    if (url.startsWith("/api/references/jobs?")) return Response.json({ jobs: [] });
    if (url === "/api/references/rewrite") return json(server.rewrite);
    if (url === "/api/references/bibliography") return json(server.bibliography);
    if (url === "/api/references/export") return server.exportResponse ? server.exportResponse(body) : Response.json({ error: "Not found" }, { status: 404 });
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

function treeWith(paths: string[]) {
  const tree = emptyTree();
  tree.notebooks = [{
    kind: "notebook", name: "Notes", path: "Notes", color: "#008888", emoji: "📓", groupId: null, createdAt: NOW, updatedAt: NOW,
    children: paths.map((path) => ({ kind: "file" as const, name: path.split("/").at(-1)!, path, notebook: "Notes", fileType: "markdown" as const, createdAt: NOW, updatedAt: NOW, size: 1 })),
  }];
  return tree;
}

async function settle(ms = 0) {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  }
}

async function waitFor(check: () => boolean, what: string) {
  for (let index = 0; index < 250 && !check(); index += 1) await settle(20);
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
  m.resetReferenceResolutionSession();
  m.resetReferenceJobs();
  m.resetLibraryStyles();
  m.resetReferencePreferences();
});

async function renderPanel(props: Partial<ReferencesPanelProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  const current: ReferencesPanelProps = {
    notebook: "Notes",
    tree: treeWith(["Notes/essay.md"]),
    activeMarkdownDraft: null,
    openDrafts: [],
    canCite: true,
    onCite: () => undefined,
    onOpenPath: () => undefined,
    ...props,
  };
  await act(async () => root.render(createElement(m.ReferencesPanel, current)));
  await settle();
  return { host };
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
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

function byLabel(host: ParentNode, label: string) {
  return host.querySelector(`[aria-label="${label}"]`);
}

function buttonByText(host: ParentNode, text: string | RegExp) {
  return [...host.querySelectorAll("button")].find((button) => typeof text === "string" ? button.textContent?.trim() === text : text.test(button.textContent?.trim() ?? ""));
}

function lastDialog() {
  return [...document.querySelectorAll("[role=dialog]")].at(-1)!;
}

function menu(host: ParentNode) {
  return host.querySelector('[role=menu][aria-label="References menu"]')!;
}

const STALE = "The file changed since the preview. Preview again to include it.";

// ---------------------------------------------------------------------------
// Update citations
// ---------------------------------------------------------------------------

test("after a key rename, Update citations previews with the notebook's open drafts, applies into open tabs, reports skips and undoes", async () => {
  const server = fakeServer(sampleLibrary(), { citations: { "Notes/essay.md": ["smith2020sparse"] } });
  server.rewrite = (body) => {
    if (body.undo) return { restored: ["Notes/essay.md"], skipped: [] };
    if (body.dryRun) {
      return {
        files: [
          { path: "Notes/draft.md", count: 1, excerpts: [{ line: 1, before: "Draft [@smith2020sparse]", after: "Draft [@smith2020]" }] },
          { path: "Notes/essay.md", count: 2, excerpts: [{ line: 3, before: "See [@smith2020sparse; @smith2020sparse].", after: "See [@smith2020; @smith2020]." }] },
        ],
        expected: { "Notes/essay.md": "hash-essay", "Notes/old.md": "hash-old" },
      };
    }
    return { rewriteId: "rw-1760000000000-abcdefabcdef", changed: ["Notes/essay.md"], skipped: [{ path: "Notes/old.md", reason: STALE }], draftEdits: { "Notes/draft.md": "Draft [@smith2020]" } };
  };
  const applied: Array<{ path: string; map: Record<string, string>; savedRewritten: boolean }> = [];
  const reverted: Array<{ path: string; refreshSaved: boolean; before: string }> = [];
  const openDrafts = [{ path: "Notes/draft.md", text: "Draft [@smith2020sparse]" }, { path: "Other/elsewhere.md", text: "[@smith2020sparse]" }];
  const { host } = await renderPanel({
    openDrafts,
    onApplyCitationRewrite: (path, map, options) => {
      applied.push({ path, map, savedRewritten: options.savedRewritten });
      return path === "Notes/draft.md" ? { before: "Draft [@smith2020sparse]", after: "Draft [@smith2020]" } : null;
    },
    onRevertCitationRewrite: (path, change, options) => { reverted.push({ path, refreshSaved: options.refreshSaved, before: change.before }); },
  });

  await click(host.querySelector('[data-entry-id="ref_smith"]'));
  assert.equal(byLabel(host, "Key renamed"), null, "nothing to offer before a rename");
  await click(buttonByText(host, "Rename key"));
  await type(byLabel(host, "New citation key"), "smith2020");
  await click(buttonByText(host, "Rename"));
  assert.deepEqual((server.bodies("/api/references").at(-1) as { ops: unknown[] }).ops, [{ op: "rename-key", id: "ref_smith", key: "smith2020" }]);
  await waitFor(() => Boolean(byLabel(host, "Key renamed")), "the card offers to update citations");
  await click(buttonByText(byLabel(host, "Key renamed")!, "Update citations…"));

  const dialog = lastDialog();
  await waitFor(() => Boolean(byLabel(dialog, "Documents to update")), "the preview lists the documents");
  assert.deepEqual(server.bodies("/api/references/rewrite")[0], { notebook: "Notes", map: { smith2020sparse: "smith2020" }, dryRun: true, drafts: { "Notes/draft.md": "Draft [@smith2020sparse]" } });
  assert.match(dialog.textContent ?? "", /Update citations of smith2020sparse/);
  assert.match(dialog.textContent ?? "", /3 citations in 2 documents/);
  const draftItem = dialog.querySelector('[data-path="Notes/draft.md"]')!;
  assert.match(draftItem.textContent ?? "", /unsaved changes included/);
  const essay = dialog.querySelector('[data-path="Notes/essay.md"]')!;
  assert.match(essay.textContent ?? "", /2 citations/);
  assert.equal(byLabel(essay, "Line 3")?.querySelector("del")?.textContent, "See [@smith2020sparse; @smith2020sparse].");
  assert.equal(byLabel(essay, "Line 3")?.querySelector("ins")?.textContent, "See [@smith2020; @smith2020].");

  const citationLoads = server.count("/api/references/citations?notebook=Notes");
  await click(buttonByText(dialog, "Update 3 citations"));
  await waitFor(() => Boolean(byLabel(dialog, "Update result")), "the result shows");
  assert.deepEqual(server.bodies("/api/references/rewrite")[1], {
    notebook: "Notes", map: { smith2020sparse: "smith2020" }, dryRun: false,
    expected: { "Notes/essay.md": "hash-essay", "Notes/old.md": "hash-old" }, drafts: { "Notes/draft.md": "Draft [@smith2020sparse]" },
  });
  assert.deepEqual(applied, [
    { path: "Notes/essay.md", map: { smith2020sparse: "smith2020" }, savedRewritten: true },
    { path: "Notes/draft.md", map: { smith2020sparse: "smith2020" }, savedRewritten: false },
  ]);
  assert.match(byLabel(dialog, "Update result")!.textContent ?? "", /Updated 1 saved document and 1 open tab\./);
  assert.match(byLabel(dialog, "Skipped documents")!.textContent ?? "", /old\.md: The file changed since the preview/);
  assert.ok(server.count("/api/references/citations?notebook=Notes") > citationLoads, "the citation index reloads");
  assert.ok(buttonByText(dialog, "Preview again"), "stale files can be previewed again");

  await click(buttonByText(dialog, "Undo"));
  await waitFor(() => Boolean(byLabel(dialog, "Undo result")), "the undo result shows");
  assert.deepEqual(server.bodies("/api/references/rewrite")[2], { notebook: "Notes", undo: "rw-1760000000000-abcdefabcdef" });
  assert.deepEqual(reverted, [{ path: "Notes/draft.md", refreshSaved: false, before: "Draft [@smith2020sparse]" }]);
  assert.match(byLabel(dialog, "Undo result")!.textContent ?? "", /Restored 1 saved document and 1 open tab/);
  await click(buttonByText(dialog, "Done"));
  assert.equal(document.querySelector("[role=dialog]"), null);
});

test("stale skips are previewed again, an empty preview says so, and errors can be retried", async () => {
  const server = fakeServer(sampleLibrary());
  let previews = 0;
  server.rewrite = (body) => {
    if (body.dryRun) {
      previews += 1;
      if (previews === 1) return Response.json({ error: "“nope” is not a key or alias in this notebook's references." }, { status: 400 });
      if (previews === 2) return { files: [{ path: "Notes/a.md", count: 1, excerpts: [] }], expected: { "Notes/a.md": "h1" } };
      return { files: [], expected: {} };
    }
    return { rewriteId: null, changed: [], skipped: [{ path: "Notes/a.md", reason: STALE }], draftEdits: {} };
  };
  // The dialog on its own, as the panel renders it.
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  let closed = 0;
  await act(async () => root.render(createElement(m.RewriteCitationsDialog, { notebook: "Notes", request: { id: 1, map: { old: "new" }, reason: { kind: "rename" } }, openDrafts: [], onClose: () => { closed += 1; } })));
  await settle();
  const dialog = lastDialog();
  assert.match(dialog.querySelector("[role=alert]")?.textContent ?? "", /not a key or alias/);
  await click(buttonByText(dialog, "Try again"));
  await waitFor(() => Boolean(buttonByText(dialog, "Update 1 citation")), "the preview shows");
  await click(buttonByText(dialog, "Update 1 citation"));
  await waitFor(() => Boolean(byLabel(dialog, "Update result")), "the result shows");
  assert.match(byLabel(dialog, "Update result")!.textContent ?? "", /No saved document was changed\./);
  assert.equal(buttonByText(dialog, "Undo"), undefined, "nothing to undo");
  await click(buttonByText(dialog, "Preview again"));
  await waitFor(() => /nothing to update/.test(dialog.textContent ?? ""), "the second preview is empty");
  await click(buttonByText(dialog, "Close"));
  assert.equal(closed, 1);
  await act(async () => root.unmount());
  assert.equal(m.isStaleSkip({ path: "x", reason: STALE }), true);
  assert.equal(m.isStaleSkip({ path: "x", reason: "The file is in a shared notebook and was left unchanged." }), false);
});

test("merging cited duplicates offers to rewrite every merged key and alias to the kept key, in the panel and in Manage", async () => {
  const server = fakeServer(sampleLibrary(), { citations: { "Notes/essay.md": ["gamma2010b"] } });
  server.rewrite = () => ({ files: [], expected: {} });
  const { host } = await renderPanel();
  assert.deepEqual(m.mergeRewriteMap(server.library.entries.ref_gamma, [server.library.entries.ref_gamma_b]), { gamma2010b: "gamma2010", gammaOld: "gamma2010" });

  const select = byLabel(host, "Filter references") as HTMLSelectElement;
  await act(async () => { select.value = "duplicates"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await settle();
  await click(buttonByText(host, /Merge/));
  const merge = lastDialog();
  await click(buttonByText(merge, /^Merge into gamma2010$/));
  await waitFor(() => server.bodies("/api/references/rewrite").length === 1, "the rewrite preview starts");
  assert.deepEqual(server.bodies("/api/references/rewrite")[0], { notebook: "Notes", map: { gamma2010b: "gamma2010", gammaOld: "gamma2010" }, dryRun: true, drafts: {} });
  assert.match(lastDialog().textContent ?? "", /Update citations to gamma2010/);
  assert.match(lastDialog().textContent ?? "", /now aliases of gamma2010/);
  await click(buttonByText(lastDialog(), "Close"));

  // In Manage: the rewrite dialog opens on top, and Escape closes only it.
  fakeServer(sampleLibrary(), { citations: { "Notes/essay.md": ["gamma2010b"] } }).rewrite = () => ({ files: [], expected: {} });
  await act(async () => mounted!.root.unmount());
  mounted = null;
  m.resetReferenceLibraryCache();
  const second = await renderPanel();
  await click(byLabel(second.host, "Manage references"));
  const manage = lastDialog();
  await click(buttonByText(manage, /Duplicates/));
  await click(buttonByText(byLabel(manage, "Duplicate groups")!, /Merge/));
  await click(buttonByText(lastDialog(), /^Merge into gamma2010$/));
  await waitFor(() => /Update citations to gamma2010/.test(lastDialog().textContent ?? ""), "Manage offers the rewrite");
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
  await settle();
  const titles = [...document.querySelectorAll("[role=dialog] h2")].map((heading) => heading.textContent);
  assert.ok(titles.some((title) => /Manage references|references/i.test(title ?? "")), "Manage stays open");
  assert.ok(!titles.some((title) => /Update citations/.test(title ?? "")), "the rewrite dialog closed");
});

test("merging entries nobody cites does not offer a rewrite", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  const select = byLabel(host, "Filter references") as HTMLSelectElement;
  await act(async () => { select.value = "duplicates"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await settle();
  await click(buttonByText(host, /Merge/));
  await click(buttonByText(lastDialog(), /^Merge into gamma2010$/));
  await settle(20);
  assert.equal(server.count("/api/references/rewrite"), 0);
  assert.equal(document.querySelector("[role=dialog]"), null);
});

// ---------------------------------------------------------------------------
// Formatted reference lists and bibliographies
// ---------------------------------------------------------------------------

function withClipboard(written: Array<Record<string, Blob>>) {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }
  Object.defineProperty(globalThis, "ClipboardItem", { value: FakeClipboardItem, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { write: async (items: FakeClipboardItem[]) => { written.push(items[0].items); } }, configurable: true });
  return () => {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    Reflect.deleteProperty(navigator, "clipboard");
  };
}

test("Copy reference list puts the whole library on the clipboard as text and HTML", async () => {
  const server = fakeServer(sampleLibrary());
  server.bibliography = (body) => body.format === "html"
    ? { text: '<div class="csl-entry">Gamma, A. (2010). <i>Gamma</i>.</div>', count: 3, unresolvedKeys: [] }
    : { text: "Gamma, A. (2010). Gamma.", count: 3, unresolvedKeys: [] };
  const written: Array<Record<string, Blob>> = [];
  const restore = withClipboard(written);
  try {
    const { host } = await renderPanel();
    await click(byLabel(host, "References menu"));
    await click(buttonByText(menu(host), "Copy reference list"));
    await waitFor(() => written.length === 1, "copied");
    assert.deepEqual(server.bodies("/api/references/bibliography").map((body) => body.format).sort(), ["html", "text"]);
    assert.ok(server.bodies("/api/references/bibliography").every((body) => body.notebook === "Notes" && !("documentText" in body)));
    assert.equal(await written[0]["text/plain"].text(), "Gamma, A. (2010). Gamma.");
    assert.match(await written[0]["text/html"].text(), /<i>Gamma<\/i>/);
    assert.match(host.textContent ?? "", /Reference list copied \(3 references\)\./);
  } finally {
    restore();
  }
});

test("Export reference list downloads the formatted file", async () => {
  const server = fakeServer(sampleLibrary());
  server.bibliography = () => new Response("# refs", { headers: { "Content-Disposition": "attachment; filename=\"Notes-references.md\"", "Content-Type": "text/markdown" } });
  const downloads: string[] = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  try {
    const { host } = await renderPanel();
    await click(byLabel(host, "References menu"));
    await click(byLabel(menu(host), "Export reference list as Markdown"));
    await waitFor(() => downloads.length === 1, "downloaded");
    assert.deepEqual(server.bodies("/api/references/bibliography"), [{ notebook: "Notes", format: "markdown", download: true }]);
    assert.deepEqual(downloads, ["Notes-references.md"]);
    assert.match(host.textContent ?? "", /Exported Notes-references\.md\./);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("For this document: disabled without citations; copy and export send the active draft and report unresolved keys", async () => {
  const server = fakeServer(sampleLibrary());
  const plain = await renderPanel({ activeDocumentPath: "Notes/essay.md", activeMarkdownDraft: "No citations." });
  await click(byLabel(plain.host, "References menu"));
  const copyButton = buttonByText(menu(plain.host), "Copy bibliography") as HTMLButtonElement;
  assert.equal(copyButton.disabled, true);
  assert.match(copyButton.title, /cites nothing yet/);
  assert.equal((byLabel(menu(plain.host), "Export bibliography as BibTeX") as HTMLButtonElement).disabled, true);
  await act(async () => mounted!.root.unmount());
  mounted = null;

  const draft = "As shown [@gamma2010; @missing2001].";
  server.bibliography = (body) => ({ text: body.format === "html" ? "<div>Gamma</div>" : "Gamma", count: 1, unresolvedKeys: ["missing2001"] });
  server.exportResponse = () => new Response("@article{gamma2010}", { headers: { "Content-Disposition": "attachment; filename=\"essay-bibliography.bib\"", "X-Libera-Unresolved-Keys": "missing2001,odd%20key" } });
  const written: Array<Record<string, Blob>> = [];
  const restore = withClipboard(written);
  const downloads: string[] = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  try {
    const { host } = await renderPanel({ activeDocumentPath: "Notes/essay.md", activeMarkdownDraft: draft });
    await settle(350);
    await click(byLabel(host, "References menu"));
    await click(buttonByText(menu(host), "Copy bibliography"));
    await waitFor(() => written.length === 1, "copied");
    assert.ok(server.bodies("/api/references/bibliography").every((body) => body.documentText === draft));
    assert.match(host.querySelector("[role=alert]")?.textContent ?? "", /Bibliography copied \(1 reference\)\. 1 cited key is not in the library: missing2001\./);

    await click(byLabel(host, "References menu"));
    await click(byLabel(menu(host), "Export bibliography as BibTeX"));
    await waitFor(() => downloads.length === 1, "downloaded");
    assert.deepEqual(server.bodies("/api/references/export"), [{ notebook: "Notes", format: "bibtex", documentText: draft, documentName: "Notes/essay.md" }]);
    assert.deepEqual(downloads, ["essay-bibliography.bib"]);
    assert.match(host.querySelector("[role=alert]")?.textContent ?? "", /Exported essay-bibliography\.bib\. 2 cited keys are not in the library: missing2001, odd key\./);

    await click(byLabel(host, "References menu"));
    await click(byLabel(menu(host), "Export bibliography as Formatted html"));
    await waitFor(() => downloads.length === 2, "downloaded the formatted list");
    assert.deepEqual(server.bodies("/api/references/bibliography").at(-1), { notebook: "Notes", format: "html", documentText: draft, documentName: "Notes/essay.md", download: true });
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    restore();
  }
  assert.deepEqual(m.unresolvedKeysHeader(null), []);
  assert.equal(m.unresolvedNote([]), "");
});

// ---------------------------------------------------------------------------
// Preference defaults
// ---------------------------------------------------------------------------

test("the panel's toggles start from the Preferences defaults, read once per session, and the session choice still wins", async () => {
  const server = fakeServer(sampleLibrary(), { settings: { lookupOnline: true, useAi: true, webSearch: true, autoCreateForPdfs: true } });
  const requests: unknown[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener(FACT_CHECK_REQUEST_EVENT, listener);
  try {
    const { host } = await renderPanel({ activeDocumentPath: "Notes/essay.md", activeMarkdownDraft: "See [@gamma2010]." });
    await settle(350);
    await click(byLabel(host, "Add references"));
    const toggle = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("Search the web"))!;
    assert.equal(toggle.checked, true, "on, as in Preferences");
    assert.match(byLabel(host, "Web search default")?.textContent ?? "", /on in Preferences/);

    await click(byLabel(host, "References menu"));
    assert.equal(byLabel(menu(host), "Create entries for new PDFs automatically")!.querySelector('[aria-checked="true"]')?.textContent, "Follow Preferences (on)");
    await click(buttonByText(menu(host), /Fact-check citations/));
    const popover = byLabel(host, "Fact-check citations")!;
    assert.equal((popover.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, true);
    await click(buttonByText(popover, "Cancel"));

    // The session choice overrides the preference.
    await act(async () => toggle.click());
    await settle();
    assert.equal(toggle.checked, false);
    assert.equal(byLabel(host, "Web search default"), null);
    await click(byLabel(host, "References menu"));
    await click(buttonByText(menu(host), /Fact-check citations/));
    assert.equal((byLabel(host, "Fact-check citations")!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, false);
    assert.equal(server.count("/api/references/settings"), 1, "read once");
  } finally {
    window.removeEventListener(FACT_CHECK_REQUEST_EVENT, listener);
  }
  // Remounting reuses the session's read.
  await act(async () => mounted!.root.unmount());
  mounted = null;
  m.resetReferenceResolutionSession();
  await renderPanel();
  assert.equal(server.count("/api/references/settings"), 1);
  assert.equal(m.cachedReferencePreferences()?.webSearch, true);
});

test("preference reads: a failure is not cached, invalid bodies are ignored, and secrets are never asked for", async () => {
  let answer: Response = Response.json({ error: "nope" }, { status: 500 });
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { urls.push(String(input)); return answer; }) as typeof fetch;
  assert.equal(await m.fetchReferencePreferences(), null);
  answer = Response.json({ lookupOnline: true, useAi: "yes", webSearch: false, autoCreateForPdfs: false });
  assert.equal(await m.fetchReferencePreferences(), null);
  answer = Response.json({ lookupOnline: false, useAi: true, webSearch: false, autoCreateForPdfs: true, contactEmail: "x@example.org" });
  assert.deepEqual(await m.fetchReferencePreferences(), { lookupOnline: false, useAi: true, webSearch: false, autoCreateForPdfs: true });
  assert.deepEqual(await m.fetchReferencePreferences(), { lookupOnline: false, useAi: true, webSearch: false, autoCreateForPdfs: true });
  assert.equal(urls.length, 3);
});

test("GET /api/references/settings returns the four flags and nothing else, behind auth", async () => {
  const { GET } = await import("../../src/app/api/references/settings/route");
  const { NextRequest } = await import("next/server");
  const keys = ["LIBERA_CONFIG_PATH", "LIBERA_REFERENCES_WEB_SEARCH", "LIBERA_REFERENCES_CONTACT_EMAIL", "LIBERA_REFERENCES_AUTO_CREATE_PDFS"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.LIBERA_CONFIG_PATH;
    process.env.LIBERA_REFERENCES_WEB_SEARCH = "true";
    process.env.LIBERA_REFERENCES_CONTACT_EMAIL = "me@example.org";
    process.env.LIBERA_REFERENCES_AUTO_CREATE_PDFS = "false";
    const { SESSION_COOKIE_NAME, createSessionToken } = await import("../../src/lib/auth");
    assert.equal((await GET(new NextRequest("http://localhost/api/references/settings"))).status, 401);
    const response = await GET(new NextRequest("http://localhost/api/references/settings", { headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { lookupOnline: true, useAi: true, webSearch: true, autoCreateForPdfs: false });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Fact-check on untitled drafts
// ---------------------------------------------------------------------------

test("the source toolbar disables Fact-check citations for untitled drafts, with a tooltip", () => {
  const props = {
    files: [], documentPath: "Untitled 1.md", canStartScreenshotSnip: false, markdownBaseFontSize: 16, markdownContent: "See [@gamma2010].", markdownZoom: 1,
    onEnumerateHeadings: () => undefined, onFixChatGptEquations: () => undefined, onInsert: () => undefined, onInsertTable: () => undefined, onInsertExistingImage: () => undefined,
    onInsertImage: async () => undefined, onMarkdownZoomChange: () => undefined, onStartScreenshotSnip: () => undefined, onTogglePreviewFullscreen: () => undefined,
    onOpenFileLink: async () => false, previewFullscreen: false,
  };
  const factCheck = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.querySelector('[aria-label="Fact-check citations"]') as HTMLButtonElement;
  };
  const untitled = factCheck(renderToStaticMarkup(createElement(m.MarkdownToolbar, { ...props, untitled: true })));
  assert.equal(untitled.disabled, true);
  assert.equal(untitled.title, "Save the document first");
  const saved = factCheck(renderToStaticMarkup(createElement(m.MarkdownToolbar, { ...props, documentPath: "Notes/essay.md" })));
  assert.equal(saved.disabled, false);
  assert.match(saved.title, /checks each citation/);
});
