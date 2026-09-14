import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { HighlightTool, highlightToolKey } from "../../src/lib/tiptap-highlight-tool";
import { findTiptapTextMatches } from "../../src/lib/tiptap-find";
import { findTextMatches, replaceTextMatches } from "../../src/lib/text-find";
import { remarkMarkdownTextStyles } from "../../src/lib/markdown-text-styles";
import { enumerateMarkdownHeadings } from "../../src/lib/markdown-heading-enumeration";
import {
  enumerateTiptapHeadings, changeTiptapHeadingLevels, getTiptapHeadings,
  getTiptapSelectionMarkdown, trackTiptapRange, replaceTiptapRangeWithMarkdown,
} from "../../src/lib/tiptap-editor-actions";
import { TiptapEditorActions } from "../../src/components/libera/tiptap-editor-actions";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { MARKDOWN_OUTLINE_NAVIGATE_EVENT } from "../../src/lib/markdown-outline-navigation";

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

function create(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notebook/note.md"), Mathematics], content, contentType: "markdown" });
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

async function settleVisualDraft() {
  // The live document updates immediately; Markdown publication follows a pause.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}

test("visual outline navigation scrolls to repeated formatted headings without changing content", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const markdown = 'Setext\n======\n\n> ## Nested\n\n```md\n## **Repeated**\n```\n\n## **Repeated**\n\nFirst section\n\n## **Repeated**\n\nSecond section';
  const changes: string[] = [];
  const viewStateChanges: { line?: number }[] = [];
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: "Notebook/outline.md", value: markdown,
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onViewStateChange: (patch) => viewStateChanges.push(patch),
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const headings = Array.from(host.querySelectorAll<HTMLElement>(".libera-tiptap h1, .libera-tiptap h2"));
    assert.equal(headings.length, 4);
    const scrolled: HTMLElement[] = [];
    headings.forEach((heading) => {
      heading.scrollIntoView = (options) => {
        assert.deepEqual(options, { block: "start", inline: "nearest" });
        scrolled.push(heading);
      };
    });
    async function navigate(documentPath: string, source = markdown) {
      await act(async () => {
        window.dispatchEvent(new dom.window.CustomEvent(MARKDOWN_OUTLINE_NAVIGATE_EVENT, {
          detail: { documentPath, markdown: source, offset: markdown.lastIndexOf("## **Repeated**") },
        }));
      });
    }
    await navigate("Notebook/other.md");
    await navigate("Notebook/outline.md", "stale source");
    assert.equal(scrolled.length, 0);
    await navigate("Notebook/outline.md");
    await navigate("Notebook/outline.md");
    assert.deepEqual(scrolled, [headings[3], headings[3]]);
    assert.equal(window.getSelection()?.anchorNode?.parentElement?.closest("h2"), headings[3]);
    assert.equal(document.activeElement, host.querySelector(".libera-tiptap"));
    assert.equal(viewStateChanges.at(-1)?.line, markdown.slice(0, markdown.lastIndexOf("## **Repeated**")).split("\n").length);
    assert.deepEqual(changes, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function roundTrip(markdown: string) {
  const first = create(markdown);
  const serialized = first.getMarkdown();
  const second = create(serialized);
  try {
    assert.deepEqual(second.getJSON(), first.getJSON(), serialized);
    return { json: first.getJSON(), markdown: serialized, html: first.getHTML() };
  } finally { first.destroy(); second.destroy(); }
}

test("headings, lists, tasks, links, code, tables and math survive a Markdown round trip", () => {
  const result = roundTrip('# Title\n\n**bold** and _italic_ and ~~strike~~ and <u>underlined</u>.\n\n- item\n- [x] done\n\n1. first\n2. second\n\n> quote\n\n[Note](other.md)\n\n```js\nconst formula = "$x$";\n```\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\nInline $x^2$\n\n$$\n\\frac{a}{b}\n$$');
  assert.match(result.html, /data-type="inline-math"/);
  assert.match(result.html, /data-type="block-math"/);
  assert.match(result.html, /<table/);
  assert.match(result.markdown, /<u>underlined<\/u>/);
});

test("colored highlights and text colors keep their Libera syntax", () => {
  const result = roundTrip('r>>>**red** highlight<<< and [color=#2563eb]blue[/color]');
  assert.match(result.html, /data-color="#dc2626"/);
  assert.match(result.html, /color: rgb\(37, 99, 235\)/);
  assert.match(result.markdown, /r>>>/);
});

test("default highlights at block and list starts are not mistaken for blockquotes", () => {
  const result = roundTrip('>>>highlight<<< tail\n\n- >>>list highlight<<<\n\n> actual quote\n\n`>>>literal<<<`');
  assert.match(result.html, /<mark[^>]*>highlight<\/mark> tail/);
  assert.match(result.html, /<mark[^>]*>list highlight<\/mark>/);
  assert.match(result.html, /<blockquote><p>actual quote/);
  assert.match(result.html, /<code>&gt;&gt;&gt;literal&lt;&lt;&lt;<\/code>/);
});

test("font size, line spacing, color and nested bold are preserved together", () => {
  const result = roundTrip('<span data-font-size="24" data-line-height="2">[color=#2563eb]**large blue**[/color]</span>');
  assert.match(result.html, /font-size: 24px/);
  assert.match(result.html, /line-height: 2/);
  assert.match(result.html, /<strong>large blue<\/strong>/);
  assert.match(result.html, /color: rgb\(37, 99, 235\)/);
});

test("opening a document does not emit a change and formatting supports undo", () => {
  const editor = create("hello");
  let updates = 0;
  editor.on("update", () => updates++);
  assert.equal(updates, 0);
  editor.commands.setTextSelection({ from: 1, to: 6 });
  editor.commands.setHighlight({ color: "#15803d" });
  assert.equal(updates, 1);
  assert.match(editor.getMarkdown(), /g>>>hello<<</);
  editor.commands.undo();
  assert.equal(editor.getMarkdown(), "hello");
  editor.destroy();
});

test("highlight tool remembers its color, paints successive selections, and stops without erasing marks", async () => {
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Notebook/note.md"), HighlightTool], content: "one two three", contentType: "markdown" });
  document.body.append(editor.view.dom);
  const colorAt = (pos: number) => editor.state.doc.nodeAt(pos)?.marks.find((mark) => mark.type.name === "highlight")?.attrs.color;
  try {
    editor.commands.setTextSelection({ from: 1, to: 4 });
    editor.commands.setHighlightToolColor("#15803d");
    assert.equal(editor.getMarkdown(), "one two three");
    assert.equal(highlightToolKey.getState(editor.state)?.active, false);
    editor.commands.setHighlightToolActive(true);
    assert.equal(colorAt(1), "#15803d");
    editor.commands.setHighlightToolColor("#2563eb");
    assert.equal(colorAt(1), "#15803d", "Choosing a color must not repaint an existing selection");

    editor.commands.setTextSelection({ from: 5, to: 8 });
    editor.view.focus();
    editor.view.dom.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(colorAt(5), "#2563eb");
    editor.commands.setTextSelection({ from: 9, to: 14 });
    editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(colorAt(9), "#2563eb");
    assert.equal(highlightToolKey.getState(editor.state)?.active, true);

    editor.commands.setTextSelection(14);
    editor.view.dispatch(editor.state.tr.insertText("!"));
    assert.equal(colorAt(14), "#2563eb");
    editor.commands.setTextSelection({ from: 5, to: 8 });
    const highlighted = editor.getMarkdown();
    editor.commands.setHighlightToolActive(false);
    assert.equal(editor.getMarkdown(), highlighted);
    editor.commands.setTextSelection(15);
    editor.view.dispatch(editor.state.tr.insertText("?"));
    assert.equal(colorAt(15), undefined);

    editor.commands.setHighlightToolActive(true);
    editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(highlightToolKey.getState(editor.state)?.active, false);
    assert.equal(highlightToolKey.getState(editor.state)?.color, "#2563eb");
  } finally { editor.destroy(); }
});

test("visual find matches case-insensitively across inline formatting but not across blocks", () => {
  const editor = create("One **two** one\n\nONE");
  try {
    assert.equal(findTiptapTextMatches(editor.state.doc, "one").length, 3);
    assert.equal(findTiptapTextMatches(editor.state.doc, "ONE TWO").length, 1);
    assert.equal(findTiptapTextMatches(editor.state.doc, "one one").length, 0);
    assert.equal(findTiptapTextMatches(editor.state.doc, "o?e", { wildcards: true }).length, 3);
  } finally {
    editor.destroy();
  }
});

test("wildcard find supports star, question mark, escaping, and literal replacement", () => {
  const value = "file-01.md file-aa.md file-123.md\na*b a?b axb";
  assert.deepEqual(
    findTextMatches(value, "file-??.md", { wildcards: true }).map((match) => value.slice(match.start, match.end)),
    ["file-01.md", "file-aa.md"],
  );
  assert.deepEqual(
    findTextMatches(value, "a\\*b", { wildcards: true }).map((match) => value.slice(match.start, match.end)),
    ["a*b"],
  );
  assert.deepEqual(
    findTextMatches(value, "a\\?b", { wildcards: true }).map((match) => value.slice(match.start, match.end)),
    ["a?b"],
  );
  assert.equal(findTextMatches("start here\nend there", "start*end", { wildcards: true }).length, 0);
  const matches = findTextMatches("one ONE one", "one");
  assert.equal(replaceTextMatches("one ONE one", matches, "two"), "two two two");
});

test("image assets retain portable relative paths when serialized", () => {
  const result = roundTrip('![Photo](.assets/photo.png)');
  assert.match(result.markdown, /\.assets\/photo.png/);
  assert.doesNotMatch(result.markdown, /api\/markdown-assets/);
});

test("style preview accepts only bounded numeric attributes and leaves code alone", () => {
  const tree = { type: "root", children: [{ type: "paragraph", children: [
    { type: "html", value: '<span data-font-size="24" data-line-height="2" onclick="alert(1)">' },
    { type: "text", value: "styled" }, { type: "html", value: "</span>" },
  ] }, { type: "code", value: '<span data-font-size="24">literal</span>' }] };
  remarkMarkdownTextStyles()(tree);
  assert.deepEqual(tree.children[0].children?.[0], { type: "liberaTextStyle", children: [{ type: "text", value: "styled" }], data: { hName: "span", hProperties: { "data-font-size": "24", "data-line-height": "2" } } });
  assert.equal(tree.children[1].type, "code");
});

test("visual heading numbering matches source, preserves inline formatting and undoes in one step", () => {
  const markdown = '# **Title**\n\n## Child $x^2$\n\n### Leaf\n\n## Next\n\n# Last\n\n```md\n# Not a heading\n```';
  const editor = create(markdown);
  const original = editor.getJSON();
  enumerateTiptapHeadings(editor, "all");
  assert.equal(editor.getMarkdown(), enumerateMarkdownHeadings(markdown, { scope: "all" }));
  assert.match(editor.getHTML(), /<strong>.*Title<\/strong>/);
  assert.match(editor.getHTML(), /data-type="inline-math"/);
  const numbered = editor.getJSON();
  assert.equal(enumerateTiptapHeadings(editor, "all"), false);
  assert.deepEqual(editor.getJSON(), numbered);
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(), original);
  editor.destroy();
});

test("selected heading numbering supports a custom start, ancestor context and untouched siblings", () => {
  const editor = create('# First\n\n# Second\n\n## Child\n\n### Leaf\n\n## Sibling\n\n# Last');
  const headings = getTiptapHeadings(editor, editor.state.selection);
  const range = { from: headings[2].pos + 1, to: headings[3].pos + headings[3].node.nodeSize - 1 };
  enumerateTiptapHeadings(editor, "selected", range, 5);
  assert.equal(editor.getMarkdown(), '# First\n\n# Second\n\n## 2.5. Child\n\n### 2.5.1. Leaf\n\n## Sibling\n\n# Last');
  const after = editor.getJSON();
  assert.equal(enumerateTiptapHeadings(editor, "selected", { from: 1, to: 1 }, 3), false);
  assert.deepEqual(editor.getJSON(), after);
  editor.destroy();
});

test("heading numbers never replace a leading equation or the text after it", () => {
  const editor = create('# $x^2$2. formula');
  enumerateTiptapHeadings(editor, "all");
  assert.equal(editor.getMarkdown(), '# 1. $x^2$2. formula');
  assert.equal(enumerateTiptapHeadings(editor, "all"), false);
  editor.destroy();
});

test("selected numbering excludes a heading when the selection ends at its text start", () => {
  const editor = create('# First\n\n## Next');
  const headings = getTiptapHeadings(editor, editor.state.selection);
  enumerateTiptapHeadings(editor, "selected", { from: 1, to: headings[1].pos + 1 }, 3);
  assert.equal(editor.getMarkdown(), '# 3. First\n\n## Next');
  editor.destroy();
});

test("numbering empty headings is idempotent in both editors", () => {
  const editor = create('#\n\n##');
  enumerateTiptapHeadings(editor, "all");
  const markdown = editor.getMarkdown();
  enumerateTiptapHeadings(editor, "all");
  assert.equal(editor.getMarkdown(), markdown);
  assert.equal(enumerateMarkdownHeadings(markdown, { scope: "all" }), markdown);
  editor.destroy();
});

test("heading indentation preserves marks, respects levels 1–6 and supports undo", () => {
  const editor = create('# **Title**\n\n## Child\n\n###### Limit\n\nBody');
  const original = editor.getJSON();
  changeTiptapHeadingLevels(editor, { from: 1, to: editor.state.doc.content.size }, "indent");
  assert.deepEqual(getTiptapHeadings(editor, editor.state.selection).map(({ node }) => node.attrs.level), [2, 3, 6]);
  assert.match(editor.getHTML(), /<strong>Title<\/strong>/);
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(), original);
  changeTiptapHeadingLevels(editor, { from: 1, to: editor.state.doc.content.size }, "unindent");
  assert.deepEqual(getTiptapHeadings(editor, editor.state.selection).map(({ node }) => node.attrs.level), [1, 1, 5]);
  editor.destroy();
});

test("AI selection serialization includes marks and only the selected content", () => {
  const editor = create('before **selected** after');
  assert.equal(getTiptapSelectionMarkdown(editor, { from: 8, to: 16 }), '**selected**');
  editor.destroy();
});

test("pending AI replacement follows edits outside its selection and has its own undo step", () => {
  const editor = create('before selected after');
  const tracked = trackTiptapRange(editor, { from: 8, to: 16 });
  editor.commands.insertContentAt(1, 'New ');
  assert.equal(tracked.isValid(), true);
  assert.deepEqual(tracked.range, { from: 12, to: 20 });
  tracked.dispose();
  replaceTiptapRangeWithMarkdown(editor, tracked.range, '**rewritten**');
  assert.equal(editor.getMarkdown(), 'New before **rewritten** after');
  editor.commands.undo();
  assert.equal(editor.getMarkdown(), 'New before selected after');
  editor.destroy();
});

test("pending AI replacement is invalidated when selected text is edited or removed", () => {
  for (const replacement of ['changed', '']) {
    const editor = create('before selected after');
    const tracked = trackTiptapRange(editor, { from: 8, to: 16 });
    editor.commands.insertContentAt({ from: 8, to: 16 }, replacement);
    assert.equal(tracked.isValid(), false);
    tracked.dispose();
    editor.destroy();
  }
});

test("image-to-Markdown replacement is undoable without losing the original asset", () => {
  const editor = create('Before\n\n![Photo](_assets/photo.png)\n\nAfter');
  let from = 0;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') from = pos; });
  replaceTiptapRangeWithMarkdown(editor, { from, to: from + 1 }, '## Extracted\n\nImage text');
  assert.match(editor.getMarkdown(), /## Extracted/);
  assert.doesNotMatch(editor.getMarkdown(), /photo.png/);
  editor.commands.undo();
  assert.match(editor.getMarkdown(), /!\[Photo\]\(_assets\/photo.png\)/);
  editor.destroy();
});

test("visual toolbar and right-click menus expose and execute heading actions", async () => {
  const editor = create('# Title\n\n## Child');
  document.body.append(editor.view.dom);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(TiptapEditorActions, { editor, documentPath: 'Notebook/note.md', onError: (message: string) => { if (message) assert.fail(message); } })); });
    const toolbarButton = host.querySelector<HTMLButtonElement>('[aria-label="Enumerate Headings"]')!;
    assert.ok(toolbarButton);
    await act(async () => { toolbarButton.click(); });
    assert.ok(document.querySelector('[aria-label="Heading numbering"]'));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
      editor.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector('[aria-label="Editor actions"]')!;
    assert.ok(menu);
    for (const label of ['AI Format', 'AI Rewrite', 'Indent Headings', 'Unindent Headings', 'Enumerate All Headings', 'Enumerate Selected Headings']) assert.ok(menu.textContent?.includes(label), label);
    const enumerate = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent?.includes('Enumerate All Headings'))!;
    await act(async () => { enumerate.click(); });
    assert.equal(editor.getMarkdown(), '# 1. Title\n\n## 1.1. Child');
    assert.equal(document.querySelector('[aria-label="Editor actions"]'), null);
  } finally {
    await act(async () => root.unmount());
    editor.destroy();
    host.remove();
  }
});

