import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import type { Editor } from "@tiptap/core";
import { JSDOM } from "jsdom";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { resetPendingSavesForTests } from "../../src/components/libera/pending-saves";
import { applyMarksDiff, marksOf } from "../../src/lib/collab/pdf/model";
import type { PdfAnnotation, PdfTextAnnotation } from "../../src/lib/types";

// The viewer against a live document: the code path a window without the
// desktop bridge never takes. The replica is a stand-in with a real Y.Doc, so
// "someone else" here is a second writer on that same document.

const at = "2026-11-06T10:00:00.000Z";
const highlight = (id: string): PdfAnnotation => ({ id, type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "Selectable", createdAt: at, updatedAt: at });
const note = (id: string, text: string): PdfTextAnnotation => ({ id, type: "text", pageNumber: 1, text, fontSize: 10, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, createdAt: at, updatedAt: at });

test("the PDF viewer on a live document", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "KeyboardEvent", "CustomEvent", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(globalThis, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", { configurable: true, get() { return this.closest('[contenteditable="true"]') !== null; } });
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  Object.assign(globalThis, {
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  const require = createRequire(import.meta.url);
  const pdfModule = require.resolve("pdfjs-dist");
  const pages = Array.from({ length: 2 }, () => ({
    view: [0, 0, 612, 792],
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    getTextContent: async () => ({ items: [{ str: "Selectable PDF text", hasEOL: true, width: 190, height: 10, transform: [10, 0, 0, 10, 100, 700] }], styles: {} }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  }));
  const pdf = { numPages: pages.length, getPage: async (n: number) => pages[n - 1] };
  require.cache[pdfModule] = { exports: {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => {} }),
    TextLayer: class { textDivs: HTMLElement[] = []; async render() {} cancel() {} },
  } } as NodeModule;

  const { createRoot } = await import("react-dom/client");
  const { PdfViewer } = await import("../../src/components/libera/pdf-viewer");
  const { setSharedDocRegistry } = await import("../../src/lib/collab/client/registry");
  const { setCollabStatusStore } = await import("../../src/lib/collab/ui/status-store");

  const projectId = "prj_live_test";
  const status = { phase: "ready" as const, status: { hostVersion: 1, connection: "connected" as const, account: { id: "acc_me", email: "me@example.test", displayName: "Me", color: "#ff8800", serverUrl: "" }, projects: [{ projectId, name: "Papers", role: "commenter" as const, notebook: "Papers", revoked: false, reconcilePending: 0, pdfLive: true }], pendingCommands: 0 } };
  setCollabStatusStore({ subscribe: () => () => {}, getSnapshot: () => status, refresh: async () => {}, refreshProjects: async () => {}, setStatus: () => {} } as never);

  let documents = 0;
  function liveDocument(role: "commenter" | "viewer" = "commenter") {
    const annotations = new Y.Doc();
    const awareness = new Awareness(new Y.Doc());
    const snapshot = { attached: true, meta: { role, readOnly: role === "viewer" }, status: { state: "saved-remote", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: true }, rejection: null, closed: null, error: null, generation: 0 };
    const replica = { annotations, awareness, whenAttached: async () => {}, onRebuild: () => () => {}, subscribe: () => () => {}, getSnapshot: () => snapshot, dismissRejection() {} };
    documents += 1;
    const session = { docId: `pdf_live_doc_${documents}`, resolved: { projectId, path: "Papers/paper.pdf" }, replica };
    setSharedDocRegistry({ available: true, destroy() {}, acquire: () => ({ docId: session.docId, ready: Promise.resolve(session), session: () => session, release() {} }) } as never);
    return { annotations, role, remote: (update: (marks: PdfAnnotation[]) => PdfAnnotation[], before: PdfAnnotation[]) => applyMarksDiff(annotations, before, update(before), { accountId: "acc_them" }, "remote") };
  }

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  function serve(role: "commenter" | "viewer") {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/pdf-docs/resolve")) return Response.json({ docId: `pdf_live_doc_${documents}`, projectId, fileId: "fil_paper_doc", path: "Papers/paper.pdf", role, readOnly: role === "viewer", accountId: "acc_me", blobHash: "a".repeat(64) });
      if (url.startsWith("/api/pdf-comments")) return Response.json({ threads: [] });
      if (url.startsWith("/api/pdf-annotations")) return Response.json({ annotations: [highlight("from-the-sidecar")] });
      return new Response(new Uint8Array([1]));
    };
  }

  const host = document.getElementById("root") as HTMLElement;
  let root = createRoot(host);
  async function mount() {
    await act(async () => { root.render(createElement(PdfViewer, { src: "/paper.pdf", filePath: "Papers/paper.pdf" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  }
  async function unmount() {
    await act(async () => root.unmount());
    root = createRoot(host);
    resetPendingSavesForTests();
    requests.length = 0;
  }
  const notes = () => [...host.querySelectorAll<HTMLElement>(".pdf-note")];
  /** Selects the note, as the press before a double click does, then opens it. */
  async function openNote(element: HTMLElement) {
    for (const type of ["pointerdown", "pointerup"]) await act(async () => { element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0 })); });
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  try {
    await t.test("marks come from the document, and no sidecar is read or written", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("n1", "from the document")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      assert.ok(host.querySelector(".libera-pdf-collab"), "the status strip shows");
      assert.equal(notes().length, 1);
      assert.match(notes()[0].textContent ?? "", /from the document/);
      assert.equal(requests.some((request) => request.includes("/api/pdf-annotations")), false);
      await unmount();
    });

    await t.test("a collaborator's new mark and text appear without a reload", async () => {
      const live = liveDocument();
      serve("commenter");
      await mount();
      assert.equal(notes().length, 0);
      await act(async () => { live.remote((marks) => [...marks, note("n2", "hello")], []); });
      assert.equal(notes().length, 1);
      await act(async () => { live.remote((marks) => marks.map((mark) => ({ ...mark, text: "hello there" }) as PdfAnnotation), [note("n2", "hello")]); });
      assert.match(notes()[0].textContent ?? "", /hello there/);
      await unmount();
    });

    await t.test("undo stays off for someone else's change", async () => {
      const live = liveDocument();
      serve("commenter");
      await mount();
      await act(async () => { live.remote((marks) => [...marks, highlight("h1")], []); });
      const undo = host.querySelector<HTMLButtonElement>("button[aria-label='Undo']");
      assert.equal(undo?.disabled, true);
      await unmount();
    });

    await t.test("a viewer gets no tools", async () => {
      liveDocument("viewer");
      serve("viewer");
      await mount();
      assert.ok(host.querySelector("[data-pdf-read-only]"));
      assert.match(host.textContent ?? "", /View only/);
      await unmount();
    });

    await t.test("deleting elsewhere removes the mark here, and it stays in the document", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("n3", "going")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      assert.equal(notes().length, 1);
      await act(async () => { live.remote(() => [], [note("n3", "going")]); });
      assert.equal(notes().length, 0);
      assert.equal(marksOf(live.annotations).has("n3"), true);
      await unmount();
    });
    await t.test("typing in a note reaches the document, and a collaborator's text merges into the open editor", async () => {
      const live = liveDocument();
      const start = [note("n4", "shared text")];
      applyMarksDiff(live.annotations, [], start, { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      const element = host.querySelector<HTMLElement & { editor?: Editor }>(".pdf-note-editor");
      assert.ok(element?.editor, "the note opened for editing");
      const editor = element.editor;

      // Typing at the end, then the debounce hands it to the document.
      await act(async () => { editor.commands.focus("end"); editor.commands.insertContent(" mine"); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
      const text = () => (marksOf(live.annotations).get("n4")?.get("text") as Y.Text).toString();
      assert.equal(text(), "shared text mine");
      const caret = editor.state.selection.from;

      // Someone else types at the start. Local text survives and the caret stays with it.
      await act(async () => { live.annotations.transact(() => (marksOf(live.annotations).get("n4")?.get("text") as Y.Text).insert(0, "Their "), "remote"); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      assert.equal(editor.getText().trim(), "Their shared text mine");
      assert.equal(editor.state.selection.from, caret + "Their ".length, "the caret moved with the text");
      assert.equal(text(), "Their shared text mine", "taking it in writes nothing back");
      await unmount();
    });

    await t.test("keystrokes not sent yet merge with a collaborator's, instead of being lost", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("n5", "base")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      const editor = (host.querySelector(".pdf-note-editor") as HTMLElement & { editor: Editor }).editor;
      await act(async () => {
        editor.commands.focus("end");
        editor.commands.insertContent(" mine");
        // Inside the debounce: this person's text has not reached the document yet.
        live.annotations.transact(() => (marksOf(live.annotations).get("n5")?.get("text") as Y.Text).insert(0, "Their "), "remote");
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
      const text = (marksOf(live.annotations).get("n5")?.get("text") as Y.Text).toString();
      assert.match(text, /Their/);
      assert.match(text, /mine/);
      assert.equal(editor.getText().trim(), text);
      await unmount();
    });

    await t.test("undo in the viewer takes back only this person's change", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("n6", "base")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      const editor = (host.querySelector(".pdf-note-editor") as HTMLElement & { editor: Editor }).editor;
      await act(async () => { editor.commands.focus("end"); editor.commands.insertContent(" mine"); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
      await act(async () => { live.annotations.transact(() => (marksOf(live.annotations).get("n6")?.set("style", { fontSize: 14 })), "remote"); });
      const undo = host.querySelector<HTMLButtonElement>("button[aria-label='Undo']");
      assert.equal(undo?.disabled, false);
      await act(async () => { undo?.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      const mark = marksOf(live.annotations).get("n6");
      assert.equal((mark?.get("text") as Y.Text).toString(), "base");
      assert.deepEqual(mark?.get("style"), { fontSize: 14 }, "their change stays");
      await unmount();
    });
  } finally {
    await act(async () => root.unmount());
    setCollabStatusStore(null);
    setSharedDocRegistry(null);
    globalThis.fetch = originalFetch;
  }
});
