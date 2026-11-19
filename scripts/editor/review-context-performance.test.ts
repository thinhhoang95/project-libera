// Review context performance: what reads the review (AI Chat, editors, the
// Comments rail) wakes only for changes it shows. Local draft publications
// that move nothing, shared text transactions that move no comment, scrolling
// with no rail following, and the comment cards' clocks.
import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { act, createContext, createElement, useContext, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { anchorAt, newReview, syncReview, type ReviewDocument } from "../../src/lib/markdown-review";
import * as contextModule from "../../src/components/libera/markdown-review-context";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import type { OpenTab } from "../../src/components/libera/types";
import { SharedReviewStore } from "../../src/lib/collab/review-store/shared";
import type { ThreadApi } from "../../src/lib/collab/review-store/api";
import type { SharedReviewProjection } from "../../src/lib/collab/review-store/types";
import type { Thread } from "../../src/lib/collab/protocol/api";

type Review = NonNullable<ReturnType<typeof useMarkdownReview>>;
type ViewportModule = typeof import("../../src/components/libera/review-viewport");
type ViewportContextValue = { store: { report: (range: { start: number; end: number } | null) => void } };

function installDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    innerHeight: 768, innerWidth: 1024,
  });
  return dom;
}
const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const optional = <T,>(load: () => Promise<T>) => load().catch(() => null);

const NO_CONTEXT = createContext<ViewportContextValue | null>(null);
const SOURCE = "Hello there\n\nSecond paragraph";

/** The provider on a local note with a stored review; `Consumer` stands in for AI Chat and counts its renders. */
async function mountLocal(threads: "none" | "unmoved" | "moved") {
  const dom = installDom();
  const viewport = await optional<ViewportModule>(() => import("../../src/components/libera/review-viewport"));
  const stored: ReviewDocument = { ...newReview("Notes/perf.md", SOURCE, "perf-id"), enabled: true,
    threads: threads === "none" ? [] : [{ id: "t1", anchor: anchorAt(SOURCE, threads === "unmoved" ? { start: 0, end: 11 } : { start: 13, end: 29 }), status: "open", messages: [{ id: "m1", text: "Comment", createdAt: "2026-09-12" }] }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/agent/review") return Response.json({ files: [] });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if ((body?.action ?? "reload") === "load") return Response.json(stored);
    return Response.json(syncReview(structuredClone(stored), body?.snapshot ?? SOURCE));
  };
  const seen: { renders: number; review: Review | null; reportViewport: ((range: { start: number; end: number } | null) => void) | null } = { renders: 0, review: null, reportViewport: null };
  function Consumer() {
    const review = useMarkdownReview();
    const channel = useContext((viewport?.ReviewViewportContext ?? NO_CONTEXT) as typeof NO_CONTEXT);
    seen.renders += 1; seen.review = review;
    // Before the viewport moved out of the context, it was reported through the review itself.
    seen.reportViewport = channel?.store.report ?? (review as unknown as { reportViewport?: (range: { start: number; end: number } | null) => void } | null)?.reportViewport ?? null;
    return null;
  }
  const consumer = createElement(Consumer);
  let setDraft!: (text: string) => void;
  function Harness() {
    const [draft, change] = useState(SOURCE);
    setDraft = change;
    const tab = { id: "tab-1", draft, saved: SOURCE, status: "dirty", file: { fileType: "markdown", path: "Notes/perf.md" } } as OpenTab;
    // createElement requires the provider's declared children prop for type checking.
    // eslint-disable-next-line react/no-children-prop
    return createElement(MarkdownReviewProvider, { activeTab: tab, getDraft: () => draft, applyDraft: () => true, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children: consumer });
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(createElement(Harness)); });
  await settle(50);
  return {
    seen, dom,
    publish: (text: string) => act(async () => { setDraft(text); }),
    async dispose() { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch; },
  };
}

test("local drafts that move nothing do not wake readers of an empty review", async () => {
  const h = await mountLocal("none");
  try {
    assert.ok(h.seen.review?.doc, "the review loaded");
    const before = h.seen.renders;
    let text = SOURCE;
    for (const add of ["!", "?", "."]) { text += add; await h.publish(text); }
    assert.equal(h.seen.renders - before, 0, "three draft publications re-rendered the consumer");
    assert.equal(h.seen.review!.doc!.snapshot, text, "the shown document still reads the live draft");
  } finally { await h.dispose(); }
});

