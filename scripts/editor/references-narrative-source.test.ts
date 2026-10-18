import "./setup.cjs";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { MarkdownCodeMirrorEditor } from "../../src/components/libera/markdown-source/markdown-codemirror-editor";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { ReferenceRenderProvider, type ReferenceAttachmentLocator } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { EditorState } from "@codemirror/state";
import { buildCitationDecorations, citationDecorations, citationHoverSource, openCitationAt, setCitationLibrary } from "../../src/lib/markdown-codemirror/citations";
import { liberaCitations } from "../../src/lib/markdown-codemirror/libera-syntax";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { citationInsertion, narrativeInsertionAllowed, resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import type { ReferenceAttachment } from "../../src/lib/references/types";
import { requestDocumentStyleChange } from "../../src/lib/references/document-style";
import { installReferenceFetch, makeLibrary, type MockServer } from "./references-editors-fixtures";

/* Narrative citations in the two source editors (the harness is the one of
 * references-editors-source.test.ts): Shift+Enter in the `@` popup, hover
 * and chips only for resolved narrative keys. */

let dom: JSDOM;
let restoreFetch: () => void = () => {};
const opened: Array<{ attachment: ReferenceAttachment; locator?: ReferenceAttachmentLocator }> = [];

before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event", "CustomEvent", "DOMRect"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  // A single-line layout: character `i` of a text node sits at x = 8i.
  Object.assign(dom.window.Range.prototype, {
    getClientRects(this: Range) { return [new dom.window.DOMRect(this.startOffset * 8, 0, 8, 20)]; },
    getBoundingClientRect(this: Range) { return new dom.window.DOMRect(this.startOffset * 8, 0, 8, 20); },
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    scrollIntoView() {},
    attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
    detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value(command: string, _ui?: boolean, value?: string) {
      const textarea = document.activeElement as HTMLTextAreaElement | null;
      if (command !== "insertText" || !textarea || textarea.tagName !== "TEXTAREA") return false;
      const start = textarea.selectionStart;
      const next = `${textarea.value.slice(0, start)}${value ?? ""}${textarea.value.slice(textarea.selectionEnd)}`;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, next);
      textarea.setSelectionRange(start + (value ?? "").length, start + (value ?? "").length);
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      return true;
    },
  });
  configureCitationFormatting({ worker: false, clearCache: true });
});
after(() => dom.window.close());

let server: MockServer;
function setup() {
  server = { libraries: { Notes: makeLibrary() }, requests: [], resolve: () => 500 };
  restoreFetch = installReferenceFetch(server);
}
afterEach(() => {
  restoreFetch();
  resetReferenceLibraryCache();
  resetRecentCitations();
  opened.length = 0;
  for (const card of document.querySelectorAll(".citation-hover-card")) card.remove();
});

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

type EditorProps = ComponentProps<typeof MarkdownEditor>;

function baseProps(value: string, changes: string[]): EditorProps {
  return {
    activeFilePath: "Notes/note.md", files: [], formatting: false, fontFamily: "monospace", fontSizePx: 14,
    imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [], textareaRef: createRef<HTMLTextAreaElement>(), value,
    onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
    onChange: (text) => changes.push(text), onInsertFileLink: () => {}, onInsertImageFile: async () => {},
  };
}

function provider(child: ReturnType<typeof createElement>) {
  return createElement(ReferenceRenderProvider, {
    notebook: "Notes",
    onOpenAttachment: (attachment: ReferenceAttachment, locator?: ReferenceAttachmentLocator) => { opened.push({ attachment, locator }); },
  }, child);
}

