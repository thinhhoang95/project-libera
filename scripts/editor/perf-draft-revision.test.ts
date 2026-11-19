import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler, useEffect, useMemo, useRef, type ReactNode } from "react";
import { changedDraftKeys, draftRevision, useChromeTabs, useDraftRevisionFor, viewKey } from "../../src/components/libera/tab-chrome";
import { useStableHandlers } from "../../src/components/libera/use-stable-handlers";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatStore } from "../../src/lib/document-chat";

function setupDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "FileReader"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  return dom;
}

// A tab keeps its file object while its text changes, as in the workspace hook.
const fileOf = new Map<string, OpenTab["file"]>();
function tabOf(id: string, patch: Partial<OpenTab> = {}): OpenTab {
  if (!fileOf.has(id)) fileOf.set(id, { path: `Notes/${id}.md`, name: `${id}.md`, fileType: "markdown", notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"]);
  return { id, draft: "", saved: "", status: "clean", file: fileOf.get(id)!, ...patch };
}

/** What libera-app.tsx does with each committed `tabs`. */
function usePublishedTabs(tabs: OpenTab[]) {
  const previous = useRef<OpenTab[] | null>(null);
  useEffect(() => {
    draftRevision.publish(previous.current, tabs);
    previous.current = tabs;
  }, [tabs]);
}

test("a caret or scroll publication moves no draft key; a text, page count or close does", () => {
  const a = tabOf("a", { draft: "one", viewState: { markdown: { line: 3, selectionStart: 1 } } });
  const b = tabOf("b", { draft: "two" });
  assert.deepEqual(changedDraftKeys([a, b], [{ ...a, viewState: { markdown: { line: 3, selectionStart: 9 } } }, b]), [], "caret only");
  assert.deepEqual(changedDraftKeys([a, b], [{ ...a, viewState: { markdown: { line: 3, selectionStart: 1, editorScrollPos: 40 } } }, b]), [], "scroll position only");
  assert.deepEqual(changedDraftKeys([a, b], [{ ...a, status: "dirty" }, b]), [], "status only");
  const typed = changedDraftKeys([a, b], [{ ...a, draft: "one two" }, b]);
  assert.ok(typed.includes("a") && typed.includes("Notes/a.md"));
  assert.ok(!typed.includes("b") && !typed.includes("Notes/b.md"), "the other tab is not named");
  const pdf = tabOf("p", { file: { ...tabOf("p").file, fileType: "pdf", path: "Notes/p.pdf" } as OpenTab["file"], viewState: { pdf: { page: 1 } } as OpenTab["viewState"] });
  assert.ok(changedDraftKeys([pdf], [{ ...pdf, viewState: { pdf: { page: 1, pageCount: 12 } } as OpenTab["viewState"] }]).includes("p"), "page count");
  assert.ok(changedDraftKeys([pdf], [{ ...pdf, viewState: { pdf: { page: 4 } } as OpenTab["viewState"] }]).includes(viewKey("p")), "reading page");
  assert.ok(changedDraftKeys([a, b], [a]).includes("b"), "a closed tab");
});

test("a caret publication bumps nothing, and a draft in tab X wakes only what follows X", async () => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const commits = { x: 0, y: 0, strip: 0 };
  let bumps = 0;
  const stop = draftRevision.subscribe(() => { bumps++; });
  const onRender = (id: string) => { commits[id as keyof typeof commits]++; };
  function Follower({ keys, name }: { keys: string[]; name: "x" | "y" | "strip" }) {
    useDraftRevisionFor(keys);
    return createElement(Profiler, { id: name, onRender }, null);
  }
  function Shell({ tabs }: { tabs: OpenTab[] }) {
    usePublishedTabs(tabs);
    // Memoized, as the panel is: only the revisions render the followers.
    return useMemo(() => createElement("div", null,
      createElement(Follower, { keys: ["a", viewKey("a")], name: "x" }),
      createElement(Follower, { keys: ["b", viewKey("b")], name: "y" }),
      createElement(Follower, { keys: ["Notes/a.md"], name: "strip" })), []);
  }
  const render = async (tabs: OpenTab[]) => { await act(async () => root.render(createElement(Shell, { tabs }))); };
  try {
    const a = tabOf("a", { draft: "one", viewState: { markdown: { line: 2, selectionStart: 0 } } });
    const b = tabOf("b", { draft: "two" });
    await render([a, b]);
    const before = { ...commits };
    const bumpsBefore = bumps;
    await render([{ ...a, viewState: { markdown: { line: 2, selectionStart: 5 } } }, b]);
    assert.equal(bumps, bumpsBefore, "a caret-only publication bumps no revision");
    assert.deepEqual(commits, before, "and renders no follower");
    await render([{ ...a, viewState: { markdown: { line: 2, selectionStart: 5 } }, draft: "one!" }, b]);
    assert.equal(commits.x, before.x + 1, "the follower of the edited tab renders");
    assert.equal(commits.strip, before.strip + 1, "so does the follower of its path");
    assert.equal(commits.y, before.y, "the follower of the other tab does not");
  } finally {
    stop();
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the review strip counts lines once per baseline and text, and ignores other tabs", async () => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  const storePath = require.resolve("../../src/lib/agent-review/store");
  const realStore = require(storePath) as typeof import("../../src/lib/agent-review/store");
  const saved = require.cache[storePath];
  let counted = 0;
  require.cache[storePath] = { ...saved!, exports: { ...realStore, reviewLineCounts: (...args: Parameters<typeof realStore.reviewLineCounts>) => { counted++; return realStore.reviewLineCounts(...args); } } } as unknown as NodeModule;
  delete require.cache[require.resolve("../../src/components/libera/agent-review-strip")];
  const { AgentReviewStrip } = await import("../../src/components/libera/agent-review-strip");
  const originalFetch = globalThis.fetch;
  const file = { path: "Notes/a.md", baseline: "a\n", current: "a\nb\n", created: false, revision: "r1" };
  globalThis.fetch = async (_input, init) => init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ files: [file] });
  const root = createRoot(document.getElementById("root")!);
  let draft = "a\nb\n";
  const readTabDraft = () => draft;
  const noop = () => undefined;
  let stripCommits = 0;
  const strip = createElement(Profiler, { id: "strip", onRender: () => { stripCommits++; } } as never, createElement(AgentReviewStrip, { readTabDraft, onOpenFile: noop, onReverted: noop, onError: noop }));
  function Shell({ tabs, children }: { tabs: OpenTab[]; children?: ReactNode }) {
    usePublishedTabs(tabs);
    return useMemo(() => createElement("div", null, children), [children]);
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const a = tabOf("Notes/a.md", { draft: "a\nb\n" });
  const other = tabOf("z", { draft: "z" });
  try {
    await act(async () => root.render(createElement(Shell, { tabs: [a, other] }, strip)));
    await settle();
    await settle();
    assert.match(document.body.textContent ?? "", /\+1/);
    const countedBefore = counted;
    const commitsBefore = stripCommits;
    // Caret, and another tab's text: no render, no line diff.
    await act(async () => root.render(createElement(Shell, { tabs: [{ ...a, viewState: { markdown: { line: 1, selectionStart: 2 } } }, { ...other, draft: "zz" }] }, strip)));
    assert.equal(stripCommits, commitsBefore, "the strip did not render");
    assert.equal(counted, countedBefore, "no line diff ran");
    // A global bump with the same text re-reads but takes the counts from the cache.
    await act(async () => draftRevision.bump());
    assert.equal(counted, countedBefore, "unchanged baseline and text reuse their counts");
    draft = "a\nb\nc\nd\n";
    await act(async () => root.render(createElement(Shell, { tabs: [{ ...a, draft }, other] }, strip)));
    assert.match(document.body.textContent ?? "", /\+3/, "the reviewed file's own text still updates the counts");
    assert.equal(counted, countedBefore + 1);
  } finally {
    await act(async () => root.unmount());
    const { agentReviewStore } = realStore;
    await agentReviewStore.keep([file.path]).catch(() => undefined);
    globalThis.fetch = originalFetch;
    if (saved) require.cache[storePath] = saved; else delete require.cache[storePath];
    delete require.cache[require.resolve("../../src/components/libera/agent-review-strip")];
    dom.window.close();
  }
});

// Counters the stubs below bump. The panel module is loaded once per process, so the stubs go in before its first load.
const spies = { scans: 0, usage: 0, reply: 0 };
let stubsInstalled = false;
function installStubs() {
  if (stubsInstalled) return;
  stubsInstalled = true;
  const require = createRequire(import.meta.url);
  const stub = (path: string, wrap: (real: Record<string, unknown>) => Record<string, unknown>) => {
    const resolved = require.resolve(path);
    const real = require(resolved) as Record<string, unknown>;
    require.cache[resolved] = { ...require.cache[resolved]!, exports: wrap(real) } as unknown as NodeModule;
  };
  stub("../../src/lib/markdown-macros", (real) => ({ ...real, combinedMacroScope: (...args: unknown[]) => { spies.scans++; return (real.combinedMacroScope as (...a: unknown[]) => unknown)(...args); } }));
  stub("../../src/components/libera/chat-token-usage", () => ({ ChatTokenUsage: () => { spies.usage++; return null; } }));
  stub("../../src/components/markdown-renderer", (real) => ({ ...real, MarkdownRenderer: ({ content }: { content: string }) => { spies.reply++; return createElement("div", { "data-reply": true }, content); } }));
}

// The chat panel, mounted as the app mounts it: memoized, handed tabs without text and a reader of the live tabs.
async function mountPanel() {
  installStubs();
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const root = createRoot(document.getElementById("root")!);
  const files: OpenTab["file"][] = [tabOf("a").file];
  const mathMarkers = {};
  const noop = () => undefined;
  function Shell({ tabs, collapsed }: { tabs: OpenTab[]; collapsed: boolean }) {
    const chrome = useChromeTabs(tabs);
    const activeTab = useMemo(() => chrome.find((tab) => tab.id === "a"), [chrome]);
    const readers = useStableHandlers({ readOpenTabs: () => tabs });
    usePublishedTabs(tabs);
    return createElement(DocumentChatPanel, { activeTab, tabs: chrome, readOpenTabs: readers.readOpenTabs, files, collapsed, mathMarkers, onCollapsedChange: noop, onCreateDraft: noop });
  }
  const settle = async () => { await act(flushPendingState); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  return {
    dom, root, host: document.getElementById("root")!, settle,
    render: async (tabs: OpenTab[], collapsed = false) => { await act(async () => root.render(createElement(Shell, { tabs, collapsed }))); await settle(); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

test("collapsed chat does not scan drafts for macros; shown chat scans only the tab in view", async () => {
  const panel = await mountPanel();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ history: null });
  const a = tabOf("a", { draft: "# a" });
  const b = tabOf("b", { draft: "# b" });
  try {
    await panel.render([a, b], true);
    await panel.settle();
    const collapsedBefore = spies.scans;
    await panel.render([{ ...a, draft: "# a typed" }, b], true);
    await panel.render([{ ...a, draft: "# a typed more" }, b], true);
    assert.equal(spies.scans, collapsedBefore, "collapsed: no macro scan for a draft publication");
    await panel.render([{ ...a, draft: "# a typed more" }, b], false);
    const shownBefore = spies.scans;
    assert.ok(shownBefore > collapsedBefore, "shown again: the scope is read once more");
    await panel.render([{ ...a, draft: "# a typed more" }, { ...b, draft: "# b typed" }], false);
    assert.equal(spies.scans, shownBefore, "a draft in another tab does not scan");
    await panel.render([{ ...a, draft: "# a typed most" }, { ...b, draft: "# b typed" }], false);
    assert.ok(spies.scans > shownBefore, "a draft in the tab in view still scans");
  } finally {
    globalThis.fetch = originalFetch;
    await panel.close();
  }
});

test("the chat clock renders the panel zero times within a day and once at midnight", async () => {
  const panel = await mountPanel();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ history: null });
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals: number[] = [];
  const win = panel.dom.window as unknown as { setTimeout: (fn: () => void, ms?: number) => number; setInterval: (fn: () => void, ms?: number) => number };
  const realSetTimeout = win.setTimeout.bind(win);
  const realSetInterval = win.setInterval.bind(win);
  win.setTimeout = (fn, ms = 0) => { if (ms >= 3_600_000) { timeouts.push({ fn, ms }); return -1; } return realSetTimeout(fn, ms); };
  win.setInterval = (fn, ms = 0) => { intervals.push(ms); return realSetInterval(fn, ms); };
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 19, 12, 0, 0) });
  try {
    await panel.render([tabOf("a", { draft: "# a" })]);
    await panel.settle();
    const mounted = spies.usage;
    assert.ok(mounted >= 1);
    assert.deepEqual(intervals.filter((ms) => ms <= 60_000), [], "no minute clock");
    const midnight = timeouts.at(-1);
    assert.ok(midnight, "a timer to the next midnight");
    assert.equal(midnight.ms, 12 * 3600_000, "it is set for local midnight");
    // Focusing the window within the same day changes nothing.
    await act(async () => { panel.dom.window.dispatchEvent(new panel.dom.window.Event("focus")); });
    assert.equal(spies.usage, mounted, "no render within the day");
    mock.timers.setTime(new Date(2026, 10, 20, 0, 0, 1).getTime());
    await act(async () => { midnight.fn(); });
    assert.equal(spies.usage, mounted + 1, "one render at midnight");
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    await panel.close();
  }
});

