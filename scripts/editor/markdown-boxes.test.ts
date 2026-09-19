import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import { MARKDOWN_HIGHLIGHT_COLORS } from "../../src/lib/markdown-colors";
import { createMarkdownBoxInsertion } from "../../src/lib/markdown-boxes";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { prepareMarkdownPreview } from "../../src/lib/markdown-preview";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { MarkdownToolbar } from "../../src/components/libera/markdown-toolbar";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
after(() => dom.window.close());

function editor(content: string) {
  return new Editor({ extensions: createMarkdownExtensions("note.md"), content, contentType: "markdown" });
}

test("all box colors render with highlight palette colors and preserve source positions in both previews", () => {
  for (const color of MARKDOWN_HIGHLIGHT_COLORS) {
    const content = `Before\n\n${color.shortcut}> **Bold** and [link](https://example.com)\n${color.shortcut}>\n${color.shortcut}> - One\n${color.shortcut}> - Two\n\nAfter`;
    const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content }));
    const prepared = renderToStaticMarkup(createElement(MarkdownRenderer, { content, preparedTree: structuredClone(prepareMarkdownPreview(content)) }));
    assert.equal(prepared, html);
    const root = new dom.window.DOMParser().parseFromString(html, "text/html");
    const box = root.querySelector("blockquote")!;
    assert.equal(box.getAttribute("data-box-color"), color.shortcut);
    assert.match(box.getAttribute("style")!, new RegExp(`background-color:${color.value};color:${color.foreground}`));
    assert.equal(box.getAttribute("data-source-start"), "8");
    assert.equal(Number(box.getAttribute("data-source-end")), content.indexOf("\n\nAfter"));
    assert.equal(box.querySelector("strong")?.textContent, "Bold");
    assert.equal(box.querySelectorAll("li").length, 2);
  }
});

test("box grammar leaves highlights, code, escaped markers and ordinary text alone", () => {
  const content = "y>>>highlight<<<\n\n`y> inline`\n\n```md\ny> fenced\n```\n\n    b> indented\n\ny\\> escaped\n\nThe y> text\n\nx> unknown\n\n> Ordinary";
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content }));
  assert.doesNotMatch(html, /data-box-color/);
  assert.match(html, /<mark/);
  assert.equal((html.match(/<blockquote/g) ?? []).length, 1);
  const visual = editor(content);
  assert.doesNotMatch(visual.getHTML(), /data-box-color/);
  assert.match(visual.getHTML(), /<mark/);
  visual.destroy();
});

test("visual Markdown and HTML round trips preserve every box color, nested boxes, lists and code", () => {
  const content = MARKDOWN_HIGHLIGHT_COLORS.map(({ shortcut }) => `${shortcut}> **Bold**\n${shortcut}>\n${shortcut}> - One\n${shortcut}> - Two`).join("\n\n") +
    "\n\n> b> Nested blue\n\ny> > Nested grey\n\ny> ```md\ny> r> literal\ny> ```\n\nb> Last";
  const first = editor(content);
  assert.equal(first.getJSON().content?.[0].attrs?.color, "y");
  const second = editor(first.getMarkdown());
  assert.deepEqual(second.getJSON(), first.getJSON());
  const pasted = new Editor({ extensions: createMarkdownExtensions("note.md"), content: first.getHTML() });
  assert.deepEqual(pasted.getJSON(), first.getJSON());
  for (const color of MARKDOWN_HIGHLIGHT_COLORS) assert.match(first.getHTML(), new RegExp(`data-box-color="${color.shortcut}"`));
  first.destroy(); second.destroy(); pasted.destroy();
});

