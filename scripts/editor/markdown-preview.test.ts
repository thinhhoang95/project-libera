import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createMarkdownPreviewPatch, prepareMarkdownPreview, type MarkdownPreviewRequest, type MarkdownPreviewResponse } from "../../src/lib/markdown-preview";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { MarkdownWorkerPreview } from "../../src/components/libera/markdown-worker-preview";

test("prepared preview preserves rendering, source maps, custom math and safe link/HTML handling", () => {
  const sources = [
    "# Heading &amp; entities\n\n> Quote **bold**\n\n- [x] Task\n- item\n\n| A | B |\n| - | - |\n| x | y |",
    "Inline $x^2$ and display:\n\n$$\n\\sum_{i=1}^n i\n$$\n\n```latex\n$x$\n```",
    "## Title\n\ny>>>highlight<<< and <u>underline</u> and [color=#ff0000]red[/color].\n\n<span data-font-size=\"20\">large</span>",
    "[unsafe](javascript:alert%281%29) ![unsafe](javascript:bad)\n\n<script>alert(1)</script>\n\n[Note](other.md) ![Image](image.png)",
  ];
  for (const content of sources) {
    for (const mathMarkers of [undefined, {}, { inlineMathMarkers: "\\( \\)", blockMathMarkers: "\\[ \\]" }]) {
      const props = { content, mathMarkers, documentPath: "Notes/test.md", textScale: 1.25 };
      const expected = renderToStaticMarkup(createElement(MarkdownRenderer, props));
      const tree = structuredClone(prepareMarkdownPreview(content, mathMarkers));
      const actual = renderToStaticMarkup(createElement(MarkdownRenderer, { ...props, preparedTree: tree }));
      assert.equal(actual, expected, content);
      assert.doesNotMatch(actual, /href="javascript:|src="javascript:|<script>/);
    }
  }
});

test("preview patches preserve changed offsets and reference links while reusing unchanged blocks", () => {
  let signatures: string[] = [];
  let previous: ReturnType<typeof prepareMarkdownPreview>["children"] = [];
  const versions = [
    "# Title\n\n[Reference][note]\n\n[note]: first.md\n\nLast",
    "# Title\n\n[Reference][note]\n\n[note]: first.md\n\nLast edit",
    "# Longer title\n\n[Reference][note]\n\n[note]: second.md\n\nLast edit",
    "# Only heading",
  ];
  versions.forEach((markdown, index) => {
    const expected = prepareMarkdownPreview(markdown);
    const patch = createMarkdownPreviewPatch(expected, signatures);
    if (index === 1) assert.equal(patch.children[0], 0, "Reuse an unaffected heading");
    const children = patch.children.map(node => typeof node === "number" ? previous[node] : node);
    assert.deepEqual(children, expected.children);
    const props = { content: markdown };
    assert.equal(renderToStaticMarkup(createElement(MarkdownRenderer, { ...props, preparedTree: { type: "root", children } })),
      renderToStaticMarkup(createElement(MarkdownRenderer, props)));
    signatures = patch.signatures;
    previous = children;
  });
});

function setupDom() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
}

