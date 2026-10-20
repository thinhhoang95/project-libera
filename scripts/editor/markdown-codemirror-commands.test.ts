import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { undo } from "@codemirror/commands";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MARKDOWN_HIGHLIGHT_COLORS, MARKDOWN_TEXT_COLORS } from "../../src/lib/markdown-colors";
import { createMarkdownBoxInsertion, MARKDOWN_BOX_SHORTCUTS } from "../../src/lib/markdown-boxes";
import { changeSelectedHeadingLevels, getChangedTextRange, MARKDOWN_SHORTCUT_FORMATS } from "../../src/components/libera/markdown-editor";
import { replaceTextareaSelectionWithUndo } from "../../src/lib/textarea-editing";
import { getTextareaClientPointForOffset, getTextareaOffsetAtVisualProgress, getTextareaViewportAnchorOffset, getTextareaVisualProgressForRange, scrollTextareaToOffset } from "../../src/lib/textarea-position";
import {
  changeHeadingLevels, fileLinkDestinationAt, markdownFormatCommand, markdownInsertCommand, markdownInsertEdit, sourcePasteEdit, textareaEditSpec,
} from "../../src/lib/markdown-codemirror/commands";
import { markdownSourceSetup } from "../../src/lib/markdown-codemirror/setup";
import { CodeMirrorTextareaAdapter, getCodeMirrorTextareaAdapter, type TextareaLikeEdit } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { minimalTextChange, rebaseTextChange, replacesWholeDocument, valueChangeSpec } from "../../src/lib/markdown-codemirror/value-sync";
import { smartPasteMarkdown } from "../../src/lib/markdown-smart-paste";

/* The CodeMirror Source editor's commands must produce exactly what the
 * textarea editor produces. Each case runs the textarea path (a jsdom textarea
 * with a native-like `insertText`) and the CodeMirror path, and compares the
 * text and the selection. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "Event"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
}
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
// A browser's insertText on the focused textarea: replace the selection, put
// the caret after it, and fire input.
Object.defineProperty(document, "execCommand", {
  configurable: true,
  value(command: string, _ui?: boolean, value?: string) {
    const textarea = document.activeElement as HTMLTextAreaElement | null;
    if (command !== "insertText" || !textarea || textarea.tagName !== "TEXTAREA") return false;
    const start = textarea.selectionStart;
    textarea.value = `${textarea.value.slice(0, start)}${value ?? ""}${textarea.value.slice(textarea.selectionEnd)}`;
    textarea.setSelectionRange(start + (value ?? "").length, start + (value ?? "").length);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    return true;
  },
});
after(() => dom.window.close());

type Snapshot = { value: string; start: number; end: number };

function textareaWith(value: string, start: number, end: number) {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  textarea.value = value;
  textarea.focus();
  textarea.setSelectionRange(start, end);
  return textarea;
}

function codeMirrorWith(value: string, start: number, end: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: value, selection: { anchor: start, head: end }, extensions: markdownSourceSetup() }), parent });
  const adapter = new CodeMirrorTextareaAdapter(value);
  adapter.attach(view, {
    applyEdit: (edit) => view.dispatch(textareaEditSpec(view.state, edit)),
    applyValue: (text) => { const spec = valueChangeSpec(view.state, text); if (spec) view.dispatch(spec); },
    scrollIntoView: () => {},
  });
  return { view, adapter, textarea: adapter.asTextarea(), destroy: () => { adapter.detach(); view.destroy(); parent.remove(); } };
}

const snapshot = (target: { value: string; selectionStart: number; selectionEnd: number }): Snapshot =>
  ({ value: target.value, start: target.selectionStart, end: target.selectionEnd });

/** use-libera-workspace.ts `insertMarkdown`, verbatim apart from its tab
 * plumbing: the toolbar's single entry point for both editors. */
