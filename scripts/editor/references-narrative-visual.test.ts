import "./setup.cjs";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";
import { ReferenceRenderProvider, type ReferenceAttachmentLocator } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import { CITATION_NODE_NAME, citationOfNode, updateCitationNode } from "../../src/lib/tiptap-citation";
import { FRONT_MATTER_NODE_NAME, setTiptapDocumentStyle, tiptapDocumentStyle } from "../../src/lib/tiptap-front-matter";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { requestDocumentStyleChange } from "../../src/lib/references/document-style";
import type { ReferenceAttachment } from "../../src/lib/references/types";
import { installReferenceFetch, makeLibrary, type MockServer } from "./references-editors-fixtures";

/* Narrative citations and the document style in the Visual editor: the
 * node's Markdown and attribute, node views, Shift+Enter, Backspace, the
 * popover's Narrative toggle and Document style select, and style requests
 * (the harness is the one of references-editors-visual.test.ts). */

let dom: JSDOM;
let restoreFetch: () => void = () => {};
const opened: Array<{ attachment: ReferenceAttachment; locator?: ReferenceAttachmentLocator }> = [];

before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event", "CustomEvent", "DOMRect", "PointerEvent", "FocusEvent", "InputEvent"] as const) {
    if (dom.window[key]) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect(0, 0, 0, 0) });
  Object.assign(dom.window.HTMLElement.prototype, {
    scrollIntoView() {},
    attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
    detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
  });
  // ProseMirror asks for caret coordinates (the suggestion's client rect).
  Object.assign(dom.window.Element.prototype, { getClientRects: () => [] });
  configureCitationFormatting({ worker: false, clearCache: true });
});
after(() => dom.window.close());

let server: MockServer;
afterEach(() => {
  restoreFetch();
  resetReferenceLibraryCache();
  resetRecentCitations();
  opened.length = 0;
});

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mountVisual(value: string, { provider = true } = {}) {
  server = { libraries: { Notes: makeLibrary() }, requests: [], resolve: () => 500 };
  restoreFetch = installReferenceFetch(server);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const editorElement = createElement(TiptapMarkdownEditor, {
    documentPath: "Notes/note.md", value, fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
    onChange: (text: string) => changes.push(text), onSave: async () => {}, onOpenFileLink: async () => false,
  });
  await act(async () => {
    root.render(provider ? createElement(ReferenceRenderProvider, {
      notebook: "Notes",
      onOpenAttachment: (attachment: ReferenceAttachment, locator?: ReferenceAttachmentLocator) => { opened.push({ attachment, locator }); },
    }, editorElement) : editorElement);
  });
  await settle(50);
  const proseMirror = host.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror")!;
  const editor = proseMirror.editor!;
  return {
    host, editor, changes,
    chips: () => [...host.querySelectorAll<HTMLElement>(".libera-citation[data-libera-citation]")],
    async type(text: string) {
      for (const char of text) {
        await act(async () => {
          const { from, to } = editor.state.selection;
          const view = editor.view;
          const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
          if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
        });
      }
      await settle(20);
    },
    async key(key: string, target: Element = editor.view.dom) {
      await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      await settle(20);
    },
    async dispose() { await act(async () => root.unmount()); host.remove(); },
  };
}

function citationPositions(editor: Editor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => { if (node.type.name === CITATION_NODE_NAME) positions.push(pos); });
  return positions;
}

// ---------------------------------------------------------------------------
// The node and Markdown, without React
// ---------------------------------------------------------------------------

function plainEditor(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/plain.md"), ...createMathExtensions()], content, contentType: "markdown" });
}

function citationNodes(editor: Editor) {
  const nodes: Array<{ raw: string; narrative: boolean }> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE_NAME) nodes.push({ raw: String(node.attrs.raw), narrative: Boolean(node.attrs.narrative) });
  });
  return nodes;
}