test("local drafts after the comments do not wake readers; ones that move a comment do, once each", async () => {
  const unmoved = await mountLocal("unmoved");
  try {
    const before = unmoved.seen.renders;
    let text = SOURCE;
    for (const add of ["!", "?", "."]) { text += add; await unmoved.publish(text); }
    assert.equal(unmoved.seen.renders - before, 0, "comment anchors did not move");
    assert.equal(unmoved.seen.review!.doc!.snapshot, text);
  } finally { await unmoved.dispose(); }
  const moved = await mountLocal("moved");
  try {
    const before = moved.seen.renders;
    let text = SOURCE;
    for (const add of ["A", "B", "C"]) { text = add + text; await moved.publish(text); }
    assert.equal(moved.seen.renders - before, 3, "each publication moved the anchor");
    const anchor = moved.seen.review!.doc!.threads[0].anchor;
    assert.equal(text.slice(anchor.start, anchor.end), "Second paragraph");
  } finally { await moved.dispose(); }
});

test("scrolling does not re-render readers of the review", async () => {
  const h = await mountLocal("none");
  try {
    assert.ok(h.seen.reportViewport, "a way to report the viewport exists");
    const before = h.seen.renders;
    for (let line = 0; line < 3; line += 1) await act(async () => { h.seen.reportViewport!({ start: line * 10, end: line * 10 + 5 }); });
    assert.equal(h.seen.renders - before, 0, "viewport changes re-rendered the consumer");
  } finally { await h.dispose(); }
});

/* ---- Shared notes ---------------------------------------------------------------- */

const FILLER = "x".repeat(300);
const SHARED_TEXT = `Intro line\n\nCommented passage here.\n\n${FILLER}\n\nTail`;
const USER = { id: "u1", displayName: "Me", color: "#123456" };

async function sharedStore() {
  const ydoc = new Y.Doc();
  const annotations = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, SHARED_TEXT);
  let reads = 0;
  const toString = ytext.toString.bind(ytext);
  ytext.toString = () => { reads += 1; return toString(); };
  const api = {
    list: async () => [] as Thread[],
    commands: async () => ({ pending: [], failed: [] }),
    createThread: async (docId: string, body: { id: string; anchorId: string; quote: string; body: string }): Promise<Thread> => ({
      id: body.id, docId, anchorId: body.anchorId, quote: body.quote, status: "open", actor: { kind: "user", userId: USER.id }, createdBy: USER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", resolvedBy: null, resolvedAt: null, suggestionIds: [],
      messages: [{ id: "msg_1", threadId: body.id, actor: { kind: "user", userId: USER.id }, author: USER, body: body.body, mentions: [], createdAt: "2026-01-01T00:00:00Z", editedAt: null, deletedAt: null }],
    }),
  } as unknown as ThreadApi;
  const store = new SharedReviewStore({
    docId: "d1", projectId: "p1", key: "Shared/n.md", replica: { annotations, ytext, onRebuild: () => () => {} },
    me: () => USER, role: () => "editor", online: () => true, api, subscribeEvents: () => () => {},
  });
  await store.load();
  const published: SharedReviewProjection[] = [];
  store.subscribeProjection((projection) => published.push(projection));
  const transact = async (change: () => void) => { ydoc.transact(change); await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { store, ytext, transact, published, reads: () => reads, resetReads: () => { reads = 0; } };
}

test("shared text transactions on a note without comments publish nothing and read no text", async () => {
  const h = await sharedStore();
  h.resetReads();
  for (let index = 0; index < 3; index += 1) await h.transact(() => h.ytext.insert(h.ytext.length, "!"));
  assert.equal(h.published.length, 0, "projections published for edits that move no comment");
  assert.equal(h.reads(), 0, "the full text was read");
  assert.ok(h.store.getProjection().text.endsWith("!!!"), "the projection reads the live text on demand");
});