function workspaceInsertMarkdown(textarea: HTMLTextAreaElement, before: string, after = "", placeholder = "text") {
  const draft = textarea.value;
  let start = textarea.selectionStart;
  let end = textarea.selectionEnd;
  const selectedText = draft.slice(start, end) || placeholder;
  let replacement = `${before}${selectedText}${after}`;
  let nextSelectionStart = start + before.length;
  let nextSelectionEnd = nextSelectionStart + selectedText.length;
  const boxMarker = new RegExp(`^([${MARKDOWN_BOX_SHORTCUTS}]?)> $`, "i").exec(before);
  if (boxMarker && !after) {
    const box = createMarkdownBoxInsertion(draft, start, end, boxMarker[1], placeholder);
    start = box.selectionStart;
    end = box.selectionEnd;
    replacement = box.replacement;
    nextSelectionStart = box.nextSelectionStart;
    nextSelectionEnd = box.nextSelectionEnd;
  }
  return replaceTextareaSelectionWithUndo(textarea, { nextSelectionEnd, nextSelectionStart, replacement, selectionEnd: end, selectionStart: start });
}

/** use-libera-workspace.ts `insertMarkdownFileLinkPlaceholder`. */
function workspaceInsertFileLinkPlaceholder(textarea: HTMLTextAreaElement) {
  const draft = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = draft.slice(start, end) || "link";
  const insertion = `[${selectedText}]()`;
  const destinationOffset = start + selectedText.length + 3;
  return replaceTextareaSelectionWithUndo(textarea, { nextSelectionEnd: destinationOffset, nextSelectionStart: destinationOffset, replacement: insertion, selectionEnd: end, selectionStart: start });
}

/** Every toolbar button of markdown-toolbar.tsx, as its `onInsert` call. */
const TOOLBAR_ACTIONS: [string, string, string?, string?][] = [
  ["Bold", "**", "**"],
  ["Italic", "_", "_"],
  ["Underline", "<u>", "</u>"],
  ["Heading 1", "# ", "", "Heading"],
  ["Heading 2", "## ", "", "Heading"],
  ["Bulleted list", "- ", "", "List item"],
  ["Inline code", "`", "`", "code"],
  ["Math block", "$$\n", "\n$$", "x = y"],
  ["Link", "[", "](https://example.com)", "link"],
  ...MARKDOWN_HIGHLIGHT_COLORS.map((color) => [`${color.label} highlight`, `${color.shortcut}>>> `, " <<<", `${color.label.toLowerCase()} highlight`] as [string, string, string, string]),
  ...MARKDOWN_TEXT_COLORS.map((color) => [`${color.label} text`, `[color=${color.value}]`, "[/color]", "colored text"] as [string, string, string, string]),
  ["Default grey box", "> ", "", "Box text"],
  ...MARKDOWN_HIGHLIGHT_COLORS.map((color) => [`${color.label} box`, `${color.shortcut}> `, "", "Box text"] as [string, string, string, string]),
];

const SELECTIONS: [string, string, number, number][] = [
  ["empty note", "", 0, 0],
  ["caret mid-line", "Hello world", 5, 5],
  ["selected word", "Hello world", 6, 11],
  ["two selected lines", "First line\nSecond line\nThird", 3, 15],
  ["selection ending at a line start", "One\nTwo\nThree", 0, 4],
  ["existing coloured box", "Intro\n\ny> Boxed one\ny> Boxed two\n\nOutro", 9, 20],
  ["caret between paragraphs", "Para one\nPara two", 8, 8],
  ["unicode text", "Tiếng Việt 🙂 emoji", 11, 13],
];