test("right-clicking a rendered image targets its stored asset and aborts AI on unmount", async () => {
  const editor = create('Before\n\n![Photo](_assets/photo.png)\n\nAfter');
  document.body.append(editor.view.dom);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const originalFetch = globalThis.fetch;
  let requested: RequestInit | undefined;
  let requestedUrl = '';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestedUrl = url;
    requested = init;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    await act(async () => { root.render(createElement(TiptapEditorActions, { editor, documentPath: 'Notebook/note.md', onError: (message: string) => { if (message) assert.fail(message); } })); });
    await act(async () => { editor.view.dom.querySelector('img')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const menu = document.querySelector('[aria-label="Editor actions"]')!;
    const button = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'AI Image to Markdown')!;
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.equal(requestedUrl, '/api/ai-image-to-markdown');
    assert.deepEqual(JSON.parse(String(requested?.body)), { documentPath: 'Notebook/note.md', imageSource: '_assets/photo.png', alt: 'Photo' });
    await act(async () => root.unmount());
    assert.equal(requested?.signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    editor.destroy();
    host.remove();
  }
});

test("visual editor mounts after deferred initialization in React Strict Mode without user interaction", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(TiptapMarkdownEditor, {
        documentPath: 'Notebook/note.md', value: '# Ready\n\nEditable text',
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.doesNotMatch(host.textContent ?? '', /Loading visual editor/);
    const editable = host.querySelector('[role="textbox"][contenteditable="true"]');
    assert.ok(editable, 'The editor must mount before any transaction or user interaction');
    assert.match(editable.textContent ?? '', /Ready/);
    assert.match(editable.textContent ?? '', /Editable text/);
    assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="Text style"]')?.value, '1');
    assert.equal(changes.length, 0, 'Mounting must not rewrite or dirty the document');
    const highlightColor = host.querySelector<HTMLSelectElement>('[aria-label="Highlight color"]')!;
    const highlightButton = host.querySelector<HTMLButtonElement>('[aria-label="Highlight"]')!;
    await act(async () => {
      highlightColor.value = '#15803d';
      highlightColor.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(highlightColor.value, '#15803d');
    assert.equal(highlightButton.getAttribute('aria-pressed'), 'false');
    assert.equal(changes.length, 0, 'Choosing a highlight color must not edit the document');
    await act(async () => { highlightButton.click(); });
    assert.equal(highlightButton.getAttribute('aria-pressed'), 'true');
    await act(async () => {
      highlightColor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(highlightButton.getAttribute('aria-pressed'), 'false');
    assert.equal(highlightColor.value, '#15803d');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!.click(); });
    assert.equal(host.querySelector('[aria-label="Bold"]')?.getAttribute('aria-pressed'), 'true', 'Toolbar subscriptions must still update after mounting');
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(TiptapMarkdownEditor, {
        key: 'second-note', documentPath: 'Notebook/second.md', value: '',
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.ok(host.querySelector('[role="textbox"][contenteditable="true"]'), 'An empty note must also mount after switching documents');
    assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="Text style"]')?.value, '0');
    assert.equal(changes.length, 0, 'Opening a second note must not rewrite it');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual editor opens find with Mod-F, highlights matches, navigates, and closes without editing", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: "Notebook/find.md", value: "Alpha **beta Alpha** alpha",
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const editable = host.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')!;
    await act(async () => {
      editable.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const input = host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!;
    assert.ok(input, "Mod-F must open the visual editor's find panel");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "alpha");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      input.dispatchEvent(event);
    });
    assert.match(host.textContent ?? "", /1\/3/);
    assert.equal(host.querySelectorAll(".markdown-editor-find-match-active").length, 1);
    assert.equal(host.querySelectorAll(".markdown-editor-find-match").length, 3);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click(); });
    assert.match(host.textContent ?? "", /2\/3/);
    assert.ok(host.querySelector("strong .markdown-editor-find-match-active"));
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.match(host.textContent ?? "", /3\/3/);
    const scrollContainer = editable.parentElement!.parentElement! as HTMLElement;
    const originalFocus = editable.focus.bind(editable);
    scrollContainer.scrollLeft = 45;
    scrollContainer.scrollTop = 420;
    editable.focus = (options?: FocusOptions) => {
      scrollContainer.scrollLeft = 5;
      scrollContainer.scrollTop = 20;
      originalFocus(options);
    };
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(host.querySelector('[aria-label="Find in note"]'), null);
    assert.equal(host.querySelectorAll(".markdown-editor-find-match").length, 0);
    assert.equal(scrollContainer.scrollLeft, 45);
    assert.equal(scrollContainer.scrollTop, 420, "Closing find must keep the matched text in view");
    assert.deepEqual(changes, [], "Finding must not change or dirty the Markdown");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual find replaces one or all wildcard matches in single undoable edits", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const original = "Alpha **beta Alpha** alpha";
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: "Notebook/replace.md", value: original,
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const editable = host.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')!;
    await act(async () => {
      editable.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await setControlledInput(host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!, "A?pha");
    await act(async () => { host.querySelector<HTMLInputElement>('[aria-label="Wildcard matches"]')!.click(); });
    await setControlledInput(host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!, "Z");
    assert.match(host.textContent ?? "", /1\/3/);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click(); });
    // Select the explicit Replace button rather than relying on toolbar order.
    const replaceButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Replace")!;
    await act(async () => { replaceButton.click(); });
    await settleVisualDraft();
    assert.equal(changes.at(-1), "Alpha **beta Z** alpha");
    assert.equal(host.querySelector("strong")?.textContent, "beta Z");
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(); });
    await settleVisualDraft();
    assert.equal(changes.at(-1), original);

    const replaceAllButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Replace all")!;
    await act(async () => { replaceAllButton.click(); });
    await settleVisualDraft();
    assert.equal(changes.at(-1), "Z **beta Z** Z");
    assert.match(host.textContent ?? "", /0\/0/);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(); });
    await settleVisualDraft();
    assert.equal(changes.at(-1), original, "Replace All must undo in one step");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("source find replaces wildcard matches without affecting unmatched Markdown", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const textareaRef = createRef<HTMLTextAreaElement>();
  try {
    await act(async () => {
      root.render(createElement(MarkdownEditor, {
        activeFilePath: "Notebook/source.md", files: [], formatting: false, fontFamily: "monospace",
        fontSizePx: 14, imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [],
        textareaRef, value: "item-01; item-aa; item-123;",
        onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {},
        onChange: (value) => changes.push(value), onInsertFileLink: () => {}, onInsertImageFile: async () => {},
      }));
    });
    await act(async () => {
      textareaRef.current!.focus();
      textareaRef.current!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await setControlledInput(host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!, "item-??;");
    await act(async () => { host.querySelector<HTMLInputElement>('[aria-label="Wildcard matches"]')!.click(); });
    await setControlledInput(host.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!, "X");
    assert.match(host.textContent ?? "", /1\/2/);
    const replaceAll = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Replace all")!;
    await act(async () => { replaceAll.click(); });
    assert.equal(changes.at(-1), "X X item-123;");
    assert.equal(textareaRef.current?.value, "X X item-123;");
    const textarea = textareaRef.current!;
    const findInput = host.querySelector<HTMLInputElement>('[aria-label="Find in note"]')!;
    const originalFocus = textarea.focus.bind(textarea);
    let preventedScroll = false;
    textarea.scrollLeft = 35;
    textarea.scrollTop = 360;
    textarea.focus = (options?: FocusOptions) => {
      preventedScroll = options?.preventScroll === true;
      textarea.scrollLeft = 3;
      textarea.scrollTop = 12;
      originalFocus(options);
    };
    await act(async () => {
      findInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(preventedScroll, true);
    assert.equal(textarea.scrollLeft, 35);
    assert.equal(textarea.scrollTop, 360, "Closing source find must preserve its current viewport");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual editor renders tagged block equations in display mode and keeps inline math inline", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: 'Notebook/math.md',
        value: String.raw`Inline $x^2$.

$$
E = mc^2 \tag{1}
$$

$$
a = b \tag*{Custom}
$$`,
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(host.querySelectorAll('.katex-error').length, 0, 'Valid tagged equations must not produce KaTeX errors');
    const blocks = host.querySelectorAll('[data-type="block-math"]');
    assert.equal(blocks.length, 2);
    for (const block of blocks) {
      assert.ok(block.querySelector('.katex-display .tag'), 'Block equations must render their tags in display mode');
    }
    const inline = host.querySelector('[data-type="inline-math"]');
    assert.ok(inline?.querySelector('.katex'));
    assert.equal(inline?.querySelector('.katex-display'), null);
    assert.equal(changes.length, 0, 'Rendering must preserve the original Markdown');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual editor renders ChatGPT markers directly and the equation fixer preserves recognized math", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: 'Notebook/chatgpt.md',
        value: String.raw`A TV plan for \(v\):

\[
(w^v,h^v,y^v,z^v)\in P_v
\]`,
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Fix ChatGPT equations"]')!;
    assert.ok(button);
    assert.equal(button.previousElementSibling?.getAttribute('aria-label'), 'Save document');
    const zoom = host.querySelector('[aria-label="Rendered Markdown text zoom"]')!;
    assert.ok(zoom && (button.compareDocumentPosition(zoom) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING), 'Zoom remains after the equation fixer, including the LaTeX export control');
    const original = host.querySelector('.libera-tiptap')!.innerHTML;
    await act(async () => { button.click(); });
    assert.equal(host.querySelectorAll('[data-type="inline-math"]').length, 1);
    assert.equal(host.querySelectorAll('[data-type="block-math"]').length, 1);
    await settleVisualDraft();
    assert.deepEqual(changes, [], "Recognized equations need no conversion or source rewrite");
    assert.equal(host.querySelectorAll('.katex-error').length, 0);
    const changeCount = changes.length;
    await act(async () => { button.click(); });
    assert.equal(changes.length, changeCount, 'Repeated fixing must not emit an update');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(); });
    assert.equal(host.querySelector('.libera-tiptap')!.innerHTML, original);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual equation fixer handles escaped serialization of pasted literal delimiters", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: 'Notebook/pasted.md',
        value: String.raw`**Keep bold** and \\(v\\).

\\[
x = y
\\]`,
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: () => {}, onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Fix ChatGPT equations"]')!.click(); });
    assert.equal(host.querySelectorAll('[data-type="inline-math"]').length, 1);
    assert.equal(host.querySelectorAll('[data-type="block-math"]').length, 1);
    assert.equal(host.querySelector('.libera-tiptap strong')?.textContent, 'Keep bold');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(); });
    assert.equal(host.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]').length, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual editor native copy writes Markdown without editing the document", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: "Notebook/copy.md", value: "# **Heading**\n\nAfter",
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: (value) => changes.push(value), onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    const surface = host.querySelector<HTMLElement>(".libera-tiptap")!;
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 8 }); });
    const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
    const data = new Map<string, string>();
    Object.defineProperty(event, "clipboardData", { value: { clearData: () => data.clear(), setData: (type: string, value: string) => data.set(type, value) } });
    surface.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual([...data], [["text/plain", "# **Heading**"]]);
    assert.deepEqual(changes, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("visual editor pastes Markdown as formatting, replaces selections and supports undo", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(TiptapMarkdownEditor, {
        documentPath: "Notebook/paste.md", value: "Before selected after",
        fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
        onChange: () => {}, onSave: async () => {}, onOpenFileLink: async () => false,
      }));
    });
    const surface = host.querySelector<HTMLElement>(".libera-tiptap")!;
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    async function paste(text: string, html = "", markdown = "") {
      const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : type === "text/markdown" ? markdown : "" } });
      await act(async () => { surface.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
    }
    await act(async () => { editor.commands.setTextSelection({ from: 8, to: 16 }); });
    await paste("**bold** and [link](https://example.com)");
    assert.equal(editor.getMarkdown(), "Before **bold** and [link](https://example.com) after");
    await act(async () => { editor.commands.undo(); });
    assert.equal(editor.getMarkdown(), "Before selected after");
    await act(async () => { editor.commands.setContent("", { contentType: "markdown" }); });
    await paste("# Heading\n\n- First\n- Second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n$x^2$");
    assert.equal(surface.querySelector("h1")?.textContent, "Heading");
    assert.equal(surface.querySelectorAll("li").length, 2);
    assert.ok(surface.querySelector("table"));
    assert.match(surface.querySelector("pre")?.textContent ?? "", /const x = 1/);
    assert.ok(surface.querySelector('[data-type="inline-math"]'));
    await act(async () => { editor.commands.setContent("", { contentType: "markdown" }); });
    await paste("**plain**", "<p><em>Rich text</em></p>");
    assert.equal(editor.getMarkdown(), "*Rich text*");
    await act(async () => { editor.commands.setContent("", { contentType: "markdown" }); });
    await paste("fallback", "<p>HTML</p>", "**Explicit Markdown**");
    assert.equal(editor.getMarkdown(), "**Explicit Markdown**");
    await act(async () => { editor.commands.setContent("```\ncode\n```", { contentType: "markdown" }); editor.commands.setTextSelection({ from: 1, to: 5 }); });
    await paste("**literal**");
    assert.equal(surface.querySelector("pre")?.textContent, "**literal**");
    assert.equal(surface.querySelector("strong"), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('find navigation retains matches and block caches map offsets through edits', async () => {
  const { TiptapFind, tiptapFindPluginKey, updateTiptapFind } = await import('../../src/lib/tiptap-find');
  const editor = new Editor({ extensions: [...createMarkdownExtensions('Notes/find.md'), TiptapFind], content: 'one **one**\n\nLater one', contentType: 'markdown' });
  try {
    updateTiptapFind(editor, { query: 'one' });
    const before = tiptapFindPluginKey.getState(editor.state)!;
    updateTiptapFind(editor, { activeMatchIndex: 1 });
    const selected = tiptapFindPluginKey.getState(editor.state)!;
    assert.equal(selected.matches, before.matches);
    assert.equal(editor.view.dom.querySelectorAll('.markdown-editor-find-match-active').length, 1);
    editor.commands.insertContentAt(1, 'Prefix ');
    const after = tiptapFindPluginKey.getState(editor.state)!;
    assert.deepEqual(after.matches, before.matches.map(match => ({ from: match.from + 7, to: match.to + 7 })));
    updateTiptapFind(editor, { query: 'Later' });
    assert.equal(tiptapFindPluginKey.getState(editor.state)!.matches.length, 1);
  } finally { editor.destroy(); }
});
