import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, cloneElement, createElement, createRef, type ComponentProps, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { undo } from "@codemirror/commands";
import { type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownCodeMirrorEditor } from "../../src/components/libera/markdown-source/markdown-codemirror-editor";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { DOCUMENT_STYLE_REQUEST_EVENT } from "../../src/lib/references/document-style";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { newReview, syncReview } from "../../src/lib/markdown-review";

/* Run identical observable scenarios through the two Source editors. Browser
 * typing/layout and native undo are represented by the existing jsdom seams. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event", "CustomEvent", "DOMRect"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
// React's input-event fallback expects these IE hooks when jsdom moves focus
// into a controlled input.
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
});
// A browser's insertText for the textarea editor, which the parity cases run.
Object.defineProperty(document, "execCommand", {
  configurable: true,
  value(command: string, _ui?: boolean, value?: string) {
    const textarea = document.activeElement as HTMLTextAreaElement | null;
    if (command !== "insertText" || !textarea || textarea.tagName !== "TEXTAREA") return false;
    const start = textarea.selectionStart;
    const next = `${textarea.value.slice(0, start)}${value ?? ""}${textarea.value.slice(textarea.selectionEnd)}`;
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, next);
    textarea.setSelectionRange(start + (value ?? "").length, start + (value ?? "").length);
    const changed = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(changed, "propertyName", { value: "value" });
    textarea.dispatchEvent(changed);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    return true;
  },
});
after(() => dom.window.close());

type EditorProps = ComponentProps<typeof MarkdownEditor>;
let wrapEditor = (element: ReactElement) => element;

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function baseProps(value: string, changes: string[]): EditorProps {
  return {
    activeFilePath: "Notebook/note.md", files: [], formatting: false, fontFamily: "monospace", fontSizePx: 14,
    imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [], textareaRef: createRef<HTMLTextAreaElement>(), value,
    onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
    onChange: (text) => changes.push(text), onInsertFileLink: () => {}, onInsertImageFile: async () => {},
  };
}

type CodeMirrorExtras = { documentSource?: "value" | "external"; extensions?: Extension[]; onViewChange?: (view: EditorView | null) => void };

async function mountCodeMirror(value: string, patch: Partial<EditorProps> & CodeMirrorExtras = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const adapter = new CodeMirrorTextareaAdapter(value);
  let props = { ...baseProps(value, changes), ...patch };
  const render = async (next: Partial<EditorProps> & CodeMirrorExtras = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(wrapEditor(createElement(MarkdownCodeMirrorEditor, { ...props, adapter }))); });
  };
  await render();
  const view = adapter.editorView!;
  return {
    adapter, changes, host, render, view,
    get text() { return view.state.doc.toString(); },
    get selection() { return [view.state.selection.main.from, view.state.selection.main.to]; },
    select(start: number, end = start) { act(() => view.dispatch({ selection: { anchor: start, head: end } })); },
    async dispose() { await act(async () => root.unmount()); host.remove(); },
  };
}

async function mountTextarea(value: string, patch: Partial<EditorProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const textareaRef = createRef<HTMLTextAreaElement>();
  let props = { ...baseProps(value, changes), textareaRef, ...patch };
  const render = async (next: Partial<EditorProps> = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(wrapEditor(createElement(MarkdownEditor, props))); });
  };
  await render();
  return {
    changes, render, host, get textarea() { return textareaRef.current!; },
    async dispose() { await act(async () => root.unmount()); host.remove(); },
  };
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

function pasteEvent(data: Record<string, string>) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files: [], items: [], types: Object.keys(data), getData: (type: string) => data[type] ?? "" },
  });
  return event;
}

async function setControlledInput(input: HTMLInputElement, value: string) {
  await act(async () => { input.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
}

type SourceKind = "textarea" | "CodeMirror";

async function mountSource(kind: SourceKind, value: string, patch: Partial<EditorProps> = {}) {
  const cm = kind === "CodeMirror" ? await mountCodeMirror(value, patch) : null;
  const classic = cm ? null : await mountTextarea(value, patch);
  const input = cm?.adapter.asTextarea() ?? classic!.textarea;
  const host = cm?.host ?? classic!.host;
  const target = cm?.view.contentDOM ?? input;
  return {
    cm, input, host, target, changes: cm?.changes ?? classic!.changes,
    render: cm?.render ?? classic!.render,
    get text() { return input.value; },
    get selection() { return [input.selectionStart, input.selectionEnd]; },
    async select(start: number, end = start) {
      await act(async () => { input.focus(); input.setSelectionRange(start, end); });
    },
    async key(key: string, init: KeyboardEventInit = {}) {
      await act(async () => { keydown(target, key, init); });
    },
    async menu(start: number, end = start) {
      await this.select(start, end);
      if (cm) cm.view.posAtCoords = () => start;
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1000, clientY: 700 })); });
      return host.querySelector<HTMLElement>('[role="menu"]')!;
    },
    async type(text: string) {
      await act(async () => {
        if (cm) cm.view.dispatch({ changes: { from: input.selectionStart, to: input.selectionEnd, insert: text }, selection: { anchor: input.selectionStart + text.length }, userEvent: "input.type" });
        else document.execCommand("insertText", false, text);
      });
    },
    dispose: cm?.dispose ?? classic!.dispose,
  };
}

const button = (root: Element, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;

async function promptValue(input: HTMLTextAreaElement, text: string) {
  await act(async () => { input.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
}

for (const kind of ["textarea", "CodeMirror"] as const) {
  test(`${kind}: publication defers during composition and blur flushes the exact draft`, async () => {
    const editor = await mountSource(kind, "");
    try {
      await editor.select(0);
      // React was imported before jsdom, so its textarea composition plugin
      // uses the legacy 229/keyup fallback in this harness.
      if (!editor.cm) await editor.key("Process", { keyCode: 229 });
      await act(async () => { editor.target.dispatchEvent(new dom.window.Event("compositionstart", { bubbles: true })); });
      await editor.type("a");
      await settle(300);
      assert.deepEqual(editor.changes, []);
      await act(async () => { editor.target.dispatchEvent(new dom.window.Event("compositionend", { bubbles: true })); });
      if (!editor.cm) await act(async () => { editor.target.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true })); });
      await act(async () => { editor.input.blur(); });
      await settle(30);
      assert.equal(editor.changes.at(-1), "a");
    } finally { await editor.dispose(); }
  });

  test(`${kind}: incoming CRLF and CR values use textarea line endings without adding blank lines`, async () => {
    const editor = await mountSource(kind, "one\r\ntwo");
    try {
      assert.equal(editor.text, "one\ntwo");
      await editor.render({ value: "one\r\nthree\r\nfour" });
      assert.equal(editor.text, "one\nthree\nfour");
      await editor.render({ value: "one\rtwo" });
      assert.equal(editor.text, "one\ntwo");
    } finally { await editor.dispose(); }
  });

  test(`${kind}: menu paste keeps the Smart Paste preference captured when the action started`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let resolve!: (items: unknown[]) => void;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: () => new Promise((done) => { resolve = done; }) } });
    const editor = await mountSource(kind, "# Parent\n\n", { smartPaste: true });
    try {
      const menu = await editor.menu(editor.text.length);
      await act(async () => { button(menu, "Paste").click(); });
      await editor.render({ smartPaste: false });
      await act(async () => { resolve([{ types: ["text/plain"], getType: async () => ({ text: async () => "# New\n" }) }]); });
      await settle(30);
      assert.equal(editor.text, "# Parent\n\n## New\n");
    } finally {
      await editor.dispose();
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test(`${kind}: review comment geometry, right mouseup, composition, locking and edit notifications match`, async () => {
    const source = "Hello there";
    let stored = { ...newReview("Notebook/note.md", source, `parity-${kind}`), enabled: true };
    const originalFetch = globalThis.fetch;
    let finish: (() => void) | undefined;
    globalThis.fetch = async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.action === "comment") await new Promise<void>((resolve) => { finish = resolve; });
      stored = { ...syncReview(structuredClone(stored), body.snapshot ?? stored.snapshot), revision: stored.revision + 1 };
      if (body.action === "toggle") stored.enabled = body.enabled;
      return Response.json(stored);
    };
    let review!: NonNullable<ReturnType<typeof useMarkdownReview>>;
    function Probe() { review = useMarkdownReview()!; return null; }
    // eslint-disable-next-line react/no-children-prop
    wrapEditor = (element) => createElement(MarkdownReviewProvider, {
      activeTab: { id: "Notebook/note.md", draft: source, saved: source, status: "dirty", file: { fileType: "markdown", path: "Notebook/note.md" } } as never,
      getDraft: () => source, applyDraft: () => true, recoverDraft: () => {}, openChat: () => {}, openComments: () => {},
      children: [createElement(Probe, { key: "probe" }), cloneElement(element, { key: "editor" })],
    });
    const editor = await mountSource(kind, source);
    try {
      await settle(35);
      await editor.select(0, 5);
      await editor.key("m", { ctrlKey: true, altKey: true });
      assert.deepEqual(review.selection, { range: { start: 0, end: 5 }, x: 30, y: 30 });
      await act(async () => { editor.target.dispatchEvent(new dom.window.MouseEvent("mouseup", { button: 2, clientX: 19, clientY: 29, bubbles: true })); });
      await settle(5);
      assert.equal(review.selection?.x, 19);
      await act(async () => { editor.target.dispatchEvent(new dom.window.Event("compositionstart", { bubbles: true })); });
      assert.throws(() => review.snapshot(), /Finish composing/);
      await act(async () => { editor.target.dispatchEvent(new dom.window.Event("compositionend", { bubbles: true })); });
      await settle(10);
      let action!: Promise<boolean>;
      await act(async () => { action = review.action("comment", { text: "Test comment" }); });
      assert.equal(editor.input.readOnly, true);
      const menu = await editor.menu(0, 5);
      assert.equal(button(menu, "Read Out Loud").disabled, false);
      assert.equal(button(menu, "AI Format").disabled, false, "review locking does not add menu enablement rules");
      await act(async () => { finish!(); await action; });
      assert.equal(editor.input.readOnly, false);
      await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
      await act(async () => { review.clearSelection(); });
      await editor.select(0, 5);
      await editor.key("m", { ctrlKey: true, altKey: true });
      assert.ok(review.selection);
      await editor.key("Enter");
      if (!editor.cm) await editor.type("\n"); // Native textarea input after its keydown.
      assert.equal(review.selection, null, "newline commands clear a pending review passage");
      await editor.render({ value: "[go](" });
      await editor.select(5);
      editor.target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await settle(30);
      await editor.key("Escape");
      await settle(10);
      assert.equal(review.enabled, kind === "CodeMirror", "retained improvement: a CodeMirror popup claims Escape before review exits");
    } finally {
      await editor.dispose(); wrapEditor = (element) => element; globalThis.fetch = originalFetch;
    }
  });

  test(`${kind}: document-style edits preserve boundary selections and scroll and announce input`, async () => {
    const editor = await mountSource(kind, "Body");
    let inputs = 0;
    editor.input.addEventListener("input", () => { inputs++; });
    try {
      await editor.select(0);
      editor.input.scrollTop = 51;
      await act(async () => { window.dispatchEvent(new dom.window.CustomEvent(DOCUMENT_STYLE_REQUEST_EVENT, { detail: { path: "Notebook/note.md", style: "ieee" } })); });
      assert.match(editor.text, /citation-style: ieee/);
      assert.deepEqual(editor.selection, [0, 0]);
      assert.equal(editor.input.scrollTop, 51);
      assert.equal(inputs, 1);
      assert.equal(editor.changes.at(-1), editor.text);
      if (editor.cm) {
        act(() => { undo(editor.cm!.view); });
        assert.equal(editor.text, "Body");
      }
    } finally { await editor.dispose(); }
  });

  test(`${kind}: menu heading enablement follows an externally changed document`, async () => {
    const editor = await mountSource(kind, "## Heading");
    try {
      const menu = await editor.menu(0, editor.text.length);
      assert.equal(button(menu, "Indent Headings").disabled, false);
      await editor.render({ value: "Plain text" });
      assert.equal(button(menu, "Indent Headings").disabled, true);
      assert.equal(button(menu, "Unindent Headings").disabled, true);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: citation popup respects modifiers and Tab without headings keeps native focus traversal`, async () => {
    const editor = await mountSource(kind, "@");
    try {
      await editor.select(1);
      editor.target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await settle(35);
      assert.ok(editor.host.querySelector('[aria-label="Cite a reference"]'));
      await editor.key("Escape", { ctrlKey: true });
      assert.ok(editor.host.querySelector('[aria-label="Cite a reference"]'));
      await editor.key("Escape", { shiftKey: true });
      await settle(25);
      assert.equal(editor.host.querySelector('[aria-label="Cite a reference"]'), null);
      const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(async () => { editor.target.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, false);
      assert.equal(editor.text, "@");
    } finally { await editor.dispose(); }
  });

  test(`${kind}: image paste takes priority over text and image dragover uses the copy affordance`, async () => {
    const images: Array<{ name: string; selection?: { start: number; end: number } }> = [];
    const editor = await mountSource(kind, "Some text", { onInsertImageFile: async (file, selection) => { images.push({ name: file.name, selection }); } });
    try {
      await editor.select(1, 5);
      const file = new dom.window.File(["image"], "plot.png", { type: "image/png" });
      const data = { files: [file], items: [], types: ["Files", "text/plain"], dropEffect: "none", getData: () => "ignored" };
      const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: data });
      await act(async () => { editor.target.dispatchEvent(paste); });
      assert.deepEqual(images, [{ name: "plot.png", selection: { start: 1, end: 5 } }]);
      assert.equal(editor.text, "Some text");
      const over = new dom.window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(over, "dataTransfer", { value: data });
      await act(async () => { editor.target.dispatchEvent(over); });
      assert.equal(over.defaultPrevented, true);
      assert.equal(data.dropEffect, "copy");
      assert.match(editor.host.textContent ?? "", /Drop image to insert/);
      await act(async () => { editor.target.dispatchEvent(new dom.window.Event("dragleave", { bubbles: true })); });
      assert.doesNotMatch(editor.host.textContent ?? "", /Drop image to insert/);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: formatting accepts Ctrl, Cmd, Shift and both modifiers, but excludes Alt`, async () => {
    for (const [key, expected] of [["b", "**word**"], ["i", "_word_"], ["u", "<u>word</u>"]] as const) {
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true, metaKey: true }]) {
        const editor = await mountSource(kind, "word");
        try {
          await editor.select(0, 4);
          await editor.key(modifiers.shiftKey ? key.toUpperCase() : key, modifiers);
          await settle(25);
          assert.equal(editor.text, expected);
          assert.equal(editor.changes.at(-1), expected);
        } finally { await editor.dispose(); }
      }
    }
    const editor = await mountSource(kind, "word");
    try {
      await editor.select(0, 4);
      await editor.key("b", { ctrlKey: true, altKey: true });
      assert.equal(editor.text, "word");
      await editor.key("u", { altKey: true });
      assert.deepEqual(editor.selection, [0, 4], "Alt+U has no selection-history binding");
      await editor.key("Escape");
      assert.deepEqual(editor.selection, [0, 4], "Escape alone leaves the selection intact");
      await editor.key("F3");
      assert.equal(editor.host.querySelector('[aria-label="Find in note"]'), null);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: heading picker offers document headings, uses modifier-insensitive keys and inserts one edit`, async () => {
    const source = "# Alpha\n\n## Beta\n\n[go](#)";
    const editor = await mountSource(kind, source);
    try {
      await editor.select(source.length - 1);
      editor.target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await settle(35);
      assert.match(editor.host.textContent ?? "", /Headings in this document/);
      assert.match(editor.host.textContent ?? "", /Alpha/);
      await editor.key("ArrowDown", { shiftKey: true, ctrlKey: true });
      await editor.key("Enter", { shiftKey: true });
      await settle(25);
      assert.equal(editor.text, "# Alpha\n\n## Beta\n\n[go](#beta)");
      assert.deepEqual(editor.selection, [editor.text.length, editor.text.length]);
      assert.equal(editor.changes.at(-1), editor.text);
      if (editor.cm) {
        act(() => { undo(editor.cm!.view); });
        assert.equal(editor.text, source);
      }
      await editor.select(source.length - 1);
      editor.target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await settle(30);
      await editor.key("Escape", { shiftKey: true });
      await settle(30);
      assert.doesNotMatch(editor.host.textContent ?? "", /Headings in this document/);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: opening the same context menu resets prompts, focuses them and retains menu geometry`, async () => {
    const editor = await mountSource(kind, "## Heading\n\n![plot](plot.png)");
    try {
      let menu = await editor.menu(0, editor.text.length);
      await settle(25);
      assert.equal(menu.style.left, "728px");
      assert.equal(menu.style.top, "242px");
      assert.equal(button(menu, "Indent Headings").disabled, false);
      assert.equal(button(menu, "Unindent Headings").disabled, false);
      assert.ok(button(menu, "AI Image to Markdown"));
      assert.equal(document.activeElement?.id, "ai-rewrite-prompt");
      await promptValue(menu.querySelector<HTMLTextAreaElement>('#ai-rewrite-prompt')!, "rewrite this");
      menu = await editor.menu(0, editor.text.length);
      await settle(25);
      assert.equal(menu.querySelector<HTMLTextAreaElement>('#ai-rewrite-prompt')!.value, "");
      assert.equal(button(menu, "AI Format").disabled, false);
      await act(async () => { menu.dispatchEvent(new dom.window.Event("scroll")); });
      assert.ok(editor.host.querySelector('[role="menu"]'), "scroll inside the menu retains it");
      await act(async () => { window.dispatchEvent(new dom.window.Event("resize")); });
      assert.equal(editor.host.querySelector('[role="menu"]'), null);
      menu = await editor.menu(0, 0);
      await settle(25);
      assert.equal(document.activeElement?.id, "ai-write-prompt");
      assert.doesNotMatch(menu.textContent ?? "", /AI Rewrite|Read Out Loud/);
      await act(async () => { document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
      assert.equal(editor.host.querySelector('[role="menu"]'), null);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: AI busy states disable the same actions and show the same spinners`, async () => {
    const editor = await mountSource(kind, "## Heading\n![plot](plot.png)", { formatting: true, imageConverting: true });
    try {
      const menu = await editor.menu(0, editor.text.length);
      assert.equal(button(menu, "Formatting...").disabled, true);
      assert.equal(button(menu, "Converting...").disabled, true);
      assert.equal(button(menu, "Indent Headings").disabled, false);
      assert.equal(button(menu, "Read Out Loud").disabled, false);
      assert.equal(menu.querySelectorAll(".animate-spin").length, 3);
      assert.equal(menu.querySelector<HTMLTextAreaElement>('#ai-write-prompt')!.disabled, true);
      await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      assert.equal(editor.host.querySelector('[role="menu"]'), null);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: find keys, wildcard/case matching, replace-all caret and close scroll follow the common surface`, async () => {
    const editor = await mountSource(kind, "One one ONE other");
    try {
      await editor.select(0, 3);
      await editor.key("F", { ctrlKey: true, altKey: true, shiftKey: true });
      await settle(25);
      const find = editor.host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!;
      assert.equal(find.value, "One");
      await act(async () => { keydown(find, "Enter"); });
      await settle(25);
      assert.deepEqual(editor.selection, [4, 7]);
      await act(async () => { keydown(find, "Enter", { shiftKey: true }); });
      await settle(25);
      assert.deepEqual(editor.selection, [0, 3]);
      await setControlledInput(find, "o?e");
      await act(async () => { editor.host.querySelector<HTMLInputElement>('[aria-label="Wildcard matches"]')!.click(); });
      const replace = editor.host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!;
      await setControlledInput(replace, "X");
      await act(async () => { keydown(replace, "Enter", { shiftKey: true }); });
      await settle(25);
      assert.equal(editor.text, "X one ONE other", "Shift+Enter replaces the active match");
      await act(async () => { button(editor.host, "Replace all").click(); });
      await settle(25);
      assert.equal(editor.text, "X X X other");
      assert.deepEqual(editor.selection, [5, 5]);
      editor.input.scrollTop = 73;
      editor.input.scrollLeft = 19;
      await act(async () => { keydown(replace, "Escape"); });
      await settle(25);
      assert.equal(editor.host.querySelector('[aria-label="Find in note"]'), null);
      assert.equal(editor.input.scrollTop, 73);
      assert.equal(editor.input.scrollLeft, 19);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: find retains the classic active index when an outside edit removes a match`, async () => {
    const editor = await mountSource(kind, "one one one");
    try {
      await editor.select(0, 3);
      await editor.key("f", { ctrlKey: true });
      await settle(25);
      const find = editor.host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!;
      for (let index = 0; index < 2; index++) {
        await act(async () => { keydown(find, "Enter"); });
        await settle(25);
      }
      await editor.render({ value: "one one" });
      assert.match(editor.host.textContent ?? "", /2\/2/);
      await setControlledInput(editor.host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!, "X");
      await act(async () => { button(editor.host, "Replace").click(); });
      assert.equal(editor.text, "one one", "an active index beyond the new matches does not replace a different match");
    } finally { await editor.dispose(); }
  });

  test(`${kind}: replacement navigation uses the classic pre-renumber result`, async () => {
    const source = "# Title\n\n## 1. One\n\n## 2. Two";
    const editor = await mountSource(kind, source, { activeFilePath: `Notebook/replace-number-${kind}.md` });
    try {
      const at = source.indexOf("2.");
      await editor.select(at, at + 2);
      await editor.key("f", { ctrlKey: true });
      await settle(25);
      await setControlledInput(editor.host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!, "9.");
      await act(async () => { button(editor.host, "Replace").click(); });
      await settle(25);
      assert.equal(editor.text, source, "numbering restores the structural number");
      const caret = at + (kind === "CodeMirror" ? 3 : 2);
      assert.deepEqual(editor.selection, [caret, caret], "no new find target; CodeMirror retains its mapped caret through numbering");
    } finally { await editor.dispose(); }
  });

  test(`${kind}: pending popup refresh uses the caret even after the source loses focus`, async () => {
    const source = "# Heading\n\n[go](#";
    const editor = await mountSource(kind, source);
    try {
      await editor.select(source.length);
      const outside = document.createElement("input");
      document.body.append(outside);
      await act(async () => {
        outside.focus();
        editor.target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      await settle(25);
      assert.match(editor.host.textContent ?? "", /Headings in this document/);
      outside.remove();
    } finally { await editor.dispose(); }
  });

  test(`${kind}: programmatic formatting and rich paste preserve scroll, announce input and emit selection promptly`, async () => {
    const selections: Array<{ start: number; end: number }> = [];
    const editor = await mountSource(kind, "word", { onSelectionChange: (range) => selections.push(range) });
    let inputs = 0;
    editor.input.addEventListener("input", () => { inputs++; });
    try {
      await editor.select(0, 4);
      editor.input.scrollTop = 90;
      editor.input.scrollLeft = 11;
      await editor.key("b", { ctrlKey: true });
      await settle(30);
      assert.equal(inputs, 1);
      assert.deepEqual(selections.at(-1), { start: 2, end: 6 });
      assert.equal(editor.input.scrollTop, 90);
      assert.equal(editor.input.scrollLeft, 11);
      await act(async () => { editor.target.dispatchEvent(pasteEvent({ "text/markdown": "a\r\nb", "text/plain": "fallback" })); });
      await settle(30);
      assert.equal(editor.text, "**a\nb**");
      assert.deepEqual(editor.selection, [6, 6], "caret clamps after the CRLF replacement as a textarea does");
      assert.equal(inputs, 2);
      assert.deepEqual(selections.at(-1), { start: 6, end: 6 });
      assert.equal(editor.input.scrollTop, 90);
    } finally { await editor.dispose(); }
  });

  test(`${kind}: many published drafts still reject a delayed echo, and pagehide publishes the last keystroke`, async () => {
    let read: (() => string) | undefined;
    const editor = await mountSource(kind, "", { onRegisterDraft: (reader) => { read = reader; return () => { read = undefined; }; } });
    try {
      await editor.select(0);
      for (let index = 0; index < 23; index++) {
        await editor.type("x");
        act(() => { read!(); });
      }
      await editor.render({ value: "x" });
      assert.equal(editor.text, "x".repeat(23));
      await editor.type("!");
      await act(async () => { window.dispatchEvent(new dom.window.Event("pagehide")); });
      assert.equal(editor.changes.at(-1), "x".repeat(23) + "!");
    } finally { await editor.dispose(); }
    assert.equal(read, undefined);
  });

  test(`${kind}: adapter range clamping, detached scroll and source labels match textarea behavior`, async () => {
    const editor = await mountSource(kind, "abc");
    try {
      await editor.select(3, 1);
      assert.deepEqual(editor.selection, [1, 1]);
      assert.equal(editor.target.getAttribute("aria-label"), "Source Markdown editor");
      assert.equal(editor.target.getAttribute("spellcheck"), "false");
      assert.equal(editor.target.getAttribute("autocorrect") ?? "on", "on");
      assert.equal(editor.target.getAttribute("autocapitalize") ?? "sentences", "sentences");
      assert.equal(editor.cm?.view.state.tabSize ?? Number(editor.input.style.tabSize), 4);
      editor.input.scrollTop = 72;
      editor.input.scrollLeft = 15;
    } finally { await editor.dispose(); }
    assert.equal(editor.input.scrollTop, 72);
    assert.equal(editor.input.scrollLeft, 15);
  });
}

