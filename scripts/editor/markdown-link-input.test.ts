import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownLinkInput } from "../../src/components/libera/markdown-link-input";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";
import { MarkdownToolbar } from "../../src/components/libera/markdown-toolbar";
import type { LiberaFileNode } from "../../src/lib/types";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
// jsdom has no layout; these shims let ProseMirror focus the tested menus.
Object.assign(dom.window.Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new dom.window.DOMRect(),
});
// React's legacy input-event fallback expects these IE hooks when jsdom moves
// focus into a controlled input.
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.addEventListener(name.replace(/^on/, ""), listener);
  },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.removeEventListener(name.replace(/^on/, ""), listener);
  },
});
Object.assign(globalThis, { innerHeight: 768, innerWidth: 1024 });
after(() => dom.window.close());

async function setControlledInput(input: HTMLInputElement, value: string) {
  await act(async () => { input.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
}
const files: LiberaFileNode[] = [
  { kind: "file", name: "Flight notes.md", path: "Other/Flight notes.md", notebook: "Other", fileType: "markdown", createdAt: "", updatedAt: "", size: 0 },
  { kind: "file", name: "Flight.pdf", path: "Other/Flight.pdf", notebook: "Other", fileType: "pdf", createdAt: "", updatedAt: "", size: 0 },
];

test("link suggestions search @ names, select relative paths, and allow external URLs", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const choices: string[] = [];
  function Harness() {
    const [value, setValue] = useState("");
    return createElement(MarkdownLinkInput, { files, sourcePath: "Notebook/note.md", value, onChange: (href) => { setValue(href); choices.push(href); } });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const input = host.querySelector("input")!;
    assert.equal(host.querySelectorAll('[role="option"]').length, 1);
    await setControlledInput(input, "@flight");
    assert.match(host.querySelector('[role="option"]')!.textContent!, /Other\/Flight notes.md/);
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(choices.at(-1), "../Other/Flight%20notes.md");
    assert.equal(host.querySelector('[role="listbox"]'), null);
    await setControlledInput(input, "https://example.com/@flight");
    assert.equal(input.value, "https://example.com/@flight");
    assert.equal(host.querySelector('[role="listbox"]'), null);
    await setControlledInput(input, "@missing");
    assert.match(host.textContent!, /No matching Markdown files/);
    await setControlledInput(input, "@");
    let escaped = false;
    const listener = () => { escaped = true; };
    window.addEventListener("keydown", listener);
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    window.removeEventListener("keydown", listener);
    assert.equal(escaped, false);
    assert.equal(host.querySelector('[role="listbox"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("source toolbar inserts the chosen notebook link only after confirmation", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const insertions: unknown[] = [];
  try {
    await act(async () => root.render(createElement(MarkdownToolbar, {
      files, documentPath: "Notebook/note.md", canStartScreenshotSnip: false,
      markdownBaseFontSize: 16, markdownContent: "", markdownZoom: 1, previewFullscreen: false,
      onEnumerateHeadings() {}, onFixChatGptEquations() {}, onInsert: (...args) => { insertions.push(args); },
      onInsertExistingImage() {}, onInsertImage: async () => {}, onMarkdownZoomChange() {},
      onStartScreenshotSnip() {}, onTogglePreviewFullscreen() {},
    })));
    await act(async () => { (host.querySelector('[aria-label="Link"]') as HTMLButtonElement).click(); });
    assert.equal(insertions.length, 0);
    await act(async () => { (document.querySelector('[role="option"]') as HTMLButtonElement).click(); });
    assert.equal(insertions.length, 0);
    const insert = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === "Insert link")!;
    await act(async () => insert.click());
    assert.deepEqual(insertions, [["[", "](../Other/Flight%20notes.md)", "Flight notes.md"]]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("visual toolbar inserts a chosen notebook file with its filename as the label", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TiptapMarkdownEditor, {
      files, documentPath: "Notebook/note.md", value: "", fontSizePx: 16,
      lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange() {}, onChange() {},
      onSave: async () => {}, onOpenFileLink: async () => false,
    })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    await act(async () => { (host.querySelector('[aria-label="Insert or edit link"]') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('[role="option"]') as HTMLButtonElement).click(); });
    const apply = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === "Apply link")!;
    await act(async () => apply.click());
    const link = host.querySelector('.tiptap a')!;
    assert.equal(link.textContent, "Flight notes.md");
    assert.equal(link.getAttribute("href"), "../Other/Flight%20notes.md");
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