async function mountTextarea(value: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const textareaRef = createRef<HTMLTextAreaElement>();
  await act(async () => { root.render(provider(createElement(MarkdownEditor, { ...baseProps(value, changes), textareaRef }))); });
  await settle(5);
  const textarea = textareaRef.current!;
  textarea.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 2000, 1000);
  return {
    changes, host, textarea,
    get text() { return textarea.value; },
    async type(text: string, caret = text.length) {
      await act(async () => {
        textarea.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
        textarea.setSelectionRange(caret, caret);
        // React reads textarea edits through its IE input polyfill under jsdom.
        const event = new dom.window.Event("propertychange", { bubbles: true });
        Object.defineProperty(event, "propertyName", { value: "value" });
        textarea.dispatchEvent(event);
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await settle(40);
    },
    async key(key: string, init: KeyboardEventInit = {}) {
      await act(async () => { textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
      await settle(40);
    },
    get selection() { return [textarea.selectionStart, textarea.selectionEnd]; },
    async dispose() { await act(async () => root.unmount()); host.remove(); },
  };
}

async function mountCodeMirror(value: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const adapter = new CodeMirrorTextareaAdapter(value);
  await act(async () => { root.render(provider(createElement(MarkdownCodeMirrorEditor, { ...baseProps(value, changes), adapter }))); });
  await settle(5);
  const view = adapter.editorView! as EditorView;
  // jsdom gives contenteditable no focus; the popup opens only in a focused editor.
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });
  return {
    changes, host, view,
    get text() { return view.state.doc.toString(); },
    async type(text: string, caret = text.length) {
      await act(async () => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: caret }, userEvent: "input.type" });
      });
      await settle(40);
    },
    async key(key: string) {
      await act(async () => { view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      await settle(40);
    },
    get selection() { return [view.state.selection.main.from, view.state.selection.main.to]; },
    async dispose() { await act(async () => root.unmount()); host.remove(); },
  };
}

type Mounted = Awaited<ReturnType<typeof mountTextarea>> | Awaited<ReturnType<typeof mountCodeMirror>>;
const EDITORS: Array<[string, (value: string) => Promise<Mounted>]> = [["textarea", mountTextarea], ["CodeMirror", mountCodeMirror]];
const popup = () => document.querySelector<HTMLElement>("[data-citation-popup]");

// ---------------------------------------------------------------------------
// Narrative citations in the source editors
// ---------------------------------------------------------------------------

const hint = () => document.querySelector<HTMLElement>("[data-citation-popup-hint]");

async function shiftEnter(editor: Mounted) {
  const target = "textarea" in editor ? editor.textarea : editor.view.contentDOM;
  await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); });
  await settle(40);
}

for (const [name, mount] of EDITORS) {
  test(`${name}: Shift+Enter inserts a narrative @key; the popup says so and stays closed after it`, async () => {
    setup();
    const editor = await mount("");
    try {
      await editor.type("As @smi argues", 7);
      assert.ok(popup(), "the popup opened");
      assert.match(hint()!.textContent!, /Shift\+Enter cites in the text/);
      await shiftEnter(editor);
      assert.equal(editor.text, "As @smith2020sparse argues");
      assert.deepEqual(editor.selection, [19, 19]);
      assert.equal(popup() === null, true, "the inserted key does not reopen the popup");
      await settle(60);
      assert.equal(popup() === null, true);

      // Inside brackets, and after `-`, the narrative form does not apply: Shift+Enter inserts as Enter does.
      await editor.type("[see @smi");
      assert.equal(hint() === null, true, "no hint inside a citation");
      await shiftEnter(editor);
      assert.equal(editor.text, "[see @smith2020sparse");
      await editor.type("Text -@smi");
      await shiftEnter(editor);
      assert.equal(editor.text, "Text -[@smith2020sparse]");
    } finally {
      await editor.dispose();
    }
  });
}