test("every toolbar insertion gives the textarea's text and selection in CodeMirror", () => {
  let cases = 0;
  for (const [label, before, after, placeholder] of TOOLBAR_ACTIONS) {
    for (const [name, value, start, end] of SELECTIONS) {
      const textarea = textareaWith(value, start, end);
      assert.equal(workspaceInsertMarkdown(textarea, before, after, placeholder), true);
      const expected = snapshot(textarea);
      textarea.remove();

      // Through the adapter: what the shared toolbar does with the CodeMirror editor.
      const viaAdapter = codeMirrorWith(value, start, end);
      assert.equal(getCodeMirrorTextareaAdapter(viaAdapter.textarea), viaAdapter.adapter);
      assert.equal(workspaceInsertMarkdown(viaAdapter.textarea, before, after, placeholder), true);
      assert.deepEqual(snapshot(viaAdapter.textarea), expected, `${label} on ${name} (adapter)`);
      viaAdapter.destroy();

      // As a CodeMirror command.
      const viaCommand = codeMirrorWith(value, start, end);
      markdownInsertCommand(before, after, placeholder)(viaCommand.view);
      assert.deepEqual(snapshot(viaCommand.textarea), expected, `${label} on ${name} (command)`);
      viaCommand.destroy();

      // And the pure edit the command uses.
      const edit = markdownInsertEdit(value, { start, end }, before, after, placeholder);
      const pure = `${value.slice(0, edit.selectionStart)}${edit.replacement}${value.slice(edit.selectionEnd)}`;
      assert.equal(pure, expected.value, `${label} on ${name} (edit)`);
      cases++;
    }
  }
  assert.equal(cases, TOOLBAR_ACTIONS.length * SELECTIONS.length);
});

test("each toolbar insertion is one undo step in CodeMirror", () => {
  const editor = codeMirrorWith("Hello world", 6, 11);
  workspaceInsertMarkdown(editor.textarea, "**", "**");
  workspaceInsertMarkdown(editor.textarea, "_", "_");
  assert.equal(editor.view.state.doc.toString(), "Hello **_world_**");
  undo(editor.view);
  assert.equal(editor.view.state.doc.toString(), "Hello **world**");
  undo(editor.view);
  assert.equal(editor.view.state.doc.toString(), "Hello world");
  editor.destroy();
});

test("the file-link button and picker insertions match the textarea", () => {
  for (const [name, value, start, end] of SELECTIONS) {
    const textarea = textareaWith(value, start, end);
    workspaceInsertFileLinkPlaceholder(textarea);
    const expected = snapshot(textarea);
    textarea.remove();
    const editor = codeMirrorWith(value, start, end);
    workspaceInsertFileLinkPlaceholder(editor.textarea);
    assert.deepEqual(snapshot(editor.textarea), expected, name);
    editor.destroy();
  }
  // The picker completes a destination typed after `](`.
  const text = "See [notes](No";
  assert.deepEqual(fileLinkDestinationAt(text, text.length), { destinationStart: 12, destinationEnd: 14, query: "No" });
  assert.deepEqual(fileLinkDestinationAt("[a](<Pa", 7), { destinationStart: 4, destinationEnd: 7, query: "Pa" });
  assert.equal(fileLinkDestinationAt("[a](done) more", 14), null);
  assert.equal(fileLinkDestinationAt("no link here", 5), null);
  const edit: TextareaLikeEdit = { selectionStart: 12, selectionEnd: 14, replacement: "Notes/b.md)", nextSelectionStart: 12, nextSelectionEnd: 22 };
  const textarea = textareaWith(text, 14, 14);
  replaceTextareaSelectionWithUndo(textarea, edit);
  const editor = codeMirrorWith(text, 14, 14);
  replaceTextareaSelectionWithUndo(editor.textarea, edit);
  assert.deepEqual(snapshot(editor.textarea), snapshot(textarea));
  textarea.remove();
  editor.destroy();
});

test("Cmd/Ctrl+B, I and U format like the textarea editor", () => {
  for (const [key, format] of Object.entries(MARKDOWN_SHORTCUT_FORMATS)) {
    for (const [name, value, start, end] of SELECTIONS) {
      // The textarea editor's applyMarkdownFormat.
      const selected = value.slice(start, end) || (format.placeholder ?? "text");
      const expected: Snapshot = {
        value: `${value.slice(0, start)}${format.before}${selected}${format.after}${value.slice(end)}`,
        start: start + format.before.length,
        end: start + format.before.length + selected.length,
      };
      const editor = codeMirrorWith(value, start, end);
      markdownFormatCommand(format)(editor.view);
      assert.deepEqual(snapshot(editor.textarea), expected, `Mod-${key} on ${name}`);
      editor.destroy();
    }
  }
});

