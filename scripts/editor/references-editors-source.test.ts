import "./setup.cjs";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { MarkdownCodeMirrorEditor } from "../../src/components/libera/markdown-source/markdown-codemirror-editor";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { ReferenceRenderProvider, type ReferenceAttachmentLocator } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { citationHoverSource, openCitationAt } from "../../src/lib/markdown-codemirror/citations";
import { liberaCitationScanCount } from "../../src/lib/markdown-codemirror/libera-syntax";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import { REFERENCES_ADD_REQUEST_EVENT, type ReferenceAttachment, type ReferencesAddRequestDetail } from "../../src/lib/references/types";
import { installReferenceFetch, makeLibrary, type MockServer } from "./references-editors-fixtures";

/* The `@` popup, citation chips, hover and Ctrl/Cmd+click in the two source
 * editors: the textarea editor and the CodeMirror Source editor. */

let dom: JSDOM;
let restoreFetch: () => void = () => {};
let insertTextCalls = 0;
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
      insertTextCalls += 1;
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

for (const [name, mount] of EDITORS) {
  test(`${name}: entering a file-link destination clears the last inserted citation dismissal`, async () => {
    setup();
    const editor = await mount("");
    const target = "textarea" in editor ? editor.textarea : editor.view.contentDOM;
    try {
      await editor.type("[@sm] [file](", 4);
      await editor.key("Enter");
      const text = editor.text;
      assert.match(text, /^\[@(?:smith2020sparse|smythe2021)\]/);
      assert.equal(popup(), null);
      await editor.type(text, text.length);
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      await settle(30);
      assert.equal(popup(), null, "a link destination owns its picker");
      await editor.type(text, text.indexOf("]"));
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      await settle(30);
      assert.ok(popup(), "returning to the previously inserted key is a new query");
    } finally { await editor.dispose(); }
  });

  test(`${name}: citation hover uses the shared dismissal rules and Ctrl+click excludes trailing whitespace`, async () => {
    setup();
    const editor = await mount("See [@smith2020sparse, p. 12] and text.");
    const target = "textarea" in editor ? editor.textarea : editor.view.contentDOM;
    if ("view" in editor) {
      editor.view.posAtCoords = ({ x }) => Math.floor(x / 8);
      editor.view.coordsAtPos = (offset) => ({ left: offset * 8, right: offset * 8, top: 0, bottom: 20 });
    }
    const at = (offset: number) => ({ clientX: offset * 8 + 4, clientY: 10, bubbles: true, cancelable: true });
    try {
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent("mousemove", at(8))); });
      await settle(300);
      assert.ok(document.querySelector('[aria-label="Citation details"]'));
      await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
      assert.equal(document.querySelector('[aria-label="Citation details"]'), null);
      const outside = new dom.window.MouseEvent("mousedown", { ...at(29), ctrlKey: true, button: 0 });
      await act(async () => { target.dispatchEvent(outside); });
      assert.equal(opened.length, 0);
      const inside = new dom.window.MouseEvent("mousedown", { ...at(10), ctrlKey: true, button: 0 });
      await act(async () => { target.dispatchEvent(inside); });
      assert.equal(inside.defaultPrevented, true);
      assert.equal(opened[0].locator?.page, 12);
    } finally { await editor.dispose(); }
  });
}

// [label, text, caret (default: the end)]
const NO_TRIGGER: Array<[string, string, number?]> = [
  ["email", "Write to me@exa"],
  ["code span", "Use `x @sm` here", 10],
  ["fenced code", "```\n@sm"],
  ["inline math", "Cost $x @sm$", 11],
  ["link destination", "[a](@sm"],
  ["front matter", "---\ntitle: @sm\n---\n\nBody", 14],
  ["word", "foo@sm"],
];

