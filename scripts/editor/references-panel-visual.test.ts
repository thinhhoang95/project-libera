import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Editor } from "@tiptap/core";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, innerHeight: 768, innerWidth: 1024 });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
after(() => dom.window.close());

test("an inline visual insertion (Cite at cursor) lands at the caret inside the paragraph", async () => {
  const { createRoot } = await import("react-dom/client");
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const handled: string[] = [];
  const props = {
    files: [], documentPath: "Notes/note.md", value: "Hello world\n\nSecond paragraph", fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100,
    onMarkdownZoomChange() {}, onChange() {}, onSave: async () => {}, onOpenFileLink: async () => false,
    onPendingInsertionHandled: (id: string) => { handled.push(id); },
  };
  try {
    await act(async () => root.render(createElement(TiptapMarkdownEditor, props)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const editor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
    await act(async () => { editor.commands.setTextSelection(6); });
    await act(async () => root.render(createElement(TiptapMarkdownEditor, { ...props, pendingInsertion: { id: "cite-1", markdown: "[@smith2020]", inline: true } })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.deepEqual(handled, ["cite-1"]);
    // Until the editors lane adds the TipTap citation node, brackets in plain
    // text serialize escaped; the insertion itself lands at the caret.
    assert.match(editor.getMarkdown(), /^Hello\\?\[@smith2020\\?\] world\n\nSecond paragraph$/);
    assert.equal(editor.state.doc.childCount, 2, "no new block");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
