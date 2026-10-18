import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { emptyTree } from "../../src/components/libera/api-client";
import type { ReferencesPanelProps } from "../../src/components/libera/references/references-panel";
import type { ReferenceJobStatus } from "../../src/lib/references/jobs-types";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import {
  FACT_CHECK_REQUEST_EVENT,
  type CslItem,
  type FieldProvenance,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
} from "../../src/lib/references/types";
import type { LiberaFileNode, LiberaTree } from "../../src/lib/types";

// The resolution UI of the References panel: lookups in the Add box, the
// candidate confirmation cards, drops, background jobs, the automatic PDF
// setting, re-resolve, formatting and copy, import renames, the fact-check
// entry point and the privacy notice. The reference API is a fake: library
// routes run the real pure ops; resolve, jobs, import and files are scripted.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement", "Element", "Node", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
after(() => dom.window.close());

async function loadModules() {
  const [client, panel, library, undo, candidates, jobs, dialog] = await Promise.all([
    import("react-dom/client"),
    import("../../src/components/libera/references/references-panel"),
    import("../../src/components/libera/references/use-reference-library"),
    import("../../src/components/libera/references/use-reference-undo"),
    import("../../src/components/libera/references/reference-candidates"),
    import("../../src/components/libera/references/use-reference-jobs"),
    import("../../src/components/libera/references/manage-references-dialog"),
  ]);
  return { ...client, ...panel, ...library, ...undo, ...candidates, ...jobs, ...dialog };
}
let m: Awaited<ReturnType<typeof loadModules>>;
before(async () => {
  m = await loadModules();
});

const NOW = "2026-10-01T00:00:00.000Z";
const crossref: FieldProvenance = { source: "crossref", confidence: 0.95, retrievedAt: NOW };
const llm: FieldProvenance = { source: "llm", confidence: 0.5, retrievedAt: NOW };
const user: FieldProvenance = { source: "user", confidence: 1, retrievedAt: NOW };

function makeEntry(id: string, key: string, csl: CslItem, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl, identifiers: {}, provenance: {}, status: "confirmed", attachments: [],
    createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

function libraryOf(entries: ReferenceEntry[], extra: Partial<ReferenceLibrary> = {}): ReferenceLibrary {
  return { ...emptyReferenceLibrary(), revision: 1, entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])), ...extra };
}

function sampleLibrary() {
  return libraryOf([
    makeEntry("ref_godel", "godel1931", {
      type: "article-journal", title: "On formally undecidable propositions", author: [{ family: "Gödel", given: "Kurt" }],
      issued: { "date-parts": [[1931]] }, "container-title": "Monatshefte für Mathematik",
    }, { attachments: [{ kind: "pdf", path: "Notes/papers/godel.pdf" }] }),
    makeEntry("ref_smith", "smith2020sparse", {
      type: "article-journal", title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }],
      issued: { "date-parts": [[2020]] }, "container-title": "Journal of Sparse Things", DOI: "10.1000/sparse",
    }, { identifiers: { doi: "10.1000/sparse" } }),
    makeEntry("ref_preprint", "lee2021dense", {
      type: "article", title: "Dense retrieval at scale", author: [{ family: "Lee", given: "Kim" }],
      issued: { "date-parts": [[2021]] }, publisher: "arXiv",
    }, { identifiers: { arxiv: "2101.00001" }, status: "needs-review" }),
  ]);
}

type Request = { url: string; method: string; body: unknown; signal?: AbortSignal | null };
type Handler = (body: Record<string, unknown>, request: Request) => unknown;

function makeJob(patch: Partial<ReferenceJobStatus> = {}): ReferenceJobStatus {
  return {
    id: "job_1", notebook: "Notes", kind: "resolve-pdfs", state: "running", total: 12, done: 2, failed: 0, current: "Notes/papers/third.pdf",
    createdEntryIds: [], updatedEntryIds: [], errors: [], webSearch: false, createdAt: NOW, ...patch,
  };
}