test("Tab and Shift+Tab change selected heading levels like the textarea editor", () => {
  const value = "# Title\n\nText\n\n## Child\n### Grandchild";
  for (const direction of ["indent", "unindent"] as const) {
    for (const [start, end] of [[0, value.length], [0, 3], [10, 12], [16, 25]]) {
      const result = changeSelectedHeadingLevels(value, start, end, direction);
      const editor = codeMirrorWith(value, start, end);
      assert.equal(changeHeadingLevels(editor.view, direction), result.hasHeading, `${direction} ${start}-${end}`);
      assert.deepEqual(snapshot(editor.textarea), { value: result.nextValue, start: result.nextStart, end: result.nextEnd });
      editor.destroy();
    }
  }
  const editor = codeMirrorWith("# A\n## B", 0, 8);
  changeHeadingLevels(editor.view, "unindent");
  changeHeadingLevels(editor.view, "unindent");
  assert.equal(editor.view.state.doc.toString(), "A\nB");
  undo(editor.view);
  assert.equal(editor.view.state.doc.toString(), "A\n# B", "each Shift+Tab is its own undo step");
  editor.destroy();
});

test("Smart Paste and rich paste compute the textarea editor's result", () => {
  const document = "# 1. Intro\n\n## 1.1 Scope\n\nText.\n\n# 2. Method\n\n## 2.1 Data\n";
  const at = document.indexOf("# 2. Method");
  const pasted = "### Results\n\nBody.\n\n#### Detail\n\n";
  const edit = sourcePasteEdit(document, { start: at, end: at }, { markdown: "", html: "", plain: pasted }, { smartPaste: "child" })!;
  const expected = smartPasteMarkdown(document, { start: at, end: at }, pasted)!;
  const editor = codeMirrorWith(document, at, at);
  editor.view.dispatch(textareaEditSpec(editor.view.state, edit));
  assert.equal(editor.view.state.doc.toString(), expected.value);
  assert.equal(editor.view.state.selection.main.head, expected.selection.start);
  assert.deepEqual(getChangedTextRange(document, expected.value), { replacement: edit.replacement, selectionStart: edit.selectionStart, selectionEnd: edit.selectionEnd });
  editor.destroy();

  // Without Smart Paste, plain text is left to the editor's own paste.
  assert.equal(sourcePasteEdit("abc", { start: 1, end: 1 }, { markdown: "", html: "", plain: "# H\n" }), null);
  // The right-click menu has no browser paste behind it: plain text is inserted.
  assert.equal(sourcePasteEdit("abc", { start: 1, end: 1 }, { markdown: "", html: "", plain: "# H\n" }, { insertPlain: true })?.replacement, "# H\n");
  // Paste with Peer Heading Level matches the textarea editor too.
  const peer = sourcePasteEdit(document, { start: at, end: at }, { markdown: "", html: "", plain: pasted }, { smartPaste: "peer" })!;
  assert.equal(peer.replacement, getChangedTextRange(document, smartPasteMarkdown(document, { start: at, end: at }, pasted, "peer")!.value).replacement);
  // `text/markdown` is pasted as is and replaces the selection.
  assert.deepEqual(sourcePasteEdit("abc", { start: 1, end: 2 }, { markdown: "**x**", html: "<b>x</b>", plain: "x" }), {
    replacement: "**x**", selectionStart: 1, selectionEnd: 2, nextSelectionStart: 6, nextSelectionEnd: 6,
  });
  // Rich HTML becomes Markdown.
  const html = sourcePasteEdit("", { start: 0, end: 0 }, { markdown: "", html: "<p>Hello <strong>bold</strong></p>", plain: "Hello bold" });
  assert.equal(html?.replacement.trim(), "Hello **bold**");
});