test("visual block equations use the theme foreground inside colored boxes", () => {
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.libera-tiptap blockquote\[data-box-color\] :is\([^}]*\[data-type=["']block-math["']\][^}]*\)\s*\{\s*color:\s*var\(--foreground\);\s*\}/,
    "block equations must not inherit the colored box's white foreground",
  );
});

test("preview and visual boxes agree at paragraph, color and code boundaries", () => {
  for (const content of [
    "Before\ny> Yellow\nb> Blue\n> Grey",
    "y> Wrapped\ncontinuation\ny> still yellow\n\nAfter",
    "y> First\n# Outside\nb> Second",
    "- y> Box in a list\n  y> continuation",
    "y> Outer\ny> b> Inner\ny>\ny> Tail",
    "Y> Uppercase\nY> continued",
    "y> ```md\ny> b> literal\ny> ```",
    "`code\ny> still code`\n\nb> Real box",
  ]) {
    const preview = renderToStaticMarkup(createElement(MarkdownRenderer, { content }));
    const visual = editor(content);
    const boxes = (html: string) => {
      const root = new dom.window.DOMParser().parseFromString(html, "text/html");
      return Array.from(root.querySelectorAll("blockquote")).map((box) => ({
        color: box.getAttribute("data-box-color"), text: box.textContent?.replace(/\s+/g, ""),
      }));
    };
    assert.deepEqual(boxes(visual.getHTML()), boxes(preview), content);
    visual.destroy();
  }
});

test("source box actions wrap complete selected lines, recolor boxes and retain surrounding content", () => {
  const source = "Before\nFirst\n\nSecond\nAfter";
  const insertion = createMarkdownBoxInsertion(source, 9, source.indexOf("After"), "y");
  assert.equal(insertion.replacement, "\ny> First\ny> \ny> Second\n");
  const result = source.slice(0, insertion.selectionStart) + insertion.replacement + source.slice(insertion.selectionEnd);
  assert.equal(result, "Before\n\ny> First\ny> \ny> Second\n\nAfter");
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: result }));
  const rendered = new dom.window.DOMParser().parseFromString(html, "text/html");
  assert.doesNotMatch(rendered.querySelector("blockquote")!.textContent!, /Before|After/);
  assert.equal(createMarkdownBoxInsertion("y> First\ny> Second", 0, 20, "b").replacement, "b> First\nb> Second");
  assert.equal(createMarkdownBoxInsertion("b> First", 4, 4, "").replacement, "> First");
  assert.equal(createMarkdownBoxInsertion("", 0, 0, "g").replacement, "g> Box text");
  assert.equal(createMarkdownBoxInsertion("\nAfter", 0, 0, "g").selectionStart, 0);
});

test("source toolbar exposes all highlight colors and inserts the chosen box marker", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const calls: string[] = [];
  const noop = () => {};
  try {
    await act(async () => root.render(createElement(MarkdownToolbar, {
      documentPath: "note.md", canStartScreenshotSnip: false, markdownBaseFontSize: 16, markdownContent: "", markdownZoom: 100,
      onEnumerateHeadings: noop, onFixChatGptEquations: noop, onInsert: (before) => { calls.push(before); },
      onInsertExistingImage: noop, onInsertFileLink: noop, onInsertImage: async () => {}, onMarkdownZoomChange: noop,
      onStartScreenshotSnip: noop, onTogglePreviewFullscreen: noop, previewFullscreen: false,
    })));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Box color"]')!;
    for (const color of MARKDOWN_HIGHLIGHT_COLORS) {
      assert.ok(Array.from(select.options).some((option) => option.value === color.shortcut));
      await act(async () => { select.value = color.shortcut; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.equal(calls.at(-1), `${color.shortcut}> `);
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("visual toolbar applies, recolors and resets boxes without nesting them", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let read: (() => string) | undefined;
  try {
    await act(async () => root.render(createElement(TiptapMarkdownEditor, {
      documentPath: "note.md", value: "Box text", fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100,
      onMarkdownZoomChange: () => {}, onChange: () => {}, onSave: async () => {}, onOpenFileLink: async () => false,
      onRegisterDraft: (reader) => { read = reader; return () => {}; },
    })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Box color"]')!;
    for (const value of ["y", "b", "default"]) {
      await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.equal(host.querySelectorAll(".libera-tiptap blockquote").length, 1);
      assert.equal(read?.().trim(), `${value === "default" ? "" : value}> Box text`);
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});
