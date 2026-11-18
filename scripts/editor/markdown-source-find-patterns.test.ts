import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { resetFindStoreForTests } from "../../src/lib/find/settings-store";

/* Pattern find & replace in the Markdown source editor (docs/find-replace-patterns-plan.md). */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
// jsdom has no layout.
Object.assign(dom.window.Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new dom.window.DOMRect(),
});
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.addEventListener(name.replace(/^on/, ""), listener);
  },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.removeEventListener(name.replace(/^on/, ""), listener);
  },
});
after(() => dom.window.close());

beforeEach(() => {
  try { globalThis.localStorage?.removeItem("libera.find.settings.v1"); } catch { /* no storage */ }
  resetFindStoreForTests();
});

async function setControlledInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { input.focus(); });
  await act(async () => {
    const prototype = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
}

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function mount(value: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const textareaRef = createRef<HTMLTextAreaElement>();
  await act(async () => {
    root.render(createElement(MarkdownEditor, {
      activeFilePath: "Notebook/patterns.md", files: [], formatting: false, fontFamily: "monospace",
      fontSizePx: 14, imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [],
      textareaRef, value,
      onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
      onChange: (next: string) => changes.push(next), onInsertFileLink: () => {}, onInsertImageFile: async () => {},
    }));
  });
  const textarea = textareaRef.current!;
  const openFind = async () => {
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }));
    });
    await wait(10);
  };
  const query = () => host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!;
  const replacement = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Replace with"]')!;
  const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === text)!;
  const mode = async (name: string) => {
    await act(async () => { Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((radio) => radio.textContent === name)!.click(); });
  };
  const dispose = async () => { await act(async () => root.unmount()); host.remove(); };
  return { host, textarea, changes, openFind, query, replacement, button, mode, dispose };
}

test("Pattern mode swaps captures with Replace All and shows them in the preview", async () => {
  const editor = await mount("Let \\(4x+3,3y\\) and \\(f(a,b),z\\).");
  try {
    await editor.openFind();
    await editor.mode("Pattern");
    await setControlledInput(editor.query(), "\\(*,*\\)");
    await setControlledInput(editor.replacement(), "\\(@2,@1\\)");
    assert.match(editor.host.textContent ?? "", /1\/2/);
    // The preview names each capture and shows what Replace writes.
    assert.match(editor.host.textContent ?? "", /@1 = 4x\+3/);
    assert.match(editor.host.textContent ?? "", /@2 = 3y/);
    assert.match(editor.host.textContent ?? "", /\\\(3y,4x\+3\\\)/);
    // The holes are drawn as chips behind the query.
    assert.ok(editor.host.querySelector('[role="search"] .bg-sky-400\\/30'));
    await act(async () => { editor.button("Replace all").click(); });
    assert.equal(editor.changes.at(-1), "Let \\(3y,4x+3\\) and \\(z,f(a,b)\\).");
    assert.match(editor.host.textContent ?? "", /Replaced 2 matches/);
  } finally { await editor.dispose(); }
});

test("an unknown capture in the replacement disables Replace and explains why", async () => {
  const editor = await mount("\\(x\\)");
  try {
    await editor.openFind();
    await editor.mode("Pattern");
    await setControlledInput(editor.query(), "\\(*\\)");
    await setControlledInput(editor.replacement(), "@nope");
    assert.equal(editor.button("Replace").disabled, true);
    assert.match(editor.host.querySelector('[role="alert"]')?.textContent ?? "", /No hole called @nope/);
  } finally { await editor.dispose(); }
});

test("Replace All skips matches whose arithmetic has no number, and says so", async () => {
  const editor = await mount("v=1; v=x; v=2;");
  try {
    await editor.openFind();
    await editor.mode("Pattern");
    await setControlledInput(editor.query(), "v=*;");
    await setControlledInput(editor.replacement(), "v=@(@1+1);");
    await act(async () => { editor.button("Replace all").click(); });
    assert.equal(editor.changes.at(-1), "v=2; v=x; v=3;");
    assert.match(editor.host.textContent ?? "", /Replaced 2 matches · 1 skipped/);
  } finally { await editor.dispose(); }
});

test("In selection limits matches to the selected text", async () => {
  const editor = await mount("one one one one");
  try {
    await act(async () => { editor.textarea.setSelectionRange(4, 11); });
    await editor.openFind();
    await setControlledInput(editor.query(), "one");
    assert.match(editor.host.textContent ?? "", /\/4/);
    await act(async () => { editor.textarea.setSelectionRange(4, 11); });
    await act(async () => { editor.host.querySelector<HTMLButtonElement>('[aria-label="Find in selection"]')!.click(); });
    assert.match(editor.host.textContent ?? "", /\/2/);
    await setControlledInput(editor.replacement(), "X");
    await act(async () => { editor.button("Replace all").click(); });
    assert.equal(editor.changes.at(-1), "one X X one");
  } finally { await editor.dispose(); }
});

test("Where: Inside math only replaces in formulas", async () => {
  const editor = await mount("x is $x+1$ and \\(2x\\)");
  try {
    await editor.openFind();
    await act(async () => {
      const select = editor.host.querySelector<HTMLSelectElement>('select[aria-label="Where"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(select, "insideMath");
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await setControlledInput(editor.query(), "x");
    await setControlledInput(editor.replacement(), "y");
    await act(async () => { editor.button("Replace all").click(); });
    assert.equal(editor.changes.at(-1), "x is $y+1$ and \\(2y\\)");
  } finally { await editor.dispose(); }
});
