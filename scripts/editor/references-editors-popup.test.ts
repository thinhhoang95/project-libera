import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CitationPopup, citationQueryIdentifier, unresolvedStubEntry, type CitationPopupHandle } from "../../src/components/libera/references/citation-popup";
import { ReferenceRenderProvider } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import { REFERENCES_ADD_REQUEST_EVENT, type ReferencesAddRequestDetail } from "../../src/lib/references/types";
import { LEE, SMITH, installReferenceFetch, makeLibrary, type MockServer } from "./references-editors-fixtures";

let dom: JSDOM;
let restoreFetch: () => void = () => {};
let server: MockServer;

before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "Event", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    const value = dom.window[key];
    Object.defineProperty(globalThis, key, { value: typeof value === "function" && /^[a-z]/.test(key) ? (value as (...args: never[]) => unknown).bind(dom.window) : value, configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
  // Node's BroadcastChannel dispatches Node events, which jsdom's EventTarget globals reject.
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  Object.assign(dom.window.HTMLElement.prototype, {
    scrollIntoView() {},
    // React's input-event fallback expects these IE hooks when jsdom moves focus into an input.
    attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
    detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
  });
});
after(() => dom.window.close());

afterEach(() => {
  restoreFetch();
  resetReferenceLibraryCache();
  resetRecentCitations();
});

function setup(resolve: MockServer["resolve"] = () => 500) {
  server = { libraries: { Notes: makeLibrary() }, requests: [], resolve };
  restoreFetch = installReferenceFetch(server);
}

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

type Mounted = { root: Root; host: HTMLElement; handle: { current: CitationPopupHandle | null }; inserts: Array<[string, boolean]>; closes: number; render: (query: string) => Promise<void> };

async function mount(query: string, { notebook = "Notes", citedKeys = [] as string[], searchInput = false } = {}): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<CitationPopupHandle>();
  const mounted: Mounted = {
    root, host, handle, inserts: [], closes: 0,
    render: async (next) => {
      await act(async () => {
        root.render(createElement(ReferenceRenderProvider, { notebook: notebook || null },
          createElement(CitationPopup, {
            ref: handle, query: next, x: 10, y: 20, citedKeys, searchInput,
            onInsert: (key, { locator }) => mounted.inserts.push([key, locator]),
            onClose: () => { mounted.closes += 1; },
          })));
      });
    },
  };
  await mounted.render(query);
  await settle(5);
  return mounted;
}

async function unmount(mounted: Mounted) {
  await act(async () => mounted.root.unmount());
  mounted.host.remove();
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[role=option]")];
const press = async (mounted: Mounted, key: string, init: { shiftKey?: boolean } = {}) => {
  let handled = false;
  await act(async () => { handled = mounted.handle.current!.handleKey({ key, ...init }); });
  return handled;
};

test("rows show authors, year, key, title and status badges, ranked for the query", async () => {
  setup();
  const popup = await mount("sm");
  const options = rows(popup.host);
  // Both keys start with the query; the shorter key ranks first.
  assert.deepEqual(options.slice(0, 2).map((row) => row.dataset.citationKey), ["smythe2021", "smith2020sparse"]);
  assert.match(options[1].textContent!, /Smith \(2020\)@smith2020sparseSparse attention/);
  assert.match(options[0].textContent!, /Smythe et al\. \(2021\)Needs review@smythe2021Dense attention/);
  assert.equal(options.at(-1)!.textContent, "Open References");
  assert.equal(options[0].getAttribute("aria-selected"), "true");
  await unmount(popup);

  const unresolved = await mount("lee");
  assert.match(rows(unresolved.host)[0].textContent!, /Unresolved/);
  await unmount(unresolved);
});

test("arrow keys move, Enter inserts, Tab inserts at the locator, Escape closes", async () => {
  setup();
  const popup = await mount("sm");
  assert.equal(await press(popup, "ArrowDown"), true);
  assert.equal(rows(popup.host)[1].getAttribute("aria-selected"), "true");
  assert.equal(await press(popup, "ArrowUp"), true);
  assert.equal(await press(popup, "ArrowUp"), true); // wraps to the footer
  assert.equal(rows(popup.host).at(-1)!.getAttribute("aria-selected"), "true");
  await press(popup, "ArrowDown");
  assert.equal(await press(popup, "Enter"), true);
  assert.deepEqual(popup.inserts, [["smythe2021", false]]);
  await press(popup, "ArrowDown");
  assert.equal(await press(popup, "Tab"), true);
  assert.deepEqual(popup.inserts.at(-1), ["smith2020sparse", true]);
  assert.equal(await press(popup, "Tab", { shiftKey: true }), false);
  assert.equal(await press(popup, "a"), false);
  assert.equal(await press(popup, "Escape"), true);
  assert.equal(popup.closes, 1);
  await unmount(popup);
});

test("the mouse selects and inserts rows", async () => {
  setup();
  const popup = await mount("sm");
  const second = rows(popup.host)[1];
  await act(async () => { second.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
  assert.equal(rows(popup.host)[1].getAttribute("aria-selected"), "true");
  const down = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  second.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, "the editor keeps focus");
  await act(async () => { second.click(); });
  assert.deepEqual(popup.inserts, [["smith2020sparse", false]]);
  await unmount(popup);
});

test("Open References asks the panel to add the query", async () => {
  setup();
  const popup = await mount("nothing");
  assert.match(popup.host.textContent!, /No matches/);
  const requests: ReferencesAddRequestDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<ReferencesAddRequestDetail>).detail);
  window.addEventListener(REFERENCES_ADD_REQUEST_EVENT, listener);
  assert.equal(await press(popup, "Enter"), true);
  window.removeEventListener(REFERENCES_ADD_REQUEST_EVENT, listener);
  assert.deepEqual(requests, [{ notebook: "Notes", query: "nothing" }]);
  assert.equal(popup.closes, 1);
  await unmount(popup);
});