test("narrative citations round-trip byte for byte, with the narrative attribute and the DOM contract", () => {
  const source = [
    "---",
    "citation-style: ieee",
    "title: \"Notes: one\"",
    "---",
    "",
    "@smith2020sparse [p. 3] argues, @alice too, and [@lee2019graphs].",
    "",
    "> Quoted @smythe2021[ch. 2] here.",
    "",
    "- (@smith2020sparse) in a list, x@y stays text",
  ].join("\n");
  const editor = plainEditor(source);
  try {
    assert.equal(editor.getMarkdown(), source);
    assert.deepEqual(citationNodes(editor), [
      { raw: "@smith2020sparse [p. 3]", narrative: true },
      { raw: "@alice", narrative: true },
      { raw: "[@lee2019graphs]", narrative: false },
      { raw: "@smythe2021[ch. 2]", narrative: true },
      { raw: "@smith2020sparse", narrative: true },
    ]);
    assert.equal(editor.state.doc.firstChild!.type.name, FRONT_MATTER_NODE_NAME);
    assert.match(editor.getHTML(), /<span class="libera-citation" data-libera-citation="@smith2020sparse \[p\. 3\]" data-libera-narrative="">@smith2020sparse \[p\. 3\]<\/span>/);
    assert.match(editor.getHTML(), /<pre data-front-matter="" class="libera-front-matter"[^>]*>---\ncitation-style: ieee/);
    // An unrelated edit keeps every token.
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " More.");
    assert.ok(editor.getMarkdown().startsWith(source.slice(0, source.length - 1)));
  } finally {
    editor.destroy();
  }
});

test("pasting the preview's narrative chip keeps it; the popover switches between the forms", () => {
  const editor = plainEditor("Start");
  try {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ` <span class="libera-citation" data-libera-citation="@lee2019graphs [p. 4]" data-libera-narrative="">Lee (2019, p. 4)</span>`);
    assert.deepEqual(citationNodes(editor), [{ raw: "@lee2019graphs [p. 4]", narrative: true }]);
    assert.equal(editor.getMarkdown(), "Start @lee2019graphs [p. 4]");
    let pos = -1;
    editor.state.doc.descendants((node, at) => { if (node.type.name === CITATION_NODE_NAME) pos = at; });
    assert.deepEqual(citationOfNode(editor.state.doc.nodeAt(pos)!), { items: [{ key: "lee2019graphs", label: "page", locator: "4" }], raw: "@lee2019graphs [p. 4]", narrative: true });
    updateCitationNode(editor, pos, { items: [{ key: "lee2019graphs", label: "page", locator: "4" }], narrative: false });
    assert.equal(editor.getMarkdown(), "Start [@lee2019graphs, p. 4]");
    updateCitationNode(editor, pos, { items: [{ key: "lee2019graphs", label: "page", locator: "4" }], narrative: true });
    assert.equal(editor.getMarkdown(), "Start @lee2019graphs [p. 4]");
    // Kept narrative when not given; a prefix cannot be narrative, so it is written bracketed.
    updateCitationNode(editor, pos, { items: [{ key: "lee2019graphs", prefix: "see" }] });
    assert.equal(editor.getMarkdown(), "Start [see @lee2019graphs]");
    assert.deepEqual(citationNodes(editor), [{ raw: "[see @lee2019graphs]", narrative: false }]);
  } finally {
    editor.destroy();
  }
});

test("the front matter node: style read, written and removed as one edit", () => {
  const editor = plainEditor("Body [@a].");
  try {
    assert.equal(tiptapDocumentStyle(editor.state.doc), null);
    assert.equal(setTiptapDocumentStyle(editor, "ieee"), true);
    assert.equal(editor.getMarkdown(), "---\ncitation-style: ieee\n---\n\nBody [@a].");
    assert.equal(tiptapDocumentStyle(editor.state.doc), "ieee");
    assert.equal(setTiptapDocumentStyle(editor, "ieee"), false, "nothing changes");
    assert.equal(setTiptapDocumentStyle(editor, "styles/journal.csl"), true);
    assert.equal(editor.getMarkdown(), "---\ncitation-style: styles/journal.csl\n---\n\nBody [@a].");
    assert.equal(setTiptapDocumentStyle(editor, null), true);
    assert.equal(editor.getMarkdown(), "Body [@a].");
  } finally {
    editor.destroy();
  }
  const other = plainEditor("---\ntitle: X\n---\n\nBody");
  try {
    setTiptapDocumentStyle(other, "apa");
    assert.equal(other.getMarkdown(), "---\ntitle: X\ncitation-style: apa\n---\n\nBody");
    setTiptapDocumentStyle(other, null);
    assert.equal(other.getMarkdown(), "---\ntitle: X\n---\n\nBody");
  } finally {
    other.destroy();
  }
});

// ---------------------------------------------------------------------------
// Mounted in the Visual editor
// ---------------------------------------------------------------------------

async function waitFor(condition: () => unknown, message: string, timeoutMs = 15000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`Timed out: ${message}`);
    await settle(50);
  }
}