test("the adapter answers textarea-position queries from CodeMirror", () => {
  const editor = codeMirrorWith("one\ntwo\nthree", 0, 0);
  const progress = getTextareaVisualProgressForRange(editor.textarea, 4, { start: 0, end: 13 });
  assert.ok(progress >= 0 && progress <= 1);
  const offset = getTextareaOffsetAtVisualProgress(editor.textarea, { start: 0, end: 13 }, 0);
  assert.equal(offset, 0);
  assert.ok(getTextareaViewportAnchorOffset(editor.textarea, 0.5) >= 0);
  const point = getTextareaClientPointForOffset(editor.textarea, 5);
  assert.equal(typeof point.x, "number");
  let scrolled: number | undefined;
  editor.adapter.attach(editor.view, { applyEdit: () => {}, applyValue: () => {}, scrollIntoView: (pos) => { scrolled = pos; } });
  scrollTextareaToOffset(editor.textarea, 8, { block: "start" });
  assert.equal(scrolled, 8);
  editor.destroy();
});

test("the adapter keeps selection, scroll and listeners requested before the view exists", () => {
  const adapter = new CodeMirrorTextareaAdapter("Hello world");
  const textarea = adapter.asTextarea();
  assert.equal(textarea.value, "Hello world");
  textarea.setSelectionRange(6, 11);
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [6, 11]);
  let inputs = 0;
  textarea.addEventListener("input", () => { inputs++; });
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: "Hello world", extensions: markdownSourceSetup() }), parent });
  adapter.attach(view, { applyEdit: (edit) => view.dispatch(textareaEditSpec(view.state, edit)), applyValue: () => {}, scrollIntoView: () => {} });
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [6, 11]);
  replaceTextareaSelectionWithUndo(textarea, { selectionStart: 0, selectionEnd: 5, replacement: "Howdy", nextSelectionStart: 5, nextSelectionEnd: 5 });
  assert.equal(inputs, 1, "edits are announced with an input event, like a textarea");
  adapter.detach();
  view.destroy();
  assert.equal(textarea.value, "Howdy world", "a detached adapter keeps the last text");
  parent.remove();
});

test("minimal changes keep the common prefix and suffix and never split surrogate pairs", () => {
  assert.equal(minimalTextChange("same", "same"), null);
  assert.deepEqual(minimalTextChange("Hello world", "Hello brave world"), { from: 6, to: 6, insert: "brave " });
  assert.deepEqual(minimalTextChange("abcdef", "abXYef"), { from: 2, to: 4, insert: "XY" });
  assert.deepEqual(minimalTextChange("a🙂b", "a🙃b"), { from: 1, to: 3, insert: "🙃" });
  assert.deepEqual(minimalTextChange("aaa", "aaaa"), { from: 3, to: 3, insert: "a" });
  assert.equal(replacesWholeDocument({ from: 0, to: 4, insert: "x" }, 4), true);
  assert.equal(replacesWholeDocument({ from: 0, to: 0, insert: "x" }, 0), false);
  // Rebasing moves an edit made against an older text past later changes.
  const since = ChangeSet.of([{ from: 0, insert: "NEW " }], 11);
  assert.deepEqual(rebaseTextChange({ from: 6, to: 11, insert: "there" }, since), { from: 10, to: 15, insert: "there" });
  assert.deepEqual(rebaseTextChange({ from: 0, to: 0, insert: "X" }, since), { from: 4, to: 4, insert: "X" });
});

test("a minimal value change keeps the caret, the selection and undo", () => {
  const editor = codeMirrorWith("Alpha\n\nBeta gamma", 12, 17);
  const spec = valueChangeSpec(editor.view.state, "Alpha one\n\nBeta gamma")!;
  editor.view.dispatch(spec);
  assert.equal(editor.view.state.doc.toString(), "Alpha one\n\nBeta gamma");
  assert.equal(editor.view.state.sliceDoc(editor.view.state.selection.main.from, editor.view.state.selection.main.to), "gamma");
  undo(editor.view);
  assert.equal(editor.view.state.doc.toString(), "Alpha\n\nBeta gamma", "outside changes stay undoable");
  editor.destroy();
});