for (const [name, mount] of EDITORS) {
  test(`${name}: @ opens the popup in prose and never in emails, code, math, link destinations or front matter`, async () => {
    setup();
    const editor = await mount("");
    try {
      await editor.type("See @sm");
      assert.ok(popup(), "prose opens the popup");
      assert.deepEqual([...popup()!.querySelectorAll<HTMLElement>("[data-citation-key]")].map((row) => row.dataset.citationKey), ["smythe2021", "smith2020sparse"]);
      for (const [label, text, caret] of NO_TRIGGER) {
        await editor.type(text, caret);
        assert.equal(popup() === null, true, label);
      }
      await editor.type("(@");
      assert.equal(popup() !== null, true, "after a parenthesis");
      await editor.key("Escape");
      assert.equal(popup() === null, true, "Escape closes");
    } finally {
      await editor.dispose();
    }
  });

  test(`${name}: Enter inserts [@key], Tab puts the caret at the locator, inside a citation only the key`, async () => {
    setup();
    const editor = await mount("");
    try {
      await editor.type("See @smith end", 10);
      await editor.key("Enter");
      assert.equal(editor.text, "See [@smith2020sparse] end");
      assert.deepEqual(editor.selection, [22, 22]);
      assert.equal(popup() === null, true);

      await editor.type("See @smi");
      await editor.key("Tab");
      assert.equal(editor.text, "See [@smith2020sparse, ]");
      assert.deepEqual(editor.selection, [23, 23]);

      await editor.type("[@lee2019graphs; @smi]", 21);
      assert.equal(popup() !== null, true);
      await editor.key("Enter");
      assert.equal(editor.text, "[@lee2019graphs; @smith2020sparse]");

      await editor.type("[see @smi");
      await editor.key("Enter");
      assert.equal(editor.text, "[see @smith2020sparse");
    } finally {
      await editor.dispose();
    }
  });
}

