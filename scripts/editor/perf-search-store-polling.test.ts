import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const key of ["window", "document"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });

const loadStore = () => import("../../src/components/libera/global-search/search-store");

const status = (patch: Record<string, unknown> = {}) => ({ state: "idle", exists: true, customIndex: false, model: { state: "ready" }, files: 3, chunks: 9, embeddedChunks: 9, images: 0, failedFiles: 0, done: 0, total: 0, indexPath: "x", ...patch });

type Call = { url: string; body?: string; finish: (payload?: unknown) => void };

/** A fetch whose replies the test releases by hand. */
function fakeFetch() {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ url, body: init?.body as string | undefined, finish: (payload = status()) => resolve(new Response(JSON.stringify(payload), { status: 200 })) });
  })) as typeof fetch;
  return calls;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
}

test("concurrent status refreshes make one request, and identical replies publish nothing", async () => {
  const store = await loadStore();
  const calls = fakeFetch();
  let publications = 0;
  const first = store.refreshSearchStatus();
  const second = store.refreshSearchStatus();
  assert.equal(calls.length, 1, "one request in flight");
  calls[0].finish();
  await Promise.all([first, second]);
  const initial = await (async () => {
    const again = store.refreshSearchStatus();
    calls[1].finish();
    return again;
  })();
  assert.ok(initial);
  // Count publications through a mounted store reader.
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: dom.window.HTMLElement });
  document.body.innerHTML = "<div id='root'></div>";
  const root = createRoot(document.getElementById("root")!);
  function Reader() { store.useSearchStore(); publications++; return null; }
  await act(async () => root.render(createElement(Reader)));
  const rendersBefore = publications;
  for (let index = 0; index < 3; index++) {
    const pending = store.refreshSearchStatus();
    calls[calls.length - 1].finish();
    await act(async () => { await pending; });
  }
  assert.equal(publications, rendersBefore, "the same status three times renders nothing");
  const pending = store.refreshSearchStatus();
  calls[calls.length - 1].finish(status({ files: 4 }));
  await act(async () => { await pending; });
  assert.equal(publications, rendersBefore + 1, "a changed status renders once");
  act(() => root.unmount());
});

test("background indexing skips while another index request is out, and while hidden", async () => {
  const store = await loadStore();
  setVisibility("visible");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = fakeFetch();
  const stop = store.startBackgroundIndexing(1_000, 5_000);
  try {
    // A Search-view action is out: the background pass waits for the next tick.
    const action = store.searchIndexAction("build");
    mock.timers.tick(1_000);
    assert.equal(calls.filter((call) => call.body?.includes("background")).length, 0, "skipped during a page action");
    calls[0].finish();
    await action;
    mock.timers.tick(5_000);
    assert.equal(calls.filter((call) => call.body?.includes("background")).length, 1);
    // Overlapping triggers: the first is still out when the next tick comes.
    mock.timers.tick(5_000);
    assert.equal(calls.filter((call) => call.body?.includes("background")).length, 1, "no second request while one is out");
    calls[calls.length - 1].finish();
    await settle();
    // Hidden: nothing is sent; showing the window runs the pass that came due.
    setVisibility("hidden");
    mock.timers.tick(5_000);
    assert.equal(calls.filter((call) => call.body?.includes("background")).length, 1, "nothing while hidden");
    setVisibility("visible");
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(calls.filter((call) => call.body?.includes("background")).length, 2, "runs once when shown");
    calls[calls.length - 1].finish();
    await settle();
  } finally {
    stop();
    mock.timers.reset();
  }
});
