import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { remarkMarkdownTextStyles } from "../../src/lib/markdown-text-styles";
import { enumerateMarkdownHeadings } from "../../src/lib/markdown-heading-enumeration";
import {
  enumerateTiptapHeadings, changeTiptapHeadingLevels, getTiptapHeadings,
  getTiptapSelectionMarkdown, trackTiptapRange, replaceTiptapRangeWithMarkdown,
} from "../../src/lib/tiptap-editor-actions";
import { TiptapEditorActions } from "../../src/components/libera/tiptap-editor-actions";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
// jsdom has no layout; these shims let ProseMirror focus the tested menus.
Object.assign(dom.window.Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new dom.window.DOMRect(),
});
Object.assign(globalThis, { innerHeight: 768, innerWidth: 1024 });
after(() => dom.window.close());

function create(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notebook/note.md"), Mathematics], content, contentType: "markdown" });
}

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