test("textarea: only a resolved narrative citation has a hover card", async () => {
  setup();
  const text = "@smith2020sparse [p. 12] and @nobody here.";
  const editor = await mountTextarea(text);
  try {
    await settle(50);
    const at = (offset: number) => ({ clientX: offset * 8 + 4, clientY: 10, bubbles: true, cancelable: true });
    await act(async () => { editor.textarea.dispatchEvent(new dom.window.MouseEvent("mousemove", at(5))); });
    await settle(300);
    const card = document.querySelector<HTMLElement>(".citation-hover-card");
    assert.equal(card !== null, true, "the card opened");
    assert.match(card!.textContent!, /Open PDF at p\. 12/);
    await act(async () => { editor.textarea.dispatchEvent(new dom.window.MouseEvent("mousemove", at(32))); });
    await settle(300);
    assert.equal(document.querySelector(".citation-hover-card") === null, true, "@nobody is text");
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror: narrative chips only where the library knows the key; hover and click follow", async () => {
  setup();
  const editor = await mountCodeMirror("@smith2020sparse [p. 12] and @nobody and [@lee2019graphs].");
  try {
    await settle(30);
    const chips = [...editor.view.contentDOM.querySelectorAll(".cm-libera-citation")].map((chip) => chip.textContent);
    assert.deepEqual(chips, ["@smith2020sparse [p. 12]", "[@lee2019graphs]"]);
    assert.equal(editor.view.contentDOM.querySelectorAll(".cm-libera-citation-key-unresolved").length, 0, "@nobody is never red");
    assert.equal(citationHoverSource(editor.view, 31, 1), null, "no hover for @nobody");
    assert.deepEqual([citationHoverSource(editor.view, 3, 1)!.pos, citationHoverSource(editor.view, 3, 1)!.end], [0, 24]);
    assert.equal(openCitationAt(editor.view, 3), true);
    assert.deepEqual(opened, [{ attachment: { kind: "pdf", path: "Notes/papers/smith.pdf" }, locator: { label: "page", locator: "12", page: 12 } }]);
    assert.equal(openCitationAt(editor.view, 31), false);
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror decorations: without a library no narrative candidate is drawn", () => {
  const state = EditorState.create({ doc: "@smith2020sparse and [@x]", extensions: [citationDecorations()] });
  const citations = liberaCitations(state)!;
  const ranges = (decorations: ReturnType<typeof buildCitationDecorations>) => {
    const found: Array<[number, number, string]> = [];
    decorations.between(0, state.doc.length, (from, to, value) => { found.push([from, to, String(value.spec.class)]); });
    return found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  };
  assert.deepEqual(ranges(buildCitationDecorations(state, citations)), [[21, 25, "cm-libera-citation"], [23, 24, "cm-libera-citation-key"]]);
  const known = state.update({ effects: setCitationLibrary.of({ has: (key) => key === "smith2020sparse" }) }).state;
  assert.deepEqual(ranges(buildCitationDecorations(known, citations)).map(([from, to]) => [from, to]), [[0, 16], [1, 16], [21, 25], [23, 24]]);
});

test("citationInsertion: the narrative form where it reads as one", () => {
  assert.deepEqual(citationInsertion("a", false, false, { narrative: true, before: " " }), { text: "@a", caret: 2 });
  assert.deepEqual(citationInsertion("a", false, false, { narrative: true, before: "" }), { text: "@a", caret: 2 });
  assert.deepEqual(citationInsertion("a", false, false, { narrative: true, before: "(" }), { text: "@a", caret: 2 });
  assert.deepEqual(citationInsertion("a", false, false, { narrative: true, before: "-" }), { text: "[@a]", caret: 4 });
  assert.deepEqual(citationInsertion("a", true, false, { narrative: true, before: " " }), { text: "@a", caret: 2 });
  assert.equal(narrativeInsertionAllowed(true, " "), false);
  assert.equal(narrativeInsertionAllowed(false, ";"), false);
});

for (const [name, mount] of EDITORS) {
  test(`${name}: a Document style request for its path edits the front matter in its draft`, async () => {
    setup();
    const editor = await mount("Text [@lee2019graphs].");
    try {
      let applied = false;
      await act(async () => { applied = requestDocumentStyleChange("Notes/note.md", "ieee"); });
      await settle(20);
      assert.equal(applied, true);
      assert.equal(editor.text, "---\ncitation-style: ieee\n---\n\nText [@lee2019graphs].");
      await act(async () => { applied = requestDocumentStyleChange("Notes/other.md", "apa"); });
      assert.equal(applied, false, "another document's request");
      await act(async () => { requestDocumentStyleChange("Notes/note.md", null); });
      await settle(20);
      assert.equal(editor.text, "Text [@lee2019graphs].");
    } finally {
      await editor.dispose();
    }
  });
}