test("textarea: the insertion is one native edit (one undo step)", async () => {
  setup();
  const editor = await mountTextarea("");
  try {
    await editor.type("See @smi");
    insertTextCalls = 0;
    await editor.key("Enter");
    assert.equal(insertTextCalls, 1);
    assert.equal(editor.text, "See [@smith2020sparse]");
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror: the insertion is one undo step", async () => {
  setup();
  const editor = await mountCodeMirror("");
  try {
    await editor.type("See @smi");
    await editor.key("Enter");
    assert.equal(editor.text, "See [@smith2020sparse]");
    act(() => { undo(editor.view); });
    assert.equal(editor.text, "See @smi");
  } finally {
    await editor.dispose();
  }
});

test("textarea: hovering a citation shows the citation card; Ctrl+click opens the PDF at the page", async () => {
  setup();
  const text = "See [@smith2020sparse, p. 12] and [@nobody].";
  const editor = await mountTextarea(text);
  try {
    const at = (offset: number) => ({ clientX: offset * 8 + 4, clientY: 10, bubbles: true, cancelable: true });
    await act(async () => { editor.textarea.dispatchEvent(new dom.window.MouseEvent("mousemove", at(8))); });
    await settle(300);
    const card = document.querySelector<HTMLElement>(".citation-hover-card");
    assert.equal(card !== null, true, "the card opened");
    assert.match(card!.textContent!, /@smith2020sparse/);
    assert.match(card!.textContent!, /Open PDF at p\. 12/);
    await act(async () => { editor.textarea.dispatchEvent(new dom.window.MouseEvent("mousemove", at(2))); });
    await settle(300);
    assert.equal(document.querySelector(".citation-hover-card") === null, true, "leaving the citation closes the card");

    const down = new dom.window.MouseEvent("mousedown", { ...at(10), ctrlKey: true, button: 0 });
    await act(async () => { editor.textarea.dispatchEvent(down); });
    assert.equal(down.defaultPrevented, true);
    assert.deepEqual(opened, [{ attachment: { kind: "pdf", path: "Notes/papers/smith.pdf" }, locator: { label: "page", locator: "12", page: 12 } }]);
    // A plain click, or Ctrl+click outside a citation, does nothing special.
    const plain = new dom.window.MouseEvent("mousedown", { ...at(10), button: 0 });
    editor.textarea.dispatchEvent(plain);
    assert.equal(plain.defaultPrevented, false);
    editor.textarea.dispatchEvent(new dom.window.MouseEvent("mousedown", { ...at(1), ctrlKey: true, button: 0 }));
    assert.equal(opened.length, 1);
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror: chips mark citations and unresolved keys, without rescanning an unchanged document", async () => {
  setup();
  const editor = await mountCodeMirror("See [@smith2020sparse, p. 12; @nobody] and `[@code]`.");
  try {
    await settle(20);
    const chips = [...editor.view.contentDOM.querySelectorAll(".cm-libera-citation")];
    assert.equal(chips.length, 1);
    assert.ok(chips[0].classList.contains("cm-libera-citation-unresolved"));
    const keys = [...editor.view.contentDOM.querySelectorAll(".cm-libera-citation-key")].map((key) => [key.textContent, key.classList.contains("cm-libera-citation-key-unresolved")]);
    assert.deepEqual(keys, [["smith2020sparse", false], ["nobody", true]]);

    const scans = liberaCitationScanCount();
    act(() => { editor.view.dispatch({ selection: { anchor: 3 } }); });
    act(() => { editor.view.dispatch({ scrollIntoView: true }); });
    assert.equal(liberaCitationScanCount(), scans, "selection and scrolling reuse the scan");
    act(() => { editor.view.dispatch({ changes: { from: 0, insert: "x" } }); });
    assert.equal(liberaCitationScanCount(), scans + 1, "an edit scans the new version once");
    assert.equal(editor.view.contentDOM.querySelectorAll(".cm-libera-citation").length, 1);
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror: the hover tooltip shows the shared card, or Not in library with Add to library", async () => {
  setup();
  const editor = await mountCodeMirror("See [@smith2020sparse, p. 12] and [@nobody].");
  try {
    await settle(20);
    assert.equal(citationHoverSource(editor.view, 1, 1), null);
    const tooltip = citationHoverSource(editor.view, 8, 1)!;
    assert.deepEqual([tooltip.pos, tooltip.end], [4, 29]);
    let view: ReturnType<typeof tooltip.create> | undefined;
    await act(async () => { view = tooltip.create(); });
    await settle(5);
    assert.match(view!.dom.textContent!, /@smith2020sparse/);
    assert.match(view!.dom.textContent!, /Open PDF at p\. 12/);
    await act(async () => { view!.destroy?.(); });

    const missing = citationHoverSource(editor.view, 37, 1)!;
    let missingView: ReturnType<typeof missing.create> | undefined;
    await act(async () => { missingView = missing.create(); });
    assert.match(missingView!.dom.textContent!, /Not in this notebook's references/);
    const requests: ReferencesAddRequestDetail[] = [];
    const listener = (event: Event) => requests.push((event as CustomEvent<ReferencesAddRequestDetail>).detail);
    window.addEventListener(REFERENCES_ADD_REQUEST_EVENT, listener);
    const add = [...missingView!.dom.querySelectorAll("button")].find((button) => button.textContent === "Add to library…")!;
    await act(async () => { add.click(); });
    window.removeEventListener(REFERENCES_ADD_REQUEST_EVENT, listener);
    assert.deepEqual(requests, [{ notebook: "Notes", query: "nobody" }]);
    await act(async () => { missingView!.destroy?.(); });
  } finally {
    await editor.dispose();
  }
});

test("CodeMirror: Ctrl/Cmd+click on a citation opens its attachment at the cited page", async () => {
  setup();
  const editor = await mountCodeMirror("See [@smith2020sparse, p. 12] and [@nobody].");
  try {
    await settle(20);
    assert.equal(openCitationAt(editor.view, 10), true);
    assert.deepEqual(opened, [{ attachment: { kind: "pdf", path: "Notes/papers/smith.pdf" }, locator: { label: "page", locator: "12", page: 12 } }]);
    assert.equal(openCitationAt(editor.view, 37), false, "no attachment for an unresolved key");
    assert.equal(openCitationAt(editor.view, 1), false);
  } finally {
    await editor.dispose();
  }
});
