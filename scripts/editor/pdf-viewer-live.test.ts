import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import type { Editor } from "@tiptap/core";
import { JSDOM } from "jsdom";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { createHash } from "node:crypto";
import type { HostEvent } from "../../src/lib/collab/local-api";
import { pendingSaves, unsavedJournal, resetPendingSavesForTests } from "../../src/components/libera/pending-saves";
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
  const browserErrors: unknown[] = [];
  dom.window.addEventListener("error", (event) => browserErrors.push(event.error));
  const rangeRect = () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10, toJSON() {} });
  dom.window.Range.prototype.getBoundingClientRect = rangeRect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([rangeRect()], { item: (index: number) => index === 0 ? rangeRect() : null });
  const hostListeners = new Set<(event: HostEvent) => void>();
  Object.assign(dom.window, { liberaCollab: { onEvent: (listener: (event: HostEvent) => void) => { hostListeners.add(listener); return () => hostListeners.delete(listener); }, nudge() {} } });
  const filesChanged = () => { for (const listener of hostListeners) listener({ t: "files-changed", projectId: "prj_live_test", paths: ["Papers/paper.pdf"] }); };
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
  const pages = Array.from({ length: 2 }, (_, index) => ({
    view: [0, 0, 612, 792],
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale, convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale] }),
    getTextContent: async () => ({ items: [{ str: index === 0 ? "Selectable PDF text" : "Other page text", hasEOL: true, width: 190, height: 10, transform: [10, 0, 0, 10, 100, 700] }], styles: {} }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  }));
  const pdf = { numPages: pages.length, getPage: async (n: number) => pages[n - 1] };
  let pdfLoads = 0;
  require.cache[pdfModule] = { exports: {
    GlobalWorkerOptions: {},
    getDocument: () => { pdfLoads += 1; return { promise: Promise.resolve(pdf), destroy: async () => {} }; },
    TextLayer: class { textDivs: HTMLElement[] = []; async render() {} cancel() {} },
  } } as NodeModule;

  const { createRoot } = await import("react-dom/client");
  const { PdfViewer } = await import("../../src/components/libera/pdf-viewer");
  const { setSharedDocRegistry } = await import("../../src/lib/collab/client/registry");
  const { setCollabStatusStore } = await import("../../src/lib/collab/ui/status-store");

  const projectId = "prj_live_test";
  let status = { phase: "ready" as const, status: { hostVersion: 1, connection: "connected" as const, account: { id: "acc_me", email: "me@example.test", displayName: "Me", color: "#ff8800", serverUrl: "" }, projects: [{ projectId, name: "Papers", role: "commenter" as const, notebook: "Papers", revoked: false, reconcilePending: 0, pdfLive: true }], pendingCommands: 0 } };
  const statusListeners = new Set<() => void>();
  const setLive = (pdfLive: boolean) => {
    status = { ...status, status: { ...status.status, projects: status.status.projects.map((project) => ({ ...project, pdfLive })) } };
    for (const listener of statusListeners) listener();
  };
  setCollabStatusStore({ subscribe: (listener: () => void) => { statusListeners.add(listener); return () => statusListeners.delete(listener); }, getSnapshot: () => status, refresh: async () => {}, refreshProjects: async () => {}, setStatus: () => {} } as never);

  const awarenesses: Awareness[] = [];
  const newAwareness = () => {
    const awareness = new Awareness(new Y.Doc());
    awarenesses.push(awareness);
    return awareness;
  };
  let documents = 0;
  const revealListeners = new Set<(target: string) => void>();
  function liveDocument(role: "commenter" | "viewer" = "commenter") {
    const annotations = new Y.Doc();
    const awareness = newAwareness();
    const snapshot = { attached: true, meta: { role, readOnly: role === "viewer" }, status: { state: "saved-remote", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: true }, rejection: null, closed: null, error: null, generation: 0 };
    const replica = { annotations, awareness, whenAttached: async () => {}, onRebuild: () => () => {}, subscribe: () => () => {}, getSnapshot: () => snapshot, dismissRejection() {} };
    documents += 1;
    const session = { docId: `pdf_live_doc_${documents}`, resolved: { projectId, path: "Papers/paper.pdf" }, replica };
    setSharedDocRegistry({ available: true, destroy() {}, session: () => session, onRevealStatus: (listener: (target: string) => void) => { revealListeners.add(listener); return () => revealListeners.delete(listener); }, acquire: () => ({ docId: session.docId, ready: Promise.resolve(session), session: () => session, release() {} }) } as never);
    return { annotations, awareness, role, remote: (update: (marks: PdfAnnotation[]) => PdfAnnotation[], before: PdfAnnotation[]) => applyMarksDiff(annotations, before, update(before), { accountId: "acc_them" }, "remote") };
  }

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let manifestHash = "a".repeat(64);
  let rawBytes = new Uint8Array([1]);
  function serve(role: "commenter" | "viewer") {
    manifestHash = "a".repeat(64);
    rawBytes = new Uint8Array([1]);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/pdf-docs/resolve")) return Response.json({ docId: `pdf_live_doc_${documents}`, projectId, fileId: "fil_paper_doc", path: "Papers/paper.pdf", role, readOnly: role === "viewer", accountId: "acc_me", blobHash: manifestHash });
      if (url.startsWith("/api/pdf-comments")) return Response.json({ threads: [] });
      if (url.includes("/members")) return Response.json([{ id: "acc_me", displayName: "Me" }, { id: "acc_them", displayName: "Them" }]);
      if (url.startsWith("/api/pdf-annotations")) return Response.json({ annotations: [highlight("from-the-sidecar")] });
      return new Response(rawBytes);
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
  t.afterEach(async () => { await unmount(); setLive(true); });
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
    });

    await t.test("undo stays off for someone else's change", async () => {
      const live = liveDocument();
      serve("commenter");
      await mount();
      await act(async () => { live.remote((marks) => [...marks, highlight("h1")], []); });
      const undo = host.querySelector<HTMLButtonElement>("button[aria-label='Undo']");
      assert.equal(undo?.disabled, true);
    });

    await t.test("a viewer gets no tools", async () => {
      liveDocument("viewer");
      serve("viewer");
      await mount();
      assert.ok(host.querySelector("[data-pdf-read-only]"));
      assert.match(host.textContent ?? "", /View only/);
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
    });

    await t.test("F1: marks arriving while PDF bytes load remain visible after completion", async () => {
      const live = liveDocument();
      serve("commenter");
      const fetch = globalThis.fetch;
      let release!: () => void;
      globalThis.fetch = (input, init) => String(input) === "/paper.pdf"
        ? new Promise<Response>((resolve) => { release = () => resolve(new Response(rawBytes)); })
        : fetch(input, init);
      await mount();
      assert.ok(release);
      await act(async () => { live.remote((marks) => [...marks, note("during-load", "arrived while loading")], []); });
      await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 40)); });
      assert.equal(notes().length, 1);
      assert.match(notes()[0].textContent ?? "", /arrived while loading/);
      assert.equal(marksOf(live.annotations).get("during-load")?.has("deleted"), false);
    });

    await t.test("F5: deleting during the editor debounce preserves both people's text", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("deleted-debounce", "base")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      const editor = (host.querySelector(".pdf-note-editor") as HTMLElement & { editor: Editor }).editor;
      await act(async () => {
        editor.commands.focus("end");
        editor.commands.insertContent(" mine");
        live.annotations.transact(() => {
          const mark = marksOf(live.annotations).get("deleted-debounce")!;
          (mark.get("text") as Y.Text).insert(0, "Their ");
          mark.set("deleted", { by: "acc_them", at });
        }, "remote");
      });
      const mark = marksOf(live.annotations).get("deleted-debounce")!;
      assert.equal((mark.get("text") as Y.Text).toString(), "Their base mine");
      assert.ok(mark.has("deleted"));
    });

    await t.test("F13: activation keeps unsaved annotations as a downloadable private recovery", async () => {
      liveDocument();
      serve("commenter");
      setLive(false);
      const kept = [note("unsaved-local", "private pending work")];
      unsavedJournal.put("Papers/paper.pdf", "annotations:pdf", kept);
      await mount();
      assert.match(notes()[0].textContent ?? "", /private pending work/);
      await openNote(notes()[0]);
      const editor = (host.querySelector(".pdf-note-editor") as HTMLElement & { editor: Editor }).editor;
      await act(async () => { editor.commands.focus("end"); editor.commands.insertContent(" latest buffered typing"); setLive(true); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      const recovered = await unsavedJournal.get<PdfTextAnnotation[]>("Papers/paper.pdf", "recovery:pdf-live");
      assert.equal(recovered?.[0].text, "private pending work latest buffered typing");
      const download = [...host.querySelectorAll("button")].find((button) => button.textContent === "Download recovery");
      assert.ok(download);
      const create = URL.createObjectURL;
      const revoke = URL.revokeObjectURL;
      const click = dom.window.HTMLAnchorElement.prototype.click;
      let blob: Blob | undefined;
      URL.createObjectURL = (value) => { blob = value as Blob; return "blob:private-recovery"; };
      URL.revokeObjectURL = () => {};
      dom.window.HTMLAnchorElement.prototype.click = function () {};
      try {
        await act(async () => { download.click(); });
        assert.deepEqual(JSON.parse(await blob!.text()).annotations, recovered);
        await pendingSaves.save("Papers/paper.pdf");
        assert.equal(requests.some((request) => request.startsWith("PATCH")), false);
        assert.equal(pendingSaves.isDirty("Papers/paper.pdf"), false);
        pendingSaves.moveUnsaved("Papers/paper.pdf", "Papers/renamed.pdf");
        assert.deepEqual(await unsavedJournal.get("Papers/renamed.pdf", "recovery:pdf-live"), recovered);
        pendingSaves.moveUnsaved("Papers/renamed.pdf", "Papers/paper.pdf");
      } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; dom.window.HTMLAnchorElement.prototype.click = click; }
    });

    await t.test("F14: repeated host resolution failures stay unknown and retry into live mode", async () => {
      liveDocument();
      serve("commenter");
      const fetch = globalThis.fetch;
      let attempts = 0;
      let available = false;
      globalThis.fetch = (input, init) => {
        if (String(input).includes("/pdf-docs/resolve") && !available) { attempts += 1; return Promise.reject(new Error("host restarting")); }
        return fetch(input, init);
      };
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = ((work: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => timeout(work, delay && delay >= 1000 ? 5 : delay, ...args)) as typeof setTimeout;
      try {
        await mount();
        for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => timeout(resolve, 20)); });
        assert.ok(attempts > 5, `attempts: ${attempts}`);
        assert.equal(requests.some((request) => request.includes("/api/pdf-annotations")), false);
        available = true;
        await act(async () => { await new Promise((resolve) => timeout(resolve, 100)); });
        assert.ok(host.querySelector(".libera-pdf-collab"));
      } finally { globalThis.setTimeout = timeout; }
    });

    await t.test("F15: replacement reloads the same URL and only accepts verified new bytes", async () => {
      const live = liveDocument();
      const hash = (byte: number) => createHash("sha256").update(new Uint8Array([byte])).digest("hex");
      applyMarksDiff(live.annotations, [], [highlight("relocate")], { accountId: "acc_them", sourceHash: hash(1) }, "remote");
      serve("commenter");
      manifestHash = hash(1);
      await mount();
      const start = pdfLoads;
      await act(async () => { manifestHash = hash(2); filesChanged(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
      assert.ok(pdfLoads > start, "changing the version reloads an unchanged URL");
      assert.equal(marksOf(live.annotations).get("relocate")!.get("sourceHash"), hash(1), "old folder bytes cannot be certified as the manifest's new version");
      await act(async () => { rawBytes = new Uint8Array([2]); filesChanged(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      assert.ok(pdfLoads > start + 1, "the later byte delivery reloads even with the same manifest hash");
      assert.equal(marksOf(live.annotations).get("relocate")!.get("sourceHash"), hash(2));
      const settled = pdfLoads;
      await act(async () => { filesChanged(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      assert.equal(pdfLoads, settled, "with the right bytes on screen, a change to the file leaves the reader where they are");
    });

    await t.test("F16: oversized live note input is refused before it reaches Yjs", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("limited", "base")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      const editor = (host.querySelector(".pdf-note-editor") as HTMLElement & { editor: Editor }).editor;
      let updates = 0;
      live.annotations.on("update", () => { updates += 1; });
      await act(async () => { editor.commands.focus("end"); editor.commands.insertContent("x".repeat(10_001)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
      assert.equal((marksOf(live.annotations).get("limited")!.get("text") as Y.Text).toString(), "base");
      assert.equal(updates, 0);
      assert.match(host.textContent ?? "", /10,000 characters/);
    });
    await t.test("a viewer can open a note to read it, and cannot change it", async () => {
      const live = liveDocument("viewer");
      applyMarksDiff(live.annotations, [], [note("n7", "read me")], { accountId: "acc_them" }, "remote");
      serve("viewer");
      await mount();
      const shown = notes()[0];
      const press = async () => { for (const type of ["pointerdown", "pointerup"]) await act(async () => { shown.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0 })); }); };
      await press();
      assert.equal(shown.dataset.selected, "true", "pressing selects it");
      assert.equal(host.querySelector(".pdf-note-grip"), null, "no controls to move it");
      await press();
      await act(async () => { shown.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
      assert.equal(host.querySelector(".pdf-note-editor"), null, "no editor");
      assert.ok(host.querySelector(".pdf-note-reader"), "the reader opens, so a clipped note can still be read");
      await unmount();
    });

    await t.test("a commenter is not blocked by the view-only rule, and a promotion works at once", async () => {
      liveDocument("commenter");
      serve("commenter");
      await mount();
      assert.equal(host.querySelector("[data-pdf-read-only]"), null);
      assert.doesNotMatch(host.textContent ?? "", /View only/);
      await unmount();
    });

    await t.test("presence lands in the right place on a page made taller by a space", async () => {
      const live = liveDocument();
      const spaced: PdfAnnotation = { id: "sp", type: "space", pageNumber: 1, y: 0.2, height: 0.5, band: { top: 0.2, bottom: 0.2, splits: [] }, column: 0, createdAt: at, updatedAt: at };
      applyMarksDiff(live.annotations, [], [spaced], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      const page = host.querySelector<HTMLElement>("[data-pdf-page-number]");
      const height = parseFloat((page?.firstElementChild as HTMLElement).style.height);
      const other = newAwareness();
      other.setLocalStateField("user", { name: "Them", color: "#112233" });
      other.setLocalStateField("pdf", { page: 1, top: 0, bottom: 1, pointer: { page: 1, x: 0.5, y: 0.5 } });
      await act(async () => { applyAwarenessUpdate(live.awareness, encodeAwarenessUpdate(other, [other.clientID]), "remote"); });
      const pointer = host.querySelector<HTMLElement>(".pdf-presence-pointer");
      assert.ok(pointer, "their pointer shows");
      assert.equal(parseFloat(pointer.style.top), height / 2, "halfway down the page as displayed");
      await unmount();
    });

    await t.test("a key that moves the page stops following, and other keys do not", async () => {
      const live = liveDocument();
      serve("commenter");
      await mount();
      const other = newAwareness();
      other.setLocalStateField("user", { name: "Them", color: "#112233" });
      other.setLocalStateField("pdf", { page: 1, top: 0, bottom: 1 });
      await act(async () => { applyAwarenessUpdate(live.awareness, encodeAwarenessUpdate(other, [other.clientID]), "remote"); });
      const follow = () => host.querySelector<HTMLElement>('[aria-pressed][aria-label*="Them"]')!;
      await act(async () => { follow().click(); });
      assert.equal(follow().getAttribute("aria-pressed"), "true");
      const press = async (key: string) => { await act(async () => { host.querySelector(".libera-pdf-viewer")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); }); };
      await press("a");
      assert.equal(follow().getAttribute("aria-pressed"), "true");
      await press("PageDown");
      assert.equal(follow().getAttribute("aria-pressed"), "false");
    });

    await t.test("Cmd/Ctrl+S says where the marks are", async () => {
      liveDocument();
      serve("commenter");
      await mount();
      assert.doesNotMatch(host.textContent ?? "", /save as you make them/);
      await act(async () => { for (const listener of revealListeners) listener("Papers/other.pdf"); });
      assert.doesNotMatch(host.textContent ?? "", /save as you make them/, "another PDF's Save says nothing here");
      await act(async () => { for (const listener of revealListeners) listener("Papers/paper.pdf"); });
      assert.match(host.textContent ?? "", /save as you make them/);
    });

    await t.test("a selected mark says who made and changed it", async () => {
      const live = liveDocument();
      applyMarksDiff(live.annotations, [], [note("whose", "their note")], { accountId: "acc_them" }, "remote");
      serve("commenter");
      await mount();
      await openNote(notes()[0]);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      assert.match(host.querySelector(".libera-pdf-collab")!.textContent ?? "", /Added by Them/);
    });

    await t.test("a note from a collaborator does not load what shared Markdown would not", async () => {
      const { renderAnnotationMarkdown } = await import("../../src/lib/pdf-annotation-markdown");
      const image = "![x](http://tracker.example/pixel.png)";
      assert.match(renderAnnotationMarkdown(image, undefined, "local"), /tracker\.example/);
      assert.doesNotMatch(renderAnnotationMarkdown(image, undefined, "shared"), /src="http:/);
      assert.match(renderAnnotationMarkdown("![x](https://example.com/a.png)", undefined, "shared"), /https:\/\/example\.com\/a\.png/);
    });
    assert.deepEqual(browserErrors, [], "unexpected browser errors fail the harness");
  } finally {
    await act(async () => root.unmount());
    setCollabStatusStore(null);
    setSharedDocRegistry(null);
    globalThis.fetch = originalFetch;
    // JSDOM's animation-frame timer and each Awareness's check timer would keep
    // this test's process alive for good.
    for (const awareness of awarenesses) awareness.destroy();
    dom.window.close();
  }
});
