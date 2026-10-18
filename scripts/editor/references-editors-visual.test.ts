import "./setup.cjs";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";
import { ReferenceRenderProvider, type ReferenceAttachmentLocator } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import { findTiptapTextMatches } from "../../src/lib/tiptap-find";
import { tiptapReviewBlocks } from "../../src/lib/tiptap-review";
import { diffDocuments } from "../../src/lib/tiptap-changes";
import { CITATION_NODE_NAME } from "../../src/lib/tiptap-citation";
import type { ReferenceAttachment } from "../../src/lib/references/types";
import { installReferenceFetch, makeLibrary, type MockServer } from "./references-editors-fixtures";

/* The Visual editor's citations, mounted in the real TiptapMarkdownEditor:
 * node views, the `@` popup, the popover, and coexistence with find, review
 * and tracked changes. */

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

test("node views show the formatted citation, the raw token while pending, and unresolved keys in red", async () => {
  const visual = await mountVisual("See [@smith2020sparse, p. 12] and [@nobody].");
  try {
    let chips = visual.chips();
    assert.equal(chips.length, 2);
    // The style and citeproc load on first use; wait for the formatted text (slow under a full test run).
    for (let waited = 0; waited < 10_000 && visual.chips()[0]?.dataset.formatted !== "true"; waited += 100) await settle(100);
    chips = visual.chips();
    assert.equal(chips[0].dataset.liberaCitation, "[@smith2020sparse, p. 12]");
    assert.equal(chips[0].dataset.formatted, "true");
    assert.match(chips[0].textContent!, /Smith, 2020, p\. 12/);
    assert.ok(chips[1].classList.contains("libera-citation-unresolved"));
    assert.equal(visual.editor.getMarkdown(), "See [@smith2020sparse, p. 12] and [@nobody].");
  } finally {
    await visual.dispose();
  }
});

test("without a reference provider the node shows its raw token", async () => {
  const visual = await mountVisual("See [@smith2020sparse].", { provider: false });
  try {
    await settle(100);
    const [chip] = visual.chips();
    assert.equal(chip.textContent, "[@smith2020sparse]");
    assert.equal(chip.dataset.formatted, undefined);
  } finally {
    await visual.dispose();
  }
});

test("typing @ opens the popup; Enter inserts a citation node in one undo step", async () => {
  const visual = await mountVisual("Hello");
  try {
    await settle(50);
    visual.editor.commands.setTextSelection(visual.editor.state.doc.content.size - 1);
    await visual.type(" @smi");
    const popup = document.querySelector<HTMLElement>("[data-citation-popup]");
    assert.equal(popup !== null, true, "the popup opened");
    assert.equal(popup!.querySelector<HTMLElement>("[data-citation-key]")!.dataset.citationKey, "smith2020sparse");
    await visual.key("Enter");
    assert.equal(document.querySelector("[data-citation-popup]") === null, true);
    assert.equal(visual.editor.getMarkdown(), "Hello [@smith2020sparse]");
    assert.equal(citationPositions(visual.editor).length, 1);
    await act(async () => { visual.editor.commands.undo(); });
    assert.equal(visual.editor.getMarkdown(), "Hello @smi");
  } finally {
    await visual.dispose();
  }
});

test("the @ popup stays closed in code blocks, code marks and emails", async () => {
  const visual = await mountVisual("```\ncode\n```\n\nText `code` me");
  try {
    await settle(50);
    // Inside the code block.
    visual.editor.commands.setTextSelection(5);
    await visual.type(" @smi");
    assert.equal(document.querySelector("[data-citation-popup]") === null, true, "code block");
    // At the end of the paragraph: an email.
    visual.editor.commands.setTextSelection(visual.editor.state.doc.content.size - 1);
    await visual.type("@exa");
    assert.equal(document.querySelector("[data-citation-popup]") === null, true, "email");
  } finally {
    await visual.dispose();
  }
});