test("node views: a resolved narrative citation is formatted, an unresolved one is plain text", async () => {
  const visual = await mountVisual("@smith2020sparse [p. 12] argues; @alice disagrees.");
  try {
    await waitFor(() => visual.chips()[0]?.dataset.formatted === "true", "formatted narrative chip");
    const [chip] = visual.chips();
    assert.equal(visual.chips().length, 1, "@alice is not a chip");
    assert.equal(chip.textContent, "Smith (2020, p. 12)");
    assert.equal(chip.hasAttribute("data-libera-narrative"), true);
    const text = visual.host.querySelector<HTMLElement>(".libera-citation-text")!;
    assert.equal(text.textContent, "@alice");
    assert.equal(text.classList.contains("libera-citation-unresolved"), false);
    assert.equal(visual.editor.getMarkdown(), "@smith2020sparse [p. 12] argues; @alice disagrees.");
  } finally {
    await visual.dispose();
  }
});

test("Backspace after an unresolved narrative candidate edits it as text", async () => {
  const visual = await mountVisual("Thanks @alice");
  try {
    await settle(100);
    visual.editor.commands.setTextSelection(visual.editor.state.doc.content.size - 1);
    await visual.key("Backspace");
    assert.equal(visual.editor.getMarkdown(), "Thanks @alic");
    assert.equal(citationPositions(visual.editor).length, 0);
  } finally {
    await visual.dispose();
  }
});

test("Shift+Enter in the @ popup inserts a narrative citation node", async () => {
  const visual = await mountVisual("Hello");
  try {
    await settle(50);
    visual.editor.commands.setTextSelection(visual.editor.state.doc.content.size - 1);
    await visual.type(" @smi");
    assert.match(document.querySelector("[data-citation-popup-hint]")!.textContent!, /Shift\+Enter/);
    await act(async () => { visual.editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); });
    await settle(20);
    assert.equal(document.querySelector("[data-citation-popup]") === null, true);
    assert.equal(visual.editor.getMarkdown(), "Hello @smith2020sparse");
    let narrative: unknown = null;
    visual.editor.state.doc.descendants((node) => { if (node.type.name === CITATION_NODE_NAME) narrative = node.attrs.narrative; });
    assert.equal(narrative, true);
  } finally {
    await visual.dispose();
  }
});

function setChecked(input: HTMLInputElement, checked: boolean) {
  if (input.checked !== checked) input.click();
}

test("the popover's Narrative toggle, Document style select and Edit as text", async () => {
  const visual = await mountVisual("See [@lee2019graphs, p. 4] and @nobody.");
  try {
    await settle(100);
    await act(async () => { visual.chips()[0].click(); });
    let popover = document.querySelector<HTMLElement>("[data-citation-popover]")!;
    const narrative = popover.querySelector<HTMLInputElement>("[data-field='narrative']")!;
    assert.equal(narrative.disabled, false);
    await act(async () => { setChecked(narrative, true); });
    const style = popover.querySelector<HTMLSelectElement>("[data-field='document-style']")!;
    await act(async () => {
      style.value = "ieee";
      style.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const done = [...popover.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
    await act(async () => { done.click(); });
    assert.equal(visual.editor.getMarkdown(), "---\ncitation-style: ieee\n---\n\nSee @lee2019graphs [p. 4] and @nobody.");
    await waitFor(() => visual.chips()[0]?.textContent === "Lee [1, p. 4]", "IEEE narrative formatting from the document style");

    // The unresolved candidate's popover turns it back into text.
    await act(async () => { visual.host.querySelector<HTMLElement>(".libera-citation-text")!.click(); });
    popover = document.querySelector<HTMLElement>("[data-citation-popover]")!;
    await act(async () => { popover.querySelector<HTMLButtonElement>("[data-field='edit-as-text']")!.click(); });
    assert.equal(citationPositions(visual.editor).length, 1);
    assert.equal(visual.editor.getMarkdown(), "---\ncitation-style: ieee\n---\n\nSee @lee2019graphs [p. 4] and @nobody.");
  } finally {
    await visual.dispose();
  }
});

test("a Document style request for this document's path updates its front matter", async () => {
  const visual = await mountVisual("Text [@lee2019graphs].");
  try {
    await settle(50);
    let applied = false;
    await act(async () => { applied = requestDocumentStyleChange("Notes/note.md", "vancouver"); });
    assert.equal(applied, true);
    assert.equal(visual.editor.getMarkdown(), "---\ncitation-style: vancouver\n---\n\nText [@lee2019graphs].");
    await act(async () => { applied = requestDocumentStyleChange("Notes/other.md", "ieee"); });
    assert.equal(applied, false, "another document's request is not applied here");
    await act(async () => { requestDocumentStyleChange("Notes/note.md", null); });
    assert.equal(visual.editor.getMarkdown(), "Text [@lee2019graphs].");
  } finally {
    await visual.dispose();
  }
});
