import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { sourceRangeForTiptapTextSelection, tiptapSelectionForSourceRange } from "../../src/lib/tiptap-review";
import { findMarkdownHeadingAnchor, markdownHeadingAnchors, markdownHeadingHref, slugifyMarkdownHeading } from "../../src/lib/markdown-heading-anchors";
import { createMarkdownLinkQuote, locateRenderedTextInMarkdown, markdownLinkQuoteLabel, resolveMarkdownLinkQuote } from "../../src/lib/markdown-selection-links";
import { createMarkdownFileLinkDestination, resolveMarkdownFileLink } from "../../src/lib/markdown-file-links";
import { MarkdownLinkInput } from "../../src/components/libera/markdown-link-input";
import type { LiberaFileNode } from "../../src/lib/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
});
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

const notes: LiberaFileNode = { kind: "file", name: "Flight notes.md", path: "Other/Flight notes.md", notebook: "Other", fileType: "markdown", createdAt: "", updatedAt: "", size: 0 };

test("heading anchors use GitHub slugs, skip code fences and number repeated titles", () => {
  const markdown = "# Getting Started!\n\n```\n# not a heading\n```\n\n## Tiếng **Việt** `code`\n\nSetext\n---\n\n## Notes\n\n## Notes\n\n## Notes 1";
  assert.deepEqual(markdownHeadingAnchors(markdown).map((anchor) => anchor.slug), [
    "getting-started", "tiếng-việt-code", "setext", "notes", "notes-1", "notes-1-1",
  ]);
  assert.equal(slugifyMarkdownHeading("What's new? (v2.0)"), "whats-new-v20");
  assert.equal(markdownHeadingHref({ slug: "tiếng-việt" }), "#ti%E1%BA%BFng-vi%E1%BB%87t");
  assert.equal(findMarkdownHeadingAnchor(markdown, "#ti%E1%BA%BFng-vi%E1%BB%87t-code")?.line, 7);
  // Hand-written fragments may use the heading text itself.
  assert.equal(findMarkdownHeadingAnchor(markdown, "#Getting Started")?.offset, 0);
  assert.equal(findMarkdownHeadingAnchor(markdown, "#notes-1")?.line, 14);
  assert.equal(findMarkdownHeadingAnchor(markdown, "#missing"), null);
});

test("file links keep heading fragments apart from Libera link metadata", () => {
  const files = [notes];
  assert.equal(resolveMarkdownFileLink("../Other/Flight%20notes.md#approach", "Notebook/a.md", files)?.headingFragment, "approach");
  const quote = createMarkdownLinkQuote("Intro. The key passage. Outro.", { start: 7, end: 23 });
  const href = createMarkdownFileLinkDestination({ metadata: { v: 1, quote }, sourcePath: "Notebook/a.md", targetPath: notes.path });
  const resolved = resolveMarkdownFileLink(href, "Notebook/a.md", files);
  assert.equal(resolved?.headingFragment, undefined);
  assert.deepEqual(resolved?.metadata?.quote, quote);
});

test("selection quotes survive edits and prefer the original occurrence", () => {
  const before = "Alpha beta.\n\nRepeat this.\n\nRepeat this.\n";
  const quote = createMarkdownLinkQuote(before, { start: 27, end: 39 });
  assert.equal(quote.text, "Repeat this.");
  const after = `New intro paragraph.\n\n${before}`;
  assert.deepEqual(resolveMarkdownLinkQuote(after, quote, 27), { start: 49, end: 61 });
  assert.equal(resolveMarkdownLinkQuote("Gone.", quote), null);
  assert.equal(markdownLinkQuoteLabel("## A **bold** [link](x.md) and `code`"), "A bold link and code");
});

test("rendered selections locate their Markdown source through inline markup", () => {
  const source = "Some **bold _and_ italic** text with [a link](x.md).";
  const range = locateRenderedTextInMarkdown(source, "bold and italic text with a link");
  assert.equal(source.slice(range!.start, range!.end), "bold _and_ italic** text with [a link");
  assert.equal(locateRenderedTextInMarkdown(source, "absent words"), null);
});

test("visual selections map to exact source ranges and back", () => {
  const source = "# Title\n\nFirst paragraph.\n\nSecond has **bold words** inside.\n\n- Item one\n- Item two";
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: source, contentType: "markdown" });
  try {
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "bold words") from = pos;
    });
    const range = sourceRangeForTiptapTextSelection(editor, source, from, from + "bold words".length);
    assert.equal(source.slice(range!.start, range!.end), "bold words");
    const back = tiptapSelectionForSourceRange(editor, source, range!);
    assert.equal(editor.state.doc.textBetween(back!.from, back!.to), "bold words");
    const item = source.indexOf("Item two");
    const listBack = tiptapSelectionForSourceRange(editor, source, { start: item, end: item + 8 });
    assert.equal(editor.state.doc.textBetween(listBack!.from, listBack!.to), "Item two");
  } finally {
    editor.destroy();
  }
});

test("the link dialog offers headings after # and highlighted passages in other tabs", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const choices: [string, string | undefined][] = [];
  const selectionLinks = [{ href: "../Other/Flight%20notes.md#libera=abc", id: notes.path, label: "The key passage", tabName: notes.name, title: `Link to highlighted text in ${notes.name}` }];
  function Harness() {
    const [value, setState] = useState("");
    return createElement(MarkdownLinkInput, {
      files: [notes], markdown: "# Intro\n\n## Approach\n\nText", selectionLinks, sourcePath: "Notebook/a.md", value,
      onChange: (href, label) => { setState(href); choices.push([href, label]); },
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const options = () => Array.from(host.querySelectorAll('[role="option"]')) as HTMLButtonElement[];
    assert.match(options()[0].textContent!, /Link to highlighted text in Flight notes\.md/);
    await act(async () => options()[0].click());
    assert.deepEqual(choices.at(-1), [selectionLinks[0].href, "The key passage"]);
    await setControlledInput(host.querySelector("input")!, "#appr");
    assert.deepEqual(options().map((option) => option.textContent), ["ApproachHeading · line 3 · #approach"]);
    await act(async () => options()[0].click());
    assert.deepEqual(choices.at(-1), ["#approach", "Approach"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