test("shared text transactions away from every comment publish nothing and read no text", async () => {
  const h = await sharedStore();
  const start = SHARED_TEXT.indexOf("Commented");
  await h.store.comment({ range: { start, end: start + "Commented passage here.".length }, text: "Check this" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.published.length = 0; h.resetReads();
  for (let index = 0; index < 3; index += 1) await h.transact(() => h.ytext.insert(h.ytext.length, "!"));
  assert.equal(h.published.length, 0, "projections published for edits far from the comment");
  assert.equal(h.reads(), 0, "the full text was read");
  assert.ok(h.store.getProjection().text.endsWith("!!!"));
  // An edit before the comment moves it, which is published once.
  await h.transact(() => h.ytext.insert(0, ">> "));
  assert.equal(h.published.length, 1);
  const anchor = h.published[0].threads[0].anchor;
  assert.equal(h.published[0].text.slice(anchor.start, anchor.end), "Commented passage here.");
  // An edit inside the context kept around the passage is published too.
  const near = h.store.getProjection().threads[0].anchor.end + 3;
  await h.transact(() => h.ytext.insert(near, "?"));
  assert.equal(h.published.length, 2);
});

/* ---- Viewport following ------------------------------------------------------------- */

/** A CodeMirror editor wired like the app's, inside a stand-in review context for a shared note on `tabId`. */
async function mountEditor(options: { tabId: string; paneTab?: string }) {
  const dom = installDom();
  const viewport = await import("../../src/components/libera/review-viewport");
  const { useCodeMirrorReview } = await import("../../src/components/libera/use-editor-review");
  const store = viewport.createViewportStore();
  const scrollListeners = { count: 0 };
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, capture?: boolean | AddEventListenerOptions) => { if (type === "scroll") scrollListeners.count += 1; return add(type, listener, capture); }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, capture?: boolean | AddEventListenerOptions) => { if (type === "scroll") scrollListeners.count -= 1; return remove(type, listener, capture); }) as typeof document.removeEventListener;
  const review = { register: () => () => undefined, shared: { docId: "d1" }, enabled: false, locked: false, doc: null, selection: null, clearSelection: () => {} } as unknown as Review;
  const view = new EditorView({ state: EditorState.create({ doc: "text" }), parent: document.getElementById("root")! });
  function Editor() { useCodeMirrorReview(view, () => {}); return null; }
  const root: Root = createRoot(document.createElement("div"));
  const tree: ReactElement = createElement(contextModule.ReviewContext.Provider, { value: review },
    createElement(viewport.ReviewViewportContext.Provider, { value: { store, tabId: options.tabId } },
      createElement(viewport.ReviewPaneContext.Provider, { value: options.paneTab ?? null }, createElement(Editor))));
  await act(async () => { root.render(tree); });
  await settle(10);
  return { store, scrollListeners, async dispose() { await act(async () => root.unmount()); view.destroy(); document.addEventListener = add as typeof document.addEventListener; document.removeEventListener = remove as typeof document.removeEventListener; dom.window.close(); } };
}

test("editors measure the viewport only while a rail follows their document", async () => {
  const h = await mountEditor({ tabId: "tab-1" });
  try {
    assert.equal(h.scrollListeners.count, 0, "an observer was installed with no rail open");
    let release!: () => void;
    await act(async () => { release = h.store.follow("tab-1"); });
    assert.equal(h.scrollListeners.count, 1, "following installs the observer");
    await act(async () => { release(); });
    assert.equal(h.scrollListeners.count, 0, "closing the rail removes it");
  } finally { await h.dispose(); }
});

test("a rail following one document installs no observer in a pane showing another", async () => {
  const h = await mountEditor({ tabId: "tab-1", paneTab: "tab-2" });
  try {
    await act(async () => { h.store.follow("tab-1"); });
    assert.equal(h.scrollListeners.count, 0, "the pane shows tab-2, the rail follows tab-1");
    await act(async () => { h.store.follow("tab-2"); });
    assert.equal(h.scrollListeners.count, 1);
  } finally { await h.dispose(); }
});

/* ---- Comment card clocks ---------------------------------------------------------- */

test("every comment card shares one minute timer, and re-renders only when its label changes", async () => {
  const dom = installDom();
  const { useNow } = await import("../../src/components/libera/markdown-review-ui") as { useNow: (times?: number[]) => number };
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  Object.defineProperty(window, "setInterval", { configurable: true, value: (handler: () => void) => { intervals.set(nextId, handler); return nextId++; } });
  Object.defineProperty(window, "clearInterval", { configurable: true, value: (id: number) => { intervals.delete(id); } });
  const renders = { fresh: 0, old: 0 };
  function Card({ times, which }: { times: number[]; which: "fresh" | "old" }) {
    useNow(times);
    useEffect(() => { renders[which] += 1; });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const old = [now - 3 * 3_600_000];
  const fresh = [now];
  try {
    await act(async () => { root.render(createElement("div", null, ...Array.from({ length: 6 }, (_, index) => createElement(Card, { key: index, times: index < 3 ? fresh : old, which: index < 3 ? "fresh" as const : "old" as const })))); });
    assert.equal(intervals.size, 1, "one interval for six cards");
    const before = { ...renders };
    now += 60_000;
    await act(async () => { for (const tick of [...intervals.values()]) tick(); });
    assert.equal(renders.fresh - before.fresh, 3, "a label that reads \"now\" changes after a minute");
    assert.equal(renders.old - before.old, 0, "a label of hours does not");
    await act(async () => root.unmount());
    assert.equal(intervals.size, 0, "no timer without cards");
  } finally { Date.now = realNow; dom.window.close(); }
});
