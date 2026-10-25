import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { redo, undo } from "@codemirror/commands";
import { StateField, Transaction, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownCodeMirrorEditor } from "../../src/components/libera/markdown-source/markdown-codemirror-editor";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { CodeMirrorTextareaAdapter, getCodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { normalizeChatGptCopiedMarkdown } from "../../src/lib/chatgpt-markdown-normalizer";
import { anchorAt, newReview, syncReview, type ReviewDocument } from "../../src/lib/markdown-review";
import { markdownValueSync } from "../../src/lib/markdown-codemirror/value-sync";
import { replaceTextareaSelectionWithUndo } from "../../src/lib/textarea-editing";

/* The CodeMirror Markdown Source editor as a component: the same draft flow,
 * shortcuts, paste, find and review behaviour as the textarea editor, and the
 * collaboration seam ("external" document source). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event"] as const) {
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
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    return true;
  },
});
after(() => dom.window.close());

type EditorProps = ComponentProps<typeof MarkdownEditor>;

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
    await act(async () => { root.render(createElement(MarkdownCodeMirrorEditor, { ...props, adapter })); });
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
    await act(async () => { root.render(createElement(MarkdownEditor, props)); });
  };
  await render();
  return {
    changes, render, get textarea() { return textareaRef.current!; },
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

test("typing publishes the draft after a 250 ms pause, and the registered reader publishes at once", async () => {
  let reader: (() => string) | undefined;
  const editor = await mountCodeMirror("Hello", { onRegisterDraft: (read) => { reader = read; return () => { reader = undefined; }; } });
  try {
    act(() => editor.view.dispatch({ changes: { from: 5, insert: " world" }, userEvent: "input.type" }));
    assert.deepEqual(editor.changes, [], "keystrokes stay out of the workspace render path");
    await settle(320);
    assert.deepEqual(editor.changes, ["Hello world"]);
    act(() => editor.view.dispatch({ changes: { from: 0, insert: ">" }, userEvent: "input.type" }));
    assert.equal(reader?.(), ">Hello world");
    assert.deepEqual(editor.changes, ["Hello world", ">Hello world"]);
    // The workspace echoes a published draft back as `value`: nothing changes.
    act(() => editor.view.dispatch({ changes: { from: 12, insert: "!" }, userEvent: "input.type" }));
    await editor.render({ value: ">Hello world" });
    assert.equal(editor.text, ">Hello world!", "a delayed echo never replaces newer typing");
  } finally {
    await editor.dispose();
  }
  assert.equal(reader, undefined, "the reader is unregistered on unmount");
});

test("unmounting flushes the last keystrokes and the selection", async () => {
  const selections: { start: number; end: number }[] = [];
  const editor = await mountCodeMirror("abc", { onSelectionChange: (selection) => selections.push(selection) });
  act(() => editor.view.dispatch({ changes: { from: 3, insert: "d" }, selection: { anchor: 4 }, userEvent: "input.type" }));
  await editor.dispose();
  assert.deepEqual(editor.changes, ["abcd"]);
  assert.deepEqual(selections.at(-1), { start: 4, end: 4 });
});

test("an outside value is applied as a minimal change that keeps the selection and undo", async () => {
  const editor = await mountCodeMirror("Intro\n\nBody text here");
  try {
    editor.select(12, 16);
    await editor.render({ value: "Intro, longer\n\nBody text here" });
    assert.equal(editor.text, "Intro, longer\n\nBody text here");
    assert.equal(editor.view.state.sliceDoc(editor.selection[0], editor.selection[1]), "text", "the selection follows its text");
    assert.deepEqual(editor.changes, [], "an outside value is not published back");
    act(() => { undo(editor.view); });
    assert.equal(editor.text, "Intro\n\nBody text here");
  } finally {
    await editor.dispose();
  }
});

test("Fix ChatGPT equations gives the textarea's text and keeps the caret", async () => {
  const draft = "Energy \\(E = mc^2\\) and\n\\[\na^2 + b^2 = c^2\n\\]\nDone.";
  const fixed = normalizeChatGptCopiedMarkdown(draft, {});
  assert.notEqual(fixed, draft);
  const textarea = await mountTextarea(draft);
  const editor = await mountCodeMirror(draft);
  try {
    // The toolbar sets the normalised draft on the tab (workspace-panel.tsx).
    await textarea.render({ value: fixed });
    editor.select(draft.length - 2);
    await editor.render({ value: fixed });
    assert.equal(editor.text, textarea.textarea.value);
    assert.equal(editor.selection[0], fixed.length - 2, "the caret keeps its place after the rewritten equations");
  } finally {
    await textarea.dispose();
    await editor.dispose();
  }
});

test("opening, switching and applying outside numbered text never renumbers it", async () => {
  const source = "# Title\n\n## 9. Intro";
  const editor = await mountCodeMirror(source, { activeFilePath: "Notes/numbering-outside.md" });
  try {
    assert.equal(editor.text, source);
    const switched = "# Other\n\n## 7. Body";
    await editor.render({ activeFilePath: "Notes/numbering-switched.md", value: switched });
    assert.equal(editor.text, switched);
    const applied = "# Other\n\n## Unnumbered\n\n## 7. Body";
    await editor.render({ value: applied });
    assert.equal(editor.text, applied);
    const reviewed = "# Other\n\n## Reviewed\n\n## 8. Body";
    act(() => editor.view.dispatch({ changes: { from: 0, to: editor.text.length, insert: reviewed }, annotations: markdownValueSync.of("review") }));
    assert.equal(editor.text, reviewed);
    await settle(320);
    assert.deepEqual(editor.changes, [], "outside text is not published back as a local edit");
  } finally {
    await editor.dispose();
  }
});

test("typing and adapter edits renumber in a separate undo step, and redo restores both steps", async () => {
  for (const adapterEdit of [false, true]) {
    const source = "# Title\n\n## 1. Intro\n\n";
    const editor = await mountCodeMirror(source, { activeFilePath: `Notes/numbering-undo-${adapterEdit}.md` });
    try {
      const at = source.length;
      act(() => {
        if (adapterEdit) {
          assert.equal(replaceTextareaSelectionWithUndo(editor.adapter.asTextarea(), {
            selectionStart: at, selectionEnd: at, replacement: "## ", nextSelectionStart: at + 3, nextSelectionEnd: at + 3,
          }), true);
        } else editor.view.dispatch({ changes: { from: at, insert: "## " }, selection: { anchor: at + 3 }, userEvent: "input.type" });
      });
      const numbered = `${source}## 2. `;
      assert.equal(editor.text, numbered);
      assert.deepEqual(editor.selection, [numbered.length, numbered.length]);
      act(() => editor.view.dispatch({ changes: { from: numbered.length, insert: "N" }, selection: { anchor: numbered.length + 1 }, userEvent: "input.type" }));
      act(() => { undo(editor.view); });
      assert.equal(editor.text, numbered, "later typing does not join the numbering step");
      act(() => { undo(editor.view); });
      assert.equal(editor.text, `${source}## `, "first undo removes numbering only");
      assert.deepEqual(editor.selection, [at + 3, at + 3]);
      act(() => { undo(editor.view); });
      assert.equal(editor.text, source, "second undo removes the edit");
      act(() => { redo(editor.view); });
      assert.equal(editor.text, `${source}## `, "redo does not trigger renumbering");
      act(() => { redo(editor.view); });
      assert.equal(editor.text, numbered);
    } finally {
      await editor.dispose();
    }
  }
});

test("composition leaves headings alone until it ends, then numbers them once", async () => {
  const source = "# Title\n\n## 1. Intro\n\n";
  const editor = await mountCodeMirror(source, { activeFilePath: "Notes/numbering-ime.md" });
  try {
    act(() => {
      editor.view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      assert.equal(editor.view.compositionStarted, true);
      const at = editor.text.length;
      editor.view.dispatch({ changes: { from: at, insert: "## あ" }, selection: { anchor: at + 4 }, userEvent: "input.type.compose" });
    });
    assert.equal(editor.text, `${source}## あ`);
    act(() => editor.view.dispatch({ changes: { from: editor.text.length, insert: "い" }, selection: { anchor: editor.text.length + 1 }, userEvent: "input.type.compose" }));
    assert.equal(editor.text, `${source}## あい`);
    await act(async () => {
      editor.view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
      // A selection-only update after composition must not lose deferred numbering.
      editor.view.dispatch({ selection: editor.view.state.selection });
    });
    await settle(10);
    const numbered = `${source}## 2. あい`;
    assert.equal(editor.text, numbered);
    assert.deepEqual(editor.selection, [numbered.length, numbered.length]);
    act(() => { undo(editor.view); });
    assert.equal(editor.text, `${source}## あい`);
    act(() => { undo(editor.view); });
    assert.equal(editor.text, source);
  } finally {
    await editor.dispose();
  }
});

test("ending a composition without a local edit, or with a queued outside value, preserves outside numbering", async () => {
  const source = "# Title\n\n## 9. Intro";
  const editor = await mountCodeMirror(source, { activeFilePath: "Notes/numbering-ime-outside.md" });
  const composition = (type: string) => editor.view.contentDOM.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true }));
  try {
    await act(async () => { composition("compositionstart"); composition("compositionend"); });
    await settle(10);
    assert.equal(editor.text, source, "composition without an edit does not touch the document");
    act(() => {
      composition("compositionstart");
      editor.view.dispatch({ changes: { from: source.length, insert: "\n\n## あ" }, userEvent: "input.type.compose" });
    });
    const outside = "# Title\n\n## 8. Applied";
    await editor.render({ value: outside });
    assert.equal(editor.text, `${source}\n\n## あ`, "the outside value waits for composition");
    await act(async () => { composition("compositionend"); });
    await settle(10);
    assert.equal(editor.text, outside, "applying the queued value must not renumber it");
    await settle(320);
    assert.deepEqual(editor.changes, []);
  } finally {
    await editor.dispose();
  }
});

test("Cmd/Ctrl+B, I, U and Tab give the textarea editor's results", async () => {
  const cases: [string, KeyboardEventInit, string, number, number][] = [
    ["b", { ctrlKey: true }, "make this bold", 5, 9],
    ["i", { ctrlKey: true }, "make this italic", 5, 9],
    ["u", { ctrlKey: true }, "underline", 0, 0],
    ["Tab", {}, "# Title\n\n## Child", 0, 17],
    ["Tab", { shiftKey: true }, "# Title\n\n## Child", 0, 17],
  ];
  for (const [key, init, value, start, end] of cases) {
    const textarea = await mountTextarea(value);
    const editor = await mountCodeMirror(value);
    try {
      textarea.textarea.focus();
      textarea.textarea.setSelectionRange(start, end);
      await act(async () => { keydown(textarea.textarea, key, init); });
      editor.select(start, end);
      await act(async () => { keydown(editor.view.contentDOM, key, init); });
      await settle(5);
      assert.equal(editor.text, textarea.textarea.value, `${key} ${JSON.stringify(init)}`);
      assert.deepEqual(editor.selection, [textarea.textarea.selectionStart, textarea.textarea.selectionEnd]);
      assert.equal(editor.changes.at(-1), editor.text, "the edit is published at once, as in the textarea editor");
    } finally {
      await textarea.dispose();
      await editor.dispose();
    }
  }
});

test("Smart Paste and rich paste give the textarea editor's results", async () => {
  const document = "# 1. Intro\n\nText.\n\n# 2. Method\n";
  const at = document.indexOf("# 2. Method");
  const clipboards: Record<string, string>[] = [
    { "text/plain": "## Results\n\nBody.\n\n### Detail\n" },
    { "text/html": "<h2>Rich</h2><p>Some <em>styled</em> text</p>", "text/plain": "Rich\nSome styled text" },
    { "text/markdown": "**kept as is**", "text/plain": "kept as is" },
  ];
  for (const data of clipboards) {
    const textarea = await mountTextarea(document, { smartPaste: true });
    const editor = await mountCodeMirror(document, { smartPaste: true });
    try {
      textarea.textarea.focus();
      textarea.textarea.setSelectionRange(at, at);
      await act(async () => { textarea.textarea.dispatchEvent(pasteEvent(data)); });
      editor.select(at);
      const event = pasteEvent(data);
      await act(async () => { editor.view.contentDOM.dispatchEvent(event); });
      await settle(5);
      assert.equal(event.defaultPrevented, true);
      assert.equal(editor.text, textarea.textarea.value, JSON.stringify(data));
      assert.equal(editor.selection[0], textarea.textarea.selectionStart);
    } finally {
      await textarea.dispose();
      await editor.dispose();
    }
  }
});

test("pasted and dropped images go to the same insertion callback with the selection", async () => {
  const inserted: { name: string; selection?: { start: number; end: number } }[] = [];
  const editor = await mountCodeMirror("Text here", { onInsertImageFile: async (file, selection) => { inserted.push({ name: file.name, selection }); } });
  try {
    editor.select(4, 9);
    const file = new dom.window.File(["x"], "shot.png", { type: "image/png" });
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file], items: [], getData: () => "" } });
    await act(async () => { editor.view.contentDOM.dispatchEvent(event); });
    assert.deepEqual(inserted, [{ name: "shot.png", selection: { start: 4, end: 9 } }]);
  } finally {
    await editor.dispose();
  }
});

test("Find and Replace with wildcards behaves like the textarea editor", async () => {
  const editor = await mountCodeMirror("item-01; item-aa; item-123;");
  try {
    await act(async () => { editor.view.focus(); keydown(editor.view.contentDOM, "f", { ctrlKey: true }); });
    await settle(10);
    await setControlledInput(editor.host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!, "item-??;");
    await act(async () => { editor.host.querySelector<HTMLInputElement>('[aria-label="Wildcard matches"]')!.click(); });
    await setControlledInput(editor.host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!, "X");
    assert.match(editor.host.textContent ?? "", /1\/2/);
    assert.equal(editor.view.contentDOM.querySelectorAll(".markdown-editor-find-match").length, 2);
    assert.equal(editor.view.contentDOM.querySelectorAll(".markdown-editor-find-match-active").length, 1);
    const replaceAll = Array.from(editor.host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Replace all")!;
    await act(async () => { replaceAll.click(); });
    assert.equal(editor.text, "X X item-123;");
    assert.equal(editor.changes.at(-1), "X X item-123;");
    await settle(25); // Replacement restores the find input's focus in the next frame, as the textarea does.
    await act(async () => { keydown(editor.host.querySelector('[aria-label="Find in note"]')!, "Escape"); });
    assert.equal(editor.host.querySelector('[aria-label="Find in note"]'), null);
    await settle(5);
    assert.equal(editor.view.contentDOM.querySelectorAll(".markdown-editor-find-match").length, 0);
  } finally {
    await editor.dispose();
  }
});

test("the context menu offers the same AI entry points with the selection", async () => {
  const calls: unknown[] = [];
  const editor = await mountCodeMirror("![chart](chart.png)\n\nSome text", {
    onAiFormatSelection: async (selection) => { calls.push(["format", selection]); },
    onAiWriteAt: async (offset, prompt) => { calls.push(["write", offset, prompt]); },
  });
  try {
    editor.select(0, 7);
    await act(async () => { editor.view.contentDOM.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const menu = editor.host.querySelector('[role="menu"]')!;
    assert.ok(menu, "the menu opens");
    const labels = Array.from(menu.querySelectorAll("button, label")).map((element) => element.textContent?.trim());
    for (const label of ["AI Format", "Indent Headings", "Unindent Headings", "AI Rewrite", "Write with AI"]) assert.ok(labels.includes(label), label);
    await act(async () => { (Array.from(menu.querySelectorAll("button")).find((button) => button.textContent?.includes("AI Format")) as HTMLButtonElement).click(); });
    assert.deepEqual(calls, [["format", { start: 0, end: 7 }]]);
    editor.select(25, 25); // jsdom has no layout: the right-click lands at the start, on the image, and the caret moves there as in a textarea.
    await act(async () => { editor.view.contentDOM.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const imageMenu = editor.host.querySelector('[role="menu"]')!;
    assert.match(imageMenu.textContent ?? "", /AI Image to Markdown/);
    assert.doesNotMatch(imageMenu.textContent ?? "", /AI Rewrite/, "without a selection the menu writes at the caret");
  } finally {
    await editor.dispose();
  }
});

test("the light wrapper hands the workspace a textarea-compatible ref before the editor loads", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const props = baseProps("Wrapped note", changes);
  // Loaded here, after the DOM globals exist: next/dynamic decides at import
  // time whether it runs in a browser.
  const { MarkdownSourceEditor } = await import("../../src/components/libera/markdown-source/markdown-source-editor");
  try {
    await act(async () => { root.render(createElement(MarkdownSourceEditor, props)); });
    const ref = props.textareaRef.current!;
    const adapter = getCodeMirrorTextareaAdapter(ref);
    assert.ok(adapter, "the ref holds the CodeMirror adapter");
    assert.equal(ref.value, "Wrapped note");
    ref.setSelectionRange(2, 5);
    for (let attempt = 0; attempt < 50 && !adapter!.editorView; attempt++) await settle(20);
    assert.ok(adapter!.editorView, "the editor chunk loads and attaches");
    assert.deepEqual([ref.selectionStart, ref.selectionEnd], [2, 5], "a selection requested before loading is applied");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  assert.equal(props.textareaRef.current, null);
});

test("external mode never replaces the whole document and still publishes derived drafts", async () => {
  const whole: string[] = [];
  // Records every document change, as the collaboration binding would see it.
  const spy = StateField.define<null>({
    create: () => null,
    update(value, tr) {
      tr.changes.iterChanges((fromA, toA) => { if (fromA === 0 && toA === tr.startState.doc.length && toA > 0) whole.push(tr.startState.doc.toString()); });
      return value;
    },
  });
  let view: EditorView | null = null;
  const editor = await mountCodeMirror("Shared line one\nShared line two", { documentSource: "external", extensions: [spy], onViewChange: (next) => { view = next; } });
  try {
    assert.equal(view, editor.view, "the binding can reach the view");
    // A remote change from the binding is published as the derived draft.
    act(() => editor.view.dispatch({ changes: { from: 0, insert: "Remote: " }, annotations: Transaction.remote.of(true) }));
    await settle(320);
    assert.equal(editor.changes.at(-1), "Remote: Shared line one\nShared line two");
    // The workspace edits the draft it last saw while another remote change
    // arrives; the edit is rebased onto the live document.
    act(() => editor.view.dispatch({ changes: { from: editor.text.length, insert: "!" }, annotations: Transaction.remote.of(true) }));
    await editor.render({ value: "Remote: Shared line ONE\nShared line two" });
    assert.equal(editor.text, "Remote: Shared line ONE\nShared line two!");
    assert.equal(editor.changes.at(-1), editor.text, "the derived draft is published at once");
    // A value that would rewrite everything is refused; the draft reconverges.
    await editor.render({ value: "Completely different" });
    assert.equal(editor.text, "Remote: Shared line ONE\nShared line two!");
    assert.equal(editor.changes.at(-1), editor.text);
    assert.deepEqual(whole, [], "no transaction replaced the whole document");
    // Swapping the injected extensions reconfigures without touching the text.
    await editor.render({ extensions: [] });
    assert.equal(editor.text, "Remote: Shared line ONE\nShared line two!");
  } finally {
    await editor.dispose();
  }
  assert.equal(view, null, "the binding is told before the view goes");
});

test("review mode registers the editor bridge, draws anchors and opens the comment gesture", async () => {
  const source = "Hello there\n\nSecond paragraph";
  let stored: ReviewDocument = {
    ...newReview("Notes/review.md", source, "review-id"), enabled: true,
    threads: [{ id: "comment-id", anchor: anchorAt(source, { start: 0, end: 5 }), status: "open", messages: [{ id: "m", text: "Comment", createdAt: "2026-10-18" }] }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.action === "load" || !body.action) return Response.json(stored);
    stored = { ...syncReview(structuredClone(stored), body.snapshot), revision: stored.revision + 1 };
    return Response.json(stored);
  };
  let review!: NonNullable<ReturnType<typeof useMarkdownReview>>;
  function Probe() { review = useMarkdownReview()!; return null; }
  const adapter = new CodeMirrorTextareaAdapter(source);
  function Harness() {
    const [draft, setDraft] = useState(source);
    const draftRef = useRef(source);
    const tab = { id: "Notes/review.md", draft, saved: source, status: "dirty", file: { fileType: "markdown", path: "Notes/review.md" } } as never;
    // eslint-disable-next-line react/no-children-prop
    return createElement(MarkdownReviewProvider, {
      activeTab: tab, getDraft: () => draftRef.current,
      applyDraft: (_id: string, before: string, after: string) => { if (before !== draftRef.current) return false; draftRef.current = after; setDraft(after); return true; },
      recoverDraft: () => {}, openChat: () => {}, openComments: () => {},
      children: [createElement(Probe, { key: "probe" }), createElement(MarkdownCodeMirrorEditor, {
        ...baseProps(draft, []), key: "editor", adapter, onChange: (text: string) => { draftRef.current = text; setDraft(text); },
      })],
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await settle(50);
    const view = adapter.editorView!;
    assert.equal(review.enabled, true);
    assert.equal(review.snapshot(), source, "the review reads the live text through the bridge");
    assert.equal(view.contentDOM.querySelector(".review-source-highlight")?.textContent, "Hello", "comment anchors are highlighted");
    act(() => view.dispatch({ selection: { anchor: 13, head: 19 } }));
    await act(async () => { keydown(view.contentDOM, "m", { ctrlKey: true, altKey: true }); });
    assert.equal(review.selection?.range.start, 13, "Cmd/Ctrl+Alt+M starts a comment on the selection");
    await act(async () => { (review as unknown as { focus: (range: { start: number; end: number }) => void }).focus({ start: 0, end: 5 }); });
    assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [0, 5], "focusing a thread selects its anchor");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