test("streaming chunks render the reply, not the panel, and the saved chat ends as before", async () => {
  const panel = await mountPanel();
  const originalFetch = globalThis.fetch;
  let history: ChatStore | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.kind === "history") history = body.value; return Response.json({ saved: true }); }
      return Response.json({ history });
    }
    if (url === "/api/document-chat") return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { "Content-Type": "application/x-ndjson" } });
    return Response.json({});
  };
  const emit = async (event: object) => {
    await act(async () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
      await new Promise((resolve) => setTimeout(resolve, 65));
    });
  };
  try {
    await panel.render([tabOf("a", { draft: "# a" })]);
    await panel.settle();
    await act(async () => {
      const input = panel.host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(panel.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain");
      input.dispatchEvent(new panel.dom.window.Event("input", { bubbles: true }));
    });
    await act(flushPendingState);
    await act(async () => panel.host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    await panel.settle();
    await emit({ type: "delta", text: "w0" });
    const panelAfterStart = spies.usage;
    const replyAfterStart = spies.reply;
    const words = Array.from({ length: 12 }, (_, index) => ` w${index + 1}`);
    for (const word of words) await emit({ type: "delta", text: word });
    assert.ok([...panel.host.querySelectorAll("[data-reply]")].at(-1)?.textContent?.includes("w12"), "the reply shows every chunk");
    assert.equal(spies.usage, panelAfterStart, "the panel did not render for any chunk");
    assert.ok(spies.reply - replyAfterStart >= words.length / 2, "the reply rendered for the chunks");
    await emit({ type: "done" });
    await panel.settle();
    await act(flushPendingState);
    const text = ["w0", ...words].join("");
    const saved = (history as ChatStore | null)?.chats[0].messages.at(-1);
    assert.equal(saved?.text, text, "the saved reply has the full text");
    assert.equal(saved?.status, undefined, "and is not marked streaming");
  } finally {
    globalThis.fetch = originalFetch;
    await panel.close();
  }
});