test("without a notebook library the popup says so", async () => {
  setup();
  const popup = await mount("sm", { notebook: "" });
  assert.match(popup.host.textContent!, /No library for this notebook/);
  assert.equal(rows(popup.host).length, 0);
  assert.equal(await press(popup, "Enter"), false);
  await unmount(popup);
});

test("an empty query lists cited entries first", async () => {
  setup();
  const popup = await mount("", { citedKeys: ["lee2019graphs"] });
  assert.equal(rows(popup.host)[0].dataset.citationKey, "lee2019graphs");
  await unmount(popup);
});

test("identifiers: Add reference from … resolves, previews, then Add & cite adds and inserts", async () => {
  setup(() => ({ candidates: [{ csl: { type: "article-journal", title: "Resolved paper", author: [{ family: "Doe" }], issued: { "date-parts": [[2024]] } }, identifiers: { doi: "10.1145/3292500.3330701" } }], duplicates: [] }));
  const popup = await mount("10.1145/3292500.3330701");
  const footer = rows(popup.host).find((row) => /Add reference from/.test(row.textContent!))!;
  assert.match(footer.textContent!, /Add reference from “10\.1145\/3292500\.3330701”/);
  await act(async () => { footer.click(); });
  await settle(5);
  const resolve = server.requests.find((request) => request.url === "/api/references/resolve");
  assert.deepEqual(resolve?.body, { notebook: "Notes", input: "10.1145/3292500.3330701" });
  const confirm = popup.host.querySelector<HTMLElement>("[data-citation-confirm]")!;
  assert.match(confirm.textContent!, /Doe \(2024\)Resolved paperAdd & cite/);
  assert.equal(server.requests.filter((request) => request.method === "PATCH").length, 0, "nothing is added before Add & cite");
  await act(async () => { confirm.click(); });
  await settle(5);
  const patch = server.requests.find((request) => request.method === "PATCH");
  assert.equal((patch?.body as { ops: Array<{ op: string }> }).ops[0].op, "add");
  assert.equal(popup.inserts.length, 1);
  assert.match(popup.inserts[0][0], /^doe2024new\d+$/);
  await unmount(popup);
});

test("a duplicate candidate cites the existing entry without adding", async () => {
  setup(() => ({ candidates: [{ csl: { type: "article-journal", title: "Sparse attention" } }], duplicates: [{ candidateIndex: 0, entryId: SMITH.id }] }));
  const popup = await mount("arXiv:2101.00001");
  await press(popup, "ArrowUp"); // Open References
  await press(popup, "ArrowUp"); // Add reference from …
  assert.equal(await press(popup, "Enter"), true);
  await settle(5);
  assert.match(popup.host.textContent!, /Already in library: cite @smith2020sparse/);
  await press(popup, "Enter");
  assert.deepEqual(popup.inserts, [["smith2020sparse", false]]);
  assert.equal(server.requests.filter((request) => request.method === "PATCH").length, 0);
  await unmount(popup);
});

test("when the lookup fails an unresolved stub with the identifier is added and cited", async () => {
  setup(() => 502);
  const popup = await mount("10.1000/xyz123");
  const footer = rows(popup.host).find((row) => /Add reference from/.test(row.textContent!))!;
  await act(async () => { footer.click(); });
  await settle(10);
  const patch = server.requests.find((request) => request.method === "PATCH");
  const op = (patch?.body as { ops: Array<{ entry: { status: string; identifiers: { doi?: string } } }> }).ops[0];
  assert.equal(op.entry.status, "unresolved");
  assert.equal(op.entry.identifiers.doi, "10.1000/xyz123");
  assert.equal(popup.inserts.length, 1);
  assert.match(popup.inserts[0][0], /^stubnew\d+$/);
  await unmount(popup);
});

test("identifier queries: DOI, arXiv, ISBN, PMID and URLs, not years", () => {
  assert.equal(citationQueryIdentifier("10.1145/3292500")?.kind, "doi");
  assert.equal(citationQueryIdentifier("arXiv:2101.00001")?.kind, "arxiv");
  assert.equal(citationQueryIdentifier("978-0-262-03384-8")?.kind, "isbn");
  assert.equal(citationQueryIdentifier("pmid:31452104")?.kind, "pmid");
  assert.equal(citationQueryIdentifier("https://example.com/paper")?.kind, "url");
  assert.equal(citationQueryIdentifier("2020"), null);
  assert.equal(citationQueryIdentifier("smith"), null);
  assert.deepEqual(unresolvedStubEntry({ kind: "url", value: "https://example.com/p" }).attachments, [{ kind: "url", url: "https://example.com/p" }]);
});

test("the search field (popover add and swap) filters and inserts", async () => {
  setup();
  const popup = await mount("", { searchInput: true });
  const input = popup.host.querySelector<HTMLInputElement>("input[aria-label='Search references']")!;
  assert.equal(document.activeElement, input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "lee");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(rows(popup.host)[0].dataset.citationKey, LEE.key);
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  assert.deepEqual(popup.inserts, [[LEE.key, false]]);
  await unmount(popup);
});