test("preview coalesces edits, rejects stale replies, keeps existing DOM nodes and disposes workers", async () => {
  const dom = setupDom();
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers: TestWorker[] = [];
  class TestWorker {
    onmessage: ((event: MessageEvent<MarkdownPreviewResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    requests: MarkdownPreviewRequest[] = [];
    terminated = false;
    signatures: string[] = [];
    constructor() { workers.push(this); }
    postMessage(request: MarkdownPreviewRequest) { this.requests.push(request); }
    terminate() { this.terminated = true; }
    reply(request: MarkdownPreviewRequest) {
      const patch = createMarkdownPreviewPatch(prepareMarkdownPreview(request.markdown, request.mathMarkers), this.signatures);
      this.signatures = patch.signatures;
      this.onmessage?.({ data: { id: request.id, children: patch.children } } as MessageEvent<MarkdownPreviewResponse>);
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
  const root = createRoot(document.getElementById("root")!);
  const ready: string[] = [];
  const onContentReady = (content: string) => { ready.push(content); };
  const render = async (content: string, key = "first", baseFontSize = 16) => {
    await act(async () => { root.render(createElement(MarkdownWorkerPreview, { key, content, mathMarkers: {}, onContentReady, baseFontSize })); });
  };
  try {
    await render("# Title\n\nFirst");
    const worker = workers[0];
    assert.match(document.body.textContent!, /Preparing preview/);
    await act(async () => { worker.reply(worker.requests[0]); });
    const heading = document.querySelector("h1");
    assert.ok(heading);
    await render("# Title\n\nSecond");
    await render("# Title\n\nThird");
    await render("# Title\n\nLatest");
    assert.equal(worker.requests.length, 2, "Keep only one worker job in flight");
    assert.match(document.body.textContent!, /First/, "Previous preview remains visible");
    await act(async () => { worker.reply(worker.requests[1]); });
    assert.equal(worker.requests.length, 3);
    assert.equal(worker.requests[2].markdown, "# Title\n\nLatest");
    assert.equal(ready.length, 1, "Do not tell scroll sync an obsolete preview is ready");
    await act(async () => { worker.reply(worker.requests[2]); });
    assert.match(document.body.textContent!, /Latest/);
    assert.equal(document.querySelector("h1"), heading, "Stable renderer components preserve unchanged DOM nodes");
    assert.equal(ready.at(-1), "# Title\n\nLatest");
    await render("# Title\n\nLatest", "first", 18);
    assert.equal(worker.requests.length, 3, "Typography changes do not reparse Markdown");
    await render("# Pending");
    await render("# Other tab", "second");
    assert.equal(worker.terminated, true);
    await act(async () => { worker.reply(worker.requests.at(-1)!); });
    assert.doesNotMatch(document.body.textContent!, /Pending|Latest/, "Never show the previous tab's preview");
    await act(async () => { workers[1].onerror?.(); });
    assert.match(document.body.textContent!, /Preview unavailable/, "Worker failure does not silently reparse on the main thread");
  } finally {
    await act(async () => { root.unmount(); });
    assert.ok(workers.every((worker) => worker.terminated));
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    dom.window.close();
  }
});

test('semantic preview reuse updates exact source coordinates without rewriting unchanged content', async () => {
  const { createMarkdownPreviewCache } = await import('../../src/lib/markdown-preview-patch');
  const dom = setupDom();
  const root = createRoot(document.getElementById('root')!);
  const cache = createMarkdownPreviewCache();
  let previous: ReturnType<typeof prepareMarkdownPreview>['children'] = [];
  async function render(content: string, textScale = 1) {
    const patch = cache.patch(prepareMarkdownPreview(content));
    const children = patch.children.map(node => typeof node === 'number' ? previous[node] : node);
    const prior = previous;
    previous = children;
    await act(async () => root.render(createElement(MarkdownRenderer, { content, textScale, preparedTree: { type: 'root', children }, preparedSources: patch.sources })));
    const expected = document.createElement('div');
    expected.innerHTML = renderToStaticMarkup(createElement(MarkdownRenderer, { content, textScale }));
    const actual = document.createElement('div');
    actual.innerHTML = document.getElementById('root')!.innerHTML.replace(/ data-preview-source-id="[^"]*"/g, '');
    for (const container of [actual, expected]) for (const element of container.querySelectorAll<HTMLElement>('[style]')) element.setAttribute('style', element.style.cssText);
    assert.equal(actual.innerHTML, expected.innerHTML, content);
    return { children, prior };
  }
  try {
    const source = '# Title\n\nParagraph **bold**.\n\n## Later\n\n[Ref][r]\n\n[r]: first.md';
    await render(source);
    const paragraph = document.querySelector('p')!;
    const bold = paragraph.querySelector('strong');
    const { children, prior } = await render(source.replace('Title', 'Longer title'));
    assert.equal(children[2], prior[2], 'Position-only changes preserve rendered HAST identity');
    assert.equal(document.querySelector('p'), paragraph);
    assert.equal(paragraph.querySelector('strong'), bold);
    await render(source.replace('Title', 'Longer title'), 1.25);
    await render('New block\n\n' + source.replace('first.md', 'second.md'));
    assert.equal(document.querySelector('a')?.getAttribute('href'), 'second.md');
    await render('| A | B |\n| - | - |\n| same | same |\n\n$$\nx^2\n$$\n\nSame\n\nSame');
    await render('Prefix\n\n| A | B |\n| - | - |\n| same | same |\n\n$$\nx^2\n$$\n\nSame\n\nSame');
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test('cached equations preserve fenced math, custom markers and invalid-formula rendering', () => {
  for (const content of ['```math\nx^2\n```', 'Inline $\\badcommand{x}$ and $x^2$.', '$$\n\\tag{1} x^2\n$$']) {
    for (let i = 0; i < 2; i++) {
      const props = { content: '# Heading' + 'x'.repeat(i) + '\n\n' + content };
      assert.equal(renderToStaticMarkup(createElement(MarkdownRenderer, { ...props, preparedTree: prepareMarkdownPreview(props.content) })), renderToStaticMarkup(createElement(MarkdownRenderer, props)));
    }
  }
});