test("Tab inserts and opens the popover at the locator; the popover edits produce the canonical token", async () => {
  const visual = await mountVisual("Hello");
  try {
    await settle(50);
    visual.editor.commands.setTextSelection(visual.editor.state.doc.content.size - 1);
    await visual.type(" @lee");
    await visual.key("Tab");
    await settle(20);
    const popover = document.querySelector<HTMLElement>("[data-citation-popover]");
    assert.equal(popover !== null, true, "the popover opened");
    const locator = popover!.querySelector<HTMLInputElement>("[data-field='locator']")!;
    assert.equal(document.activeElement === locator, true, "the locator has focus");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(locator, "4-6");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      locator.dispatchEvent(event);
      locator.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await visual.key("Enter", locator);
    assert.equal(document.querySelector("[data-citation-popover]") === null, true, "Enter closes");
    assert.equal(visual.editor.getMarkdown(), "Hello [@lee2019graphs, pp. 4-6]");

    // Click the node: the popover opens; Escape cancels changes.
    const chip = visual.chips()[0];
    await act(async () => { chip.click(); });
    const again = document.querySelector<HTMLElement>("[data-citation-popover]")!;
    const suppress = again.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => { suppress.click(); });
    await visual.key("Escape", suppress);
    assert.equal(visual.editor.getMarkdown(), "Hello [@lee2019graphs, pp. 4-6]");

    // Remove the only item: the citation goes.
    await act(async () => { visual.chips()[0].click(); });
    const remove = [...document.querySelectorAll<HTMLButtonElement>("[data-citation-popover] button")].find((button) => /Remove/.test(button.textContent!))!;
    await act(async () => { remove.click(); });
    assert.equal(visual.editor.getMarkdown(), "Hello ");
  } finally {
    await visual.dispose();
  }
});

test("Ctrl/Cmd+click on a citation node opens its attachment", async () => {
  const visual = await mountVisual("See [@smith2020sparse, p. 12].");
  try {
    await settle(50);
    await act(async () => { visual.chips()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); });
    assert.deepEqual(opened, [{ attachment: { kind: "pdf", path: "Notes/papers/smith.pdf" }, locator: { label: "page", locator: "12", page: 12 } }]);
    assert.equal(document.querySelector("[data-citation-popover]") === null, true);
  } finally {
    await visual.dispose();
  }
});

test("find matches a citation's raw token and covers the whole node", async () => {
  const visual = await mountVisual("See [@smith2020sparse, p. 12] here.");
  try {
    const [pos] = citationPositions(visual.editor);
    assert.deepEqual(findTiptapTextMatches(visual.editor.state.doc, "smith2020"), [{ from: pos, to: pos + 1 }]);
    // Text around the citation still maps character by character.
    assert.deepEqual(findTiptapTextMatches(visual.editor.state.doc, "here"), [{ from: pos + 2, to: pos + 6 }]);
    const across = findTiptapTextMatches(visual.editor.state.doc, "See [@smith");
    assert.deepEqual(across, [{ from: 1, to: pos + 1 }]);
  } finally {
    await visual.dispose();
  }
});

test("review mapping and tracked changes work with citation nodes", async () => {
  const source = "First [@smith2020sparse].\n\nSecond [see @lee2019graphs, p. 3] para.";
  const visual = await mountVisual(source);
  try {
    const blocks = tiptapReviewBlocks(visual.editor, source);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => source.slice(block.start, block.end)), ["First [@smith2020sparse].", "Second [see @lee2019graphs, p. 3] para."]);
    const before = visual.editor.state.doc;
    const [, second] = citationPositions(visual.editor);
    await act(async () => { visual.editor.view.dispatch(visual.editor.state.tr.setNodeMarkup(second, undefined, { raw: "[see @lee2019graphs, p. 4]" })); });
    const hunks = diffDocuments(before, visual.editor.state.doc);
    assert.equal(hunks.length, 1);
    assert.ok(hunks[0].a.from <= second && hunks[0].a.to >= second + 1);
  } finally {
    await visual.dispose();
  }
});

test("the popover adds an item through the search popup and swaps a work", async () => {
  const visual = await mountVisual("See [@smith2020sparse, p. 2].");
  try {
    await settle(50);
    const search = async (button: RegExp, query: string) => {
      const trigger = [...document.querySelectorAll<HTMLButtonElement>("[data-citation-popover] button")].find((element) => button.test(element.textContent!))!;
      await act(async () => { trigger.click(); });
      const input = document.querySelector<HTMLInputElement>("[data-citation-popup] input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, query);
        const event = new dom.window.Event("propertychange", { bubbles: true });
        Object.defineProperty(event, "propertyName", { value: "value" });
        input.dispatchEvent(event);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await visual.key("Enter", input);
    };
    await act(async () => { visual.chips()[0].click(); });
    await search(/Add item/, "lee");
    assert.equal(visual.editor.getMarkdown(), "See [@smith2020sparse, p. 2; @lee2019graphs].");
    assert.equal(document.querySelector("[data-citation-popover]") !== null, true, "the popover is back");
    await search(/Swap work/, "smythe");
    assert.equal(visual.editor.getMarkdown(), "See [@smythe2021, p. 2; @lee2019graphs].");
  } finally {
    await visual.dispose();
  }
});