/** A request that never answers until it is aborted. */
function pending(request: Request) {
  return new Promise<never>((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

function fakeServer(library: ReferenceLibrary) {
  const server = {
    library,
    requests: [] as Request[],
    resolve: null as Handler | null,
    jobs: [] as ReferenceJobStatus[],
    postJob: null as Handler | null,
    importResult: null as Handler | null,
    files: {} as Record<string, string>,
    patches(): ReferenceLibraryOp[][] {
      return server.requests.filter((request) => request.method === "PATCH").map((request) => (request.body as { ops: ReferenceLibraryOp[] }).ops);
    },
    count(prefix: string, method = "GET") {
      return server.requests.filter((request) => request.url.startsWith(prefix) && request.method === method).length;
    },
    bodies(url: string) {
      return server.requests.filter((request) => request.url === url).map((request) => request.body as Record<string, unknown>);
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const request: Request = { url, method, body, signal: init?.signal };
    server.requests.push(request);
    const json = async (handler: Handler | null) => {
      if (!handler) return Response.json({ error: "Not found" }, { status: 404 });
      const result = await handler(body, request);
      return result instanceof Response ? result : Response.json(result);
    };
    if (url.startsWith("/api/references/citations")) return Response.json({ byFile: {}, byKey: {} });
    if (url === "/api/references/resolve") return json(server.resolve);
    if (url.startsWith("/api/references/jobs?")) return Response.json({ jobs: server.jobs });
    if (url === "/api/references/jobs") return json(server.postJob);
    if (url === "/api/references/import") return json(server.importResult);
    if (url.startsWith("/api/files?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      return path in server.files ? Response.json({ content: server.files[path] }) : Response.json({ error: "Not found" }, { status: 404 });
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

function result(candidates: ReferenceEntryInput[], extra: Record<string, unknown> = {}) {
  return { candidates, duplicates: [], updates: [], warnings: [], ...extra };
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
});

async function renderPanel(props: Partial<ReferencesPanelProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  mounted = { root, host };
  const current: ReferencesPanelProps = {
    notebook: "Notes",
    tree: treeWith([]),
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

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
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

const treeDrop = (path: string) => ({ types: ["application/x-libera-file-path"], getData: (type: string) => type === "application/x-libera-file-path" ? path : "" });

async function lookUp(host: HTMLElement, text: string) {
  if (!byLabel(host, "Reference to add")) await click(byLabel(host, "Add references"));
  await type(byLabel(host, "Reference to add"), text);
  await click(buttonByText(host, /^Look up/));
}

function webToggle(host: ParentNode) {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("Search the web"))!;
}

function lastAdd(server: ReturnType<typeof fakeServer>) {
  return (server.patches().at(-1)!.find((op) => op.op === "add") as Extract<ReferenceLibraryOp, { op: "add" }>).entry;
}

// ---------------------------------------------------------------------------
// The Add box
// ---------------------------------------------------------------------------

test("the Add box sends what it classified to /resolve, with the web toggle, and shows the warnings", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([{ csl: { type: "book", title: "A found book", ISBN: "9780262033848" }, provenance: { title: crossref }, status: "needs-review" }], { warnings: ["Open Library did not answer."] });
  const { host } = await renderPanel();
  await click(byLabel(host, "Add references"));
  assert.equal(webToggle(host).checked, false, "off, because the preference cannot be read here");
  assert.match(byLabel(host, "Web search default")?.textContent ?? "", /can't be read/);

  await type(byLabel(host, "Reference to add"), "ISBN 978-0-262-03384-8");
  assert.match(host.textContent ?? "", /Detected: ISBN/);
  await click(buttonByText(host, "Look up"));
  assert.deepEqual(server.bodies("/api/references/resolve").at(-1), { notebook: "Notes", input: "ISBN 978-0-262-03384-8", webSearch: false });
  assert.match(byLabel(host, "Lookup warnings")?.textContent ?? "", /Open Library did not answer/);

  await click(byLabel(host, "Back to the input"));
  await act(async () => webToggle(host).click());
  await settle();
  await click(buttonByText(host, "Look up"));
  assert.equal(server.bodies("/api/references/resolve").at(-1)?.webSearch, true);
  assert.equal(byLabel(host, "Web search default"), null, "the note goes once the user chose");

  // The choice holds for the session.
  await click(byLabel(host, "Close add box"));
  await click(byLabel(host, "Add references"));
  assert.equal(webToggle(host).checked, true);
});

test("a lookup shows its progress and is cancelled by Cancel, by new input and by closing the box", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = (_body, request) => pending(request);
  const { host } = await renderPanel();
  const signals = () => server.requests.filter((request) => request.url === "/api/references/resolve").map((request) => request.signal!);

  await lookUp(host, "10.1000/one");
  assert.match(byLabel(host, "Lookup progress")?.textContent ?? "", /Looking up/);
  await click(buttonByText(byLabel(host, "Lookup progress")!, "Cancel"));
  assert.equal(signals()[0].aborted, true, "Cancel aborts the request");
  assert.equal(byLabel(host, "Lookup progress"), null);
  assert.equal(host.querySelector("[role=alert]"), null, "a cancelled lookup is not an error");

  await click(buttonByText(host, "Look up"));
  assert.equal(signals()[1].aborted, false);
  await type(byLabel(host, "Reference to add"), "10.1000/two");
  assert.equal(signals()[1].aborted, true, "new input aborts the lookup in flight");

  await click(buttonByText(host, "Look up"));
  await click(byLabel(host, "Close add box"));
  assert.equal(signals()[2].aborted, true, "closing the box aborts it");
  assert.equal(server.patches().length, 0);
});

test("the privacy notice shows on the first online lookup of the session only, and links to Preferences", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([]);
  const opened: Array<string | undefined> = [];
  Object.defineProperty(window, "liberaPreferences", { value: { open: async (section?: string) => { opened.push(section); } }, configurable: true });
  try {
    const { host } = await renderPanel();
    assert.equal(byLabel(host, "Online lookups"), null);
    await lookUp(host, "10.1000/one");
    const notice = byLabel(host, "Online lookups")!;
    assert.match(notice.textContent ?? "", /Crossref, OpenAlex, arXiv, PubMed and Open Library/);
    assert.match(notice.textContent ?? "", /first pages of a PDF are sent to your AI provider/);
    await click(buttonByText(notice, "Preferences"));
    assert.deepEqual(opened, ["ai"]);
    await click(byLabel(notice, "Dismiss notice"));
    await click(byLabel(host, "Back to the input"));
    await click(buttonByText(host, "Look up"));
    assert.equal(byLabel(host, "Online lookups"), null, "shown once per session");

    // Not again after the panel remounts.
    await act(async () => mounted!.root.unmount());
    mounted = null;
    const second = await renderPanel();
    await lookUp(second.host, "10.1000/two");
    assert.equal(byLabel(second.host, "Online lookups"), null);
  } finally {
    Reflect.deleteProperty(window, "liberaPreferences");
  }
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test("a candidate card shows the formatted reference and provenance, and conflicts are settled before adding", async () => {
  const server = fakeServer(sampleLibrary());
  const web: FieldProvenance = { source: "llm-web", confidence: 0.6, url: "https://example.org/page", retrievedAt: NOW };
  server.resolve = () => result([{
    csl: { type: "article-journal", title: "Deep sparse nets", author: [{ family: "Ito", given: "Ken" }], issued: { "date-parts": [[2022]] }, "container-title": "Natur" },
    provenance: { title: crossref, author: crossref, issued: crossref, "container-title": web },
    conflicts: { "container-title": [{ value: "Nature", provenance: crossref }] },
    status: "needs-review",
  }]);
  const { host } = await renderPanel();
  await lookUp(host, "10.1000/deep");
  const card = byLabel(host, "Candidate 1")!;
  await waitFor(() => card.querySelector('[data-formatted="citeproc"]') !== null, "the candidate is formatted in the notebook's style");
  assert.match(byLabel(card, "Formatted reference")?.textContent ?? "", /Ito, K\. \(2022\)\. Deep sparse nets\./);
  assert.equal(card.querySelector('[data-field="title"] .libera-reference-chip')?.textContent, "Crossref");
  assert.equal(card.querySelector('[data-field="container-title"] dt .libera-reference-chip')?.textContent, "LLM + web");

  const confirm = buttonByText(card, /Add & confirm/) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  assert.match(byLabel(card, "Why it cannot be confirmed")?.textContent ?? "", /Sources disagree on published in/);

  await click(byLabel(card, "Use Nature from Crossref"));
  assert.equal((buttonByText(card, /Add & confirm/) as HTMLButtonElement).disabled, false, "every field is now authoritative and confident");
  await click(buttonByText(card, /Add & confirm/));
  const entry = lastAdd(server);
  assert.equal(entry.csl["container-title"], "Nature");
  assert.deepEqual(entry.provenance?.["container-title"], crossref);
  assert.equal(entry.conflicts, undefined);
  assert.equal(entry.status, "confirmed");
});

test("Add & confirm needs every field from an authoritative source at confidence 0.9 or more; Add keeps the returned status", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([{
    csl: { type: "report", title: "A grey report", issued: { "date-parts": [[2019]] } },
    provenance: { title: crossref, issued: llm },
    status: "unresolved",
  }]);
  const { host } = await renderPanel();
  await lookUp(host, "A grey report, 2019");
  const card = byLabel(host, "Candidate 1")!;
  assert.equal((buttonByText(card, /Add & confirm/) as HTMLButtonElement).disabled, true);
  assert.match(byLabel(card, "Why it cannot be confirmed")?.textContent ?? "", /Date comes from LLM/i);
  assert.equal(m.confirmBlocker({ csl: { type: "book", title: "T" }, provenance: { title: { ...crossref, confidence: 0.8 } } }), "Title has confidence 80%, below 90%.");
  assert.equal(m.confirmBlocker({ csl: { type: "book", title: "T" }, provenance: { title: crossref } }), null);
  // An identifier copied into the item without a source counts when it is one of the candidate's identifiers.
  // Identifiers need a source too: the server records one for those it copies into the item (references-moves-ui-provenance.test.ts).
  assert.equal(m.confirmBlocker({ csl: { type: "book", title: "T", PMID: "26017442" }, identifiers: { pmid: "26017442" }, provenance: { title: crossref } }), "PMID has no source.");
  assert.equal(m.confirmBlocker({ csl: { type: "book", title: "T", PMID: "26017442" }, identifiers: { pmid: "26017442" }, provenance: { title: crossref, PMID: crossref } }), null);
  assert.equal(m.confirmBlocker({ csl: { type: "book", title: "T", PMID: "1" }, identifiers: { pmid: "2" }, provenance: { title: crossref } }), "PMID has no source.");
  await click(buttonByText(card, /^Add$/));
  assert.equal(lastAdd(server).status, "unresolved");
});

test("a duplicate candidate offers attach to existing, merge into existing, or add anyway", async () => {
  const server = fakeServer(sampleLibrary());
  const candidate: ReferenceEntryInput = {
    csl: { type: "article-journal", title: "Sparse attention for long documents", DOI: "10.1000/sparse", volume: "4", page: "1–10" },
    identifiers: { doi: "10.1000/sparse" },
    provenance: { title: crossref, DOI: crossref, volume: crossref, page: crossref },
    attachments: [{ kind: "pdf", path: "Notes/inbox/sparse.pdf" }],
    status: "needs-review",
  };
  server.resolve = () => result([candidate], { duplicates: [{ candidateIndex: 0, entryId: "ref_smith", reason: "doi", score: 1 }] });
  const { host } = await renderPanel();

  await lookUp(host, "10.1000/sparse");
  assert.match(host.textContent ?? "", /Already in your library as smith2020sparse/);
  await click(buttonByText(host, /Attach to existing/));
  assert.deepEqual(server.patches().at(-1), [{ op: "attach", id: "ref_smith", attachment: { kind: "pdf", path: "Notes/inbox/sparse.pdf" } }]);
  assert.ok(byLabel(host, "Reference smith2020sparse"), "the existing entry is revealed");
  assert.equal(Object.keys(server.library.entries).length, 3);

  await click(byLabel(host, "Back to references"));
  server.library = sampleLibrary();
  server.library.revision = 10;
  await act(async () => { await m.fetchReferenceLibrary("Notes"); });
  await lookUp(host, "10.1000/sparse");
  await click(buttonByText(host, /Merge into existing/));
  const [update, attach] = server.patches().at(-1)!;
  assert.deepEqual(update, { op: "update", id: "ref_smith", csl: { volume: "4", page: "1–10" }, provenance: { volume: crossref, page: crossref } }, "only the missing fields, as mergeEntryFields fills them");
  assert.deepEqual(attach, { op: "attach", id: "ref_smith", attachment: { kind: "pdf", path: "Notes/inbox/sparse.pdf" } });
  assert.equal(server.library.entries.ref_smith.csl.title, "Sparse attention for long documents");

  await click(byLabel(host, "Back to references"));
  await lookUp(host, "10.1000/sparse");
  await click(buttonByText(host, /Add anyway/));
  assert.equal(lastAdd(server).csl.title, "Sparse attention for long documents");
  assert.equal(Object.keys(server.library.entries).length, 4);
});

test("a published version of a preprint in the library is explained and merges as one work", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([{
    csl: { type: "article-journal", title: "Dense retrieval at scale", author: [{ family: "Lee", given: "Kim" }], issued: { "date-parts": [[2022]] }, "container-title": "Journal of Retrieval", DOI: "10.5555/dense" },
    identifiers: { doi: "10.5555/dense", arxiv: "2101.00001" },
    provenance: { title: crossref, author: crossref, issued: crossref, "container-title": crossref, DOI: crossref },
    status: "needs-review",
  }], { duplicates: [{ candidateIndex: 0, entryId: "ref_preprint", reason: "preprint-published", score: 0.88, preprintPair: true }] });
  const { host } = await renderPanel();
  await lookUp(host, "10.5555/dense");
  const explanation = host.querySelector('[data-preprint="entry"]');
  assert.match(explanation?.textContent ?? "", /published version of lee2021dense, a preprint/);
  assert.match(explanation?.textContent ?? "", /keeps the key/);
  await click(buttonByText(host, /Merge into existing/));
  const [update] = server.patches().at(-1)! as Array<Extract<ReferenceLibraryOp, { op: "update" }>>;
  assert.equal(update.id, "ref_preprint");
  assert.equal(update.csl?.["container-title"], "Journal of Retrieval");
  assert.equal(update.csl?.type, "article-journal");
  assert.deepEqual(update.versions, [{ relation: "published-as", identifier: "10.5555/dense" }]);
  assert.equal(server.library.entries.ref_preprint.key, "lee2021dense", "one work, one key");
});

test("updates from a lookup apply after confirmation: alone with Attach, or with the added candidate", async () => {
  const server = fakeServer(sampleLibrary());
  const attach: ReferenceLibraryOp = { op: "attach", id: "ref_godel", attachment: { kind: "markdown", path: "Notes/papers/godel.md" } };
  server.resolve = (body) => body.path === "Notes/papers/godel.md"
    ? result([], { updates: [attach] })
    : result([{ csl: { type: "manuscript", title: "Reading notes" }, provenance: { title: llm }, attachments: [{ kind: "markdown", path: "Notes/notes.md" }] }], { updates: [attach] });
  const { host } = await renderPanel();
  const panel = host.querySelector(".libera-references-panel")!;

  await drop(panel, treeDrop("Notes/papers/godel.md"));
  assert.deepEqual(server.bodies("/api/references/resolve").at(-1), { notebook: "Notes", path: "Notes/papers/godel.md", webSearch: false });
  assert.match(byLabel(host, "Updates")?.textContent ?? "", /Attach godel\.md to godel1931/);
  assert.equal(server.patches().length, 0, "nothing applies before confirmation");
  await click(buttonByText(byLabel(host, "Updates")!, /Attach/));
  assert.deepEqual(server.patches().at(-1), [attach]);
  assert.ok(byLabel(host, "Reference godel1931"));

  await click(byLabel(host, "Back to references"));
  await drop(panel, treeDrop("Notes/notes.md"));
  await click(buttonByText(host, /^Add$/));
  const ops = server.patches().at(-1)!;
  assert.deepEqual(ops.map((op) => op.op), ["add", "attach"], "one transaction");
});

test("a looked-up candidate can be edited before adding; unchanged fields keep their sources", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([{
    csl: { type: "article-journal", title: "Almost right", "container-title": "Journal of Edits" },
    provenance: { title: crossref, "container-title": crossref },
    identifiers: { doi: "10.1/edit" },
  }]);
  const { host } = await renderPanel();
  await lookUp(host, "10.1/edit");
  await click(buttonByText(host, /Edit before adding/));
  const form = document.querySelector('form[aria-label="New reference"]')!;
  assert.equal((form.querySelector("#reference-field-title") as HTMLInputElement).value, "Almost right");
  await type(form.querySelector("#reference-field-title"), "Exactly right");
  await click(buttonByText(document.querySelector("[role=dialog]")!, "Add reference"));
  const entry = lastAdd(server);
  assert.equal(entry.csl.title, "Exactly right");
  assert.equal(entry.provenance?.title?.source, "user");
  assert.deepEqual(entry.provenance?.["container-title"], crossref);
  assert.equal(entry.identifiers?.doi, "10.1/edit");
});

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

test("a dropped PDF is looked up by path and confirmed; a failed lookup falls back to an unresolved entry", async () => {
  const server = fakeServer(sampleLibrary());
  server.resolve = () => result([{
    csl: { type: "article-journal", title: "Attention is all you need" },
    provenance: { title: crossref },
    attachments: [{ kind: "pdf", path: "Notes/papers/attention.pdf" }],
    status: "needs-review",
  }]);
  const { host } = await renderPanel();
  const panel = host.querySelector(".libera-references-panel")!;
  await drop(panel, treeDrop("Notes/papers/attention.pdf"));
  assert.deepEqual(server.bodies("/api/references/resolve").at(-1), { notebook: "Notes", path: "Notes/papers/attention.pdf", webSearch: false });
  await click(buttonByText(host, /^Add$/));
  assert.deepEqual(lastAdd(server).attachments, [{ kind: "pdf", path: "Notes/papers/attention.pdf" }]);
  assert.equal(lastAdd(server).csl.title, "Attention is all you need");

  await click(byLabel(host, "Back to references"));
  server.resolve = () => Response.json({ error: "The PDF has no text layer." }, { status: 422 });
  await drop(panel, treeDrop("Notes/papers/scan.pdf"));
  assert.deepEqual(lastAdd(server), { csl: { type: "document", title: "scan" }, status: "unresolved", attachments: [{ kind: "pdf", path: "Notes/papers/scan.pdf" }] });
  assert.match(host.querySelector("[role=alert]")?.textContent ?? "", /scan\.pdf could not be looked up \(The PDF has no text layer\)/);
});

test("several dropped PDFs are read by one background job", async () => {
  const server = fakeServer(sampleLibrary());
  server.postJob = () => {
    server.jobs = [makeJob({ id: "job_paths", kind: "resolve-paths", state: "queued", total: 2, done: 0, current: undefined })];
    return { job: server.jobs[0] };
  };
  const { host } = await renderPanel({
    onUploadFiles: async (_notebook, files) => files.map((file) => ({ kind: "file", name: file.name, path: `Notes/${file.name}`, notebook: "Notes", fileType: "pdf", createdAt: NOW, updatedAt: NOW, size: 1 } satisfies LiberaFileNode)),
  });
  await drop(host.querySelector(".libera-references-panel")!, { types: ["Files"], files: [new File(["%PDF"], "a.pdf"), new File(["%PDF"], "b.pdf")] });
  assert.deepEqual(server.bodies("/api/references/jobs"), [{ notebook: "Notes", action: "resolve-paths", paths: ["Notes/a.pdf", "Notes/b.pdf"], webSearch: false }]);
  assert.equal(server.count("/api/references/resolve", "POST"), 0, "not resolved one by one");
  assert.match(byLabel(host, "Background lookup")?.textContent ?? "", /Waiting to read files/);
  assert.equal(server.patches().length, 0);
});

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

test("Generate entries for PDFs starts a job, polls only while it runs, reloads the library live and summarizes it", async () => {
  m.setReferenceJobPollInterval(30);
  const server = fakeServer(sampleLibrary());
  let job = makeJob({ state: "queued", total: 0, done: 0, current: undefined });
  server.postJob = (body) => {
    if (body.action === "cancel") return { job };
    assert.deepEqual(body, { notebook: "Notes", action: "resolve-pdfs", webSearch: false });
    server.jobs = [job];
    return { job };
  };
  const { host } = await renderPanel();
  assert.equal(server.count("/api/references/jobs?"), 1, "one look on mount");
  await settle(80);
  assert.equal(server.count("/api/references/jobs?"), 1, "no polling while nothing runs");

  await click(byLabel(host, "Generate entries for PDFs without one"));
  assert.match(byLabel(host, "Background lookup")?.textContent ?? "", /Waiting to read PDFs/);
  assert.equal((byLabel(host, "Generate entries for PDFs without one") as HTMLButtonElement).disabled, true);

  // Progress, and a new entry appears as soon as the job reports it.
  const added = applyLibraryOps(server.library, [{ op: "add", entry: { key: "new2024", csl: { type: "article-journal", title: "Found in a PDF" }, status: "needs-review" } }], NOW).library;
  server.library = { ...added, revision: server.library.revision + 1 };
  const newId = Object.keys(server.library.entries).find((id) => !["ref_godel", "ref_smith", "ref_preprint"].includes(id))!;
  job = makeJob({ total: 12, done: 2, current: "Notes/papers/third.pdf", createdEntryIds: [newId] });
  server.jobs = [job];
  await waitFor(() => /Reading 3 of 12 PDFs… third\.pdf/.test(byLabel(host, "Background lookup")?.textContent ?? ""), "progress line");
  await waitFor(() => rowKeys(host).includes("new2024"), "the library reloads when the counts change");

  // Finished.
  const confirmed = applyLibraryOps(server.library, [{ op: "update", id: "ref_godel", status: "confirmed" }], NOW).library;
  server.library = { ...confirmed, revision: server.library.revision + 1 };
  job = makeJob({ state: "done", total: 12, done: 11, failed: 1, current: undefined, createdEntryIds: [newId], updatedEntryIds: ["ref_godel"], errors: [{ path: "Notes/papers/broken.pdf", message: "No text layer" }], finishedAt: NOW });
  server.jobs = [job];
  await waitFor(() => /1 new entry · 1 needs review · 1 failed/.test(byLabel(host, "Background lookup")?.textContent ?? ""), "the summary");
  const polls = server.count("/api/references/jobs?");
  await settle(100);
  assert.equal(server.count("/api/references/jobs?"), polls, "polling stops when no job is active");

  const status = byLabel(host, "Background lookup")!;
  await click(buttonByText(status, "Show errors"));
  assert.match(byLabel(host, "Job errors")?.textContent ?? "", /broken\.pdf: No text layer/);
  await click(buttonByText(status, "Review new entries"));
  assert.deepEqual(rowKeys(host).sort(), ["godel1931", "new2024"]);
  assert.match(byLabel(host, "Temporary filter")?.textContent ?? "", /New from the PDF lookup \(2\)/);
  await click(byLabel(host, "Clear the new-entries filter"));
  assert.equal(rowKeys(host).length, 4);
});

test("a running job can be cancelled", async () => {
  m.setReferenceJobPollInterval(30);
  const server = fakeServer(sampleLibrary());
  server.jobs = [makeJob()];
  server.postJob = (body) => {
    assert.deepEqual(body, { notebook: "Notes", action: "cancel", jobId: "job_1" });
    server.jobs = [makeJob({ state: "cancelled", done: 2, createdEntryIds: [], finishedAt: NOW })];
    return { job: server.jobs[0] };
  };
  const { host } = await renderPanel();
  await waitFor(() => /Reading 3 of 12/.test(byLabel(host, "Background lookup")?.textContent ?? ""), "a job started elsewhere is picked up");
  await click(buttonByText(byLabel(host, "Background lookup")!, "Cancel"));
  await waitFor(() => /Stopped: 0 new entries · 0 need review · 0 failed/.test(byLabel(host, "Background lookup")?.textContent ?? ""), "the stopped summary");
  await click(byLabel(byLabel(host, "Background lookup")!, "Dismiss"));
  assert.equal(byLabel(host, "Background lookup"), null);
});

test("job progress and summary texts", () => {
  assert.equal(m.jobProgressText(makeJob({ state: "queued" })), "Waiting to read PDFs…");
  assert.equal(m.jobProgressText(makeJob({ total: 0, done: 0 })), "Looking for PDFs without an entry…");
  assert.equal(m.jobProgressText(makeJob({ kind: "resolve-paths", total: 3, done: 1, failed: 1, current: "Notes/x.md" })), "Reading 3 of 3 files… x.md");
  assert.equal(m.jobSummaryText(makeJob({ state: "failed", failed: 2 }), null), "The job failed: 0 new entries · 0 need review · 2 failed");
});

// ---------------------------------------------------------------------------
// Automatic entries for new PDFs
// ---------------------------------------------------------------------------

test("the panel menu sets automatic entries for new PDFs on, off, or back to the preference", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  const choose = async (label: string) => {
    await click(byLabel(host, "References menu"));
    const group = byLabel(host, "Create entries for new PDFs automatically")!;
    await click(buttonByText(group, label));
  };
  await click(byLabel(host, "References menu"));
  assert.equal(byLabel(host, "Create entries for new PDFs automatically")!.querySelector('[aria-checked="true"]')?.textContent, "Follow Preferences");
  await click(byLabel(host, "References menu"));

  await choose("On for this notebook");
  assert.deepEqual(server.patches().at(-1), [{ op: "set-settings", settings: { autoCreateForPdfs: true } }]);
  await choose("Off for this notebook");
  assert.deepEqual(server.patches().at(-1), [{ op: "set-settings", settings: { autoCreateForPdfs: false } }]);
  await click(byLabel(host, "References menu"));
  assert.equal(byLabel(host, "Create entries for new PDFs automatically")!.querySelector('[aria-checked="true"]')?.textContent, "Off for this notebook");
  await click(byLabel(host, "References menu"));
  await choose("Follow Preferences");
  assert.deepEqual(server.patches().at(-1), [{ op: "set-settings", settings: { autoCreateForPdfs: null } }]);
  assert.deepEqual(server.library.settings, {}, "the notebook follows the preference again");
});

// ---------------------------------------------------------------------------
// Re-resolve
// ---------------------------------------------------------------------------

test("re-resolve looks an entry up by its best identifier", () => {
  const base = makeEntry("r", "r", { type: "article-journal", title: "A title", author: [{ family: "Doe", given: "Jo" }], issued: { "date-parts": [[2001]] } });
  assert.deepEqual(m.reresolveRequest({ ...base, identifiers: { doi: "10.1/x", arxiv: "2101.00001", pmid: "1" } }), { input: "10.1/x" });
  assert.deepEqual(m.reresolveRequest({ ...base, identifiers: { arxiv: "2101.00001", pmid: "1" } }), { input: "arXiv:2101.00001" });
  assert.deepEqual(m.reresolveRequest({ ...base, identifiers: { pmid: "1", isbn: ["9780262033848"] } }), { input: "PMID: 1" });
  assert.deepEqual(m.reresolveRequest({ ...base, identifiers: { isbn: ["9780262033848"] }, csl: { ...base.csl, URL: "https://example.org" } }), { input: "ISBN 9780262033848" });
  assert.deepEqual(m.reresolveRequest({ ...base, csl: { ...base.csl, URL: "https://example.org" }, attachments: [{ kind: "pdf", path: "Notes/a.pdf" }] }), { input: "https://example.org" });
  assert.deepEqual(m.reresolveRequest({ ...base, attachments: [{ kind: "pdf", path: "Notes/a.pdf" }] }), { path: "Notes/a.pdf" });
  assert.deepEqual(m.reresolveRequest(base), { input: "Doe, J. (2001). A title." });
  assert.equal(m.reresolveRequest(makeEntry("e", "e", { type: "book" })), null);
});

test("re-resolve shows the differences and never overwrites the user's fields silently", async () => {
  const entry = makeEntry("ref_r", "doe2001", {
    type: "article-journal", title: "My own title", "container-title": "Old Journal", DOI: "10.1/r",
  }, { identifiers: { doi: "10.1/r" }, provenance: { title: user, "container-title": llm } });
  const server = fakeServer(libraryOf([entry]));
  server.resolve = () => result([{
    csl: { type: "article-journal", title: "The registered title", "container-title": "New Journal", volume: "7", DOI: "10.1/r" },
    provenance: { title: crossref, "container-title": crossref, volume: crossref, DOI: crossref },
    identifiers: { doi: "10.1/r", openalex: "W1" },
  }]);
  const { host } = await renderPanel();
  await click(byLabel(host, "Actions for doe2001"));
  await click(buttonByText(host.ownerDocument.querySelector('[role=menu][aria-label="Actions for doe2001"]')!, "Re-resolve…"));
  assert.deepEqual(server.bodies("/api/references/resolve").at(-1), { notebook: "Notes", input: "10.1/r", webSearch: false });
  const dialog = document.querySelector('[aria-label="Re-resolve"]')!;
  await waitFor(() => byLabel(dialog, "Changes") !== null, "the diff");
  const rows = [...dialog.querySelectorAll("tr[data-field]")];
  assert.deepEqual(rows.map((row) => row.getAttribute("data-field")), ["title", "container-title", "volume"]);
  assert.match(rows[0].textContent ?? "", /My own title.*The registered title/);
  assert.equal((byLabel(dialog, "Use the resolved title") as HTMLInputElement).checked, false, "the user's value is kept by default");
  assert.equal((byLabel(dialog, "Use the resolved published in") as HTMLInputElement).checked, true);
  assert.match(dialog.textContent ?? "", /1 field you wrote will be kept/);
  await click(buttonByText(document.querySelector("[role=dialog]")!, "Apply"));
  assert.deepEqual(server.patches().at(-1), [{
    op: "update", id: "ref_r",
    csl: { "container-title": "New Journal", volume: "7" },
    provenance: { "container-title": crossref, volume: crossref },
    conflicts: { title: [{ value: "The registered title", provenance: crossref }] },
    identifiers: { doi: "10.1/r", openalex: "W1" },
    status: "needs-review",
  }]);
  assert.equal(server.library.entries.ref_r.csl.title, "My own title");

  // Accepting the user's field explicitly, and confirming.
  const op = m.buildReresolveOp(server.library.entries.ref_r, {
    csl: { type: "article-journal", title: "The registered title" }, provenance: { title: crossref },
  }, ["title"], { confirm: true });
  assert.deepEqual(op, { op: "update", id: "ref_r", csl: { title: "The registered title" }, provenance: { title: crossref }, conflicts: { title: null }, status: "confirmed" });
});

test("bulk re-resolve in Manage runs one entry at a time, with progress and cancel", async () => {
  const entries = ["a", "b", "c"].map((letter) => makeEntry(`ref_${letter}`, `${letter}2000`, {
    type: "article-journal", title: `Title ${letter}`, author: [{ family: letter.toUpperCase() }], DOI: `10.1/${letter}`,
  }, { identifiers: { doi: `10.1/${letter}` } }));
  const server = fakeServer(libraryOf(entries));
  server.resolve = (body, request) => body.input === "10.1/b"
    ? pending(request)
    : result([{ csl: { type: "article-journal", title: `Title ${String(body.input).slice(-1)}`, volume: "9" }, provenance: { volume: crossref } }]);
  const { host } = await renderPanel();
  await click(byLabel(host, "Manage references"));
  const dialog = document.querySelector("[role=dialog]")!;
  await click(byLabel(dialog, "Select all"));
  await click(buttonByText(dialog, "Re-resolve"));
  await waitFor(() => /Re-resolving 2 of 3… b2000/.test(byLabel(dialog, "Re-resolve progress")?.textContent ?? ""), "progress on the second entry");
  assert.deepEqual(server.patches(), [[{ op: "update", id: "ref_a", csl: { volume: "9" }, provenance: { volume: crossref }, status: "needs-review" }]]);
  await click(buttonByText(byLabel(dialog, "Re-resolve progress")!, "Cancel"));
  await waitFor(() => /Re-resolve stopped: 1 updated, 0 unchanged/.test(dialog.textContent ?? ""), "the stopped summary");
  assert.deepEqual(server.bodies("/api/references/resolve").map((body) => body.input), ["10.1/a", "10.1/b"], "the third is never looked up");
  assert.equal(server.patches().length, 1);
});

// ---------------------------------------------------------------------------
// Formatting and copy
// ---------------------------------------------------------------------------

test("the card formats the reference with the notebook's style, and falls back to the plain reference", async () => {
  const server = fakeServer(sampleLibrary());
  const { host } = await renderPanel();
  await click(host.querySelector('[data-entry-id="ref_godel"]'));
  const formatted = () => byLabel(host, "Formatted reference")!;
  await waitFor(() => formatted().getAttribute("data-formatted") === "citeproc", "citeproc formatting");
  assert.equal(formatted().textContent, "Gödel, K. (1931). On formally undecidable propositions. Monatshefte Für Mathematik.");
  assert.ok(formatted().querySelector("i"), "the journal is in italics");

  await act(async () => mounted!.root.unmount());
  mounted = null;
  m.resetReferenceLibraryCache();
  server.library = { ...sampleLibrary(), style: "Notes/styles/broken.csl" };
  // A style without a bibliography cannot format a reference.
  server.files["Notes/styles/broken.csl"] = '<?xml version="1.0" encoding="utf-8"?><style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0"><info><title>No bibliography</title><id>none</id><updated>2020-01-01T00:00:00+00:00</updated></info><citation><layout><text variable="title"/></layout></citation></style>';
  const second = await renderPanel();
  await click(second.host.querySelector('[data-entry-id="ref_godel"]'));
  const card = byLabel(second.host, "Formatted reference")!;
  await waitFor(() => card.getAttribute("aria-busy") === null, "formatting settles");
  assert.equal(card.getAttribute("data-formatted"), "plain");
  assert.equal(card.textContent, "Gödel, K. (1931). On formally undecidable propositions. Monatshefte für Mathematik.");
});

test("Copy formatted reference puts text/plain and text/html on the clipboard", async () => {
  fakeServer(sampleLibrary());
  const written: Array<Record<string, Blob>> = [];
  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }
  Object.defineProperty(globalThis, "ClipboardItem", { value: FakeClipboardItem, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { write: async (items: FakeClipboardItem[]) => { written.push(items[0].items); } }, configurable: true });
  try {
    const { host } = await renderPanel();
    await click(host.querySelector('[data-entry-id="ref_godel"]'));
    await click(buttonByText(host, "Copy formatted reference"));
    await waitFor(() => written.length === 1, "copied");
    assert.deepEqual(Object.keys(written[0]).sort(), ["text/html", "text/plain"]);
    assert.equal(await written[0]["text/plain"].text(), "Gödel, K. (1931). On formally undecidable propositions. Monatshefte Für Mathematik.");
    assert.match(await written[0]["text/html"].text(), /^<div class="csl-entry">Gödel, K\. \(1931\)\. On formally undecidable propositions\. <i>Monatshefte Für Mathematik<\/i>\.<\/div>$/);
    assert.match(host.textContent ?? "", /Reference copied/);
  } finally {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

// ---------------------------------------------------------------------------
// Import renames
// ---------------------------------------------------------------------------

test("import shows the server's renamedKeys, and infers renames only when the field is absent", async () => {
  const server = fakeServer(sampleLibrary());
  const bibtex = "@article{godel1931,\n  title = {Gödel revisited},\n  year = {1999}\n}";
  let withField = true;
  server.importResult = () => {
    const before = new Set(Object.keys(server.library.entries));
    const next = applyLibraryOps(server.library, [{ op: "add", entry: { key: "godel1931a", csl: { type: "article-journal", title: "Gödel revisited", issued: { "date-parts": [[1999]] } } } }], NOW).library;
    server.library = { ...next, revision: server.library.revision + 1 };
    const added = Object.keys(server.library.entries).filter((id) => !before.has(id));
    return { library: server.library, added, errors: [], duplicates: [], ...(withField ? { renamedKeys: [{ sourceKey: "GODEL-1931", key: "godel1931a" }] } : {}) };
  };
  const { host } = await renderPanel();
  await click(byLabel(host, "Add references"));
  await type(byLabel(host, "Reference to add"), bibtex);
  await click(buttonByText(host, "Import"));
  assert.equal(byLabel(host, "Renamed keys")?.textContent, "GODEL-1931 → godel1931a", "the server's value wins over inference");

  await click(buttonByText(host, "Done"));
  withField = false;
  server.library = sampleLibrary();
  server.library.revision = 20;
  await act(async () => { await m.fetchReferenceLibrary("Notes"); });
  await click(byLabel(host, "Add references"));
  await type(byLabel(host, "Reference to add"), bibtex);
  await click(buttonByText(host, "Import"));
  assert.equal(byLabel(host, "Renamed keys")?.textContent, "godel1931 → godel1931a", "inferred from the source text");
});

// ---------------------------------------------------------------------------
// Fact-check
// ---------------------------------------------------------------------------

test("Fact-check citations dispatches the request for the active Markdown document with the web-search choice", async () => {
  fakeServer(sampleLibrary());
  const requests: unknown[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener(FACT_CHECK_REQUEST_EVENT, listener);
  try {
    const plain = await renderPanel({ activeDocumentPath: "Notes/paper.md", activeMarkdownDraft: "No citations here." });
    await click(byLabel(plain.host, "References menu"));
    const disabled = buttonByText(plain.host.querySelector('[role=menu]')!, /Fact-check citations/) as HTMLButtonElement;
    assert.equal(disabled.disabled, true);
    assert.match(disabled.title, /cites nothing yet/);
    await act(async () => mounted!.root.unmount());
    mounted = null;

    const { host } = await renderPanel({ activeDocumentPath: "Notes/paper.md", activeMarkdownDraft: "As shown [@godel1931, p. 3]." });
    await click(byLabel(host, "References menu"));
    await click(buttonByText(host.querySelector('[role=menu]')!, /Fact-check citations/));
    const popover = byLabel(host, "Fact-check citations")!;
    assert.match(popover.textContent ?? "", /paper\.md/);
    await act(async () => (popover.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await settle();
    await click(buttonByText(popover, "Start fact-check"));
    assert.deepEqual(requests, [{ path: "Notes/paper.md", webSearch: true }]);
    assert.equal(byLabel(host, "Fact-check citations"), null);
  } finally {
    window.removeEventListener(FACT_CHECK_REQUEST_EVENT, listener);
  }
});
