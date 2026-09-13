import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { copyRenderedMarkdownSelection, getRenderedSelectionMarkdown } from "../../src/lib/markdown-clipboard";

const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "Element", "HTMLElement", "DOMParser"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
after(() => dom.window.close());

function render(content: string, mathMarkers?: { inlineMathMarkers?: string; blockMathMarkers?: string }) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MarkdownRenderer, { content, copyAsMarkdown: true, renderImages: false, mathMarkers }));
  document.body.replaceChildren(host);
  return host.firstElementChild as HTMLElement;
}
function full(container: HTMLElement, mathMarkers?: { inlineMathMarkers?: string; blockMathMarkers?: string }) {
  const range = document.createRange();
  range.selectNodeContents(container);
  return getRenderedSelectionMarkdown(container, range, mathMarkers);
}

test("chat copy retains headings, nested formatting, links, lists, code and tables", () => {
  const markdown = full(render('# Title\n\n**Bold and *italic*** with [link](https://example.com).\n\n- First\n  - Nested\n\n> Quote\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'));
  assert.match(markdown, /^# Title/);
  assert.match(markdown, /\*\*Bold and \*italic\*\*\*/);
  assert.match(markdown, /\[link\]\(https:\/\/example.com\)/);
  assert.match(markdown, /- First\n\s+- Nested/);
  assert.match(markdown, /> Quote/);
  assert.match(markdown, /```js\nconst x = 1;\n```/);
  assert.match(markdown, /\| A\s*\| B\s*\|/);
});

test("partial inline selections keep balanced formatting and link destinations", () => {
  const host = render('Before **some bold** and [a link](https://example.com) after');
  const range = document.createRange();
  range.setStart(host.querySelector('strong')!.firstChild!, 5);
  range.setEnd(host.querySelector('a')!.firstChild!, 3);
  assert.equal(getRenderedSelectionMarkdown(host, range), '**bold** and [a l](https://example.com)');
});

test("copy preserves task states, ordered list numbering and escaped literal syntax", () => {
  assert.match(full(render('- [x] Done\n- [ ] Pending')), /- \[x\] Done\n- \[ \] Pending/);
  const host = render('3. First\n4. Second\n5. Third');
  const range = document.createRange();
  range.selectNodeContents(host.querySelectorAll('li')[1]);
  assert.equal(getRenderedSelectionMarkdown(host, range), '4. Second');
  assert.equal(full(render('Literal \\*stars\\* and &amp;')), 'Literal \\*stars\\* and &amp;');
});

test("rendered equations copy LaTeX once, including when partially highlighted", () => {
  const host = render('Inline $x^2$\n\n$$\nE=mc^2\n$$');
  const markdown = full(host);
  assert.match(markdown, /\$x\^2\$/);
  assert.match(markdown, /\\\[\nE=mc\^2\n\\\]/);
  assert.doesNotMatch(markdown, /annotation|katex/);
  const range = document.createRange();
  range.selectNodeContents(host.querySelector('.katex-html .mord')!);
  assert.equal(getRenderedSelectionMarkdown(host, range), '$x^2$');
});

test("rendered equations copy with the preferred configured markers", () => {
  const mathMarkers = { inlineMathMarkers: "@@ @@\n\\( \\)", blockMathMarkers: "%% %%" };
  const host = render("Inline @@x^2@@\n\n%%\nE=mc^2\n%%", mathMarkers);
  assert.equal(full(host, mathMarkers), "Inline @@x^2@@\n\n%%\nE=mc^2\n%%");
  const range = document.createRange();
  range.selectNodeContents(host.querySelector(".katex")!);
  assert.equal(getRenderedSelectionMarkdown(host, range, mathMarkers), "@@x^2@@");
});

test("native copy writes only Markdown, spans messages and leaves outside selections alone", () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(MarkdownRenderer, { content: '**First**', copyAsMarkdown: true })) + renderToStaticMarkup(createElement(MarkdownRenderer, { content: '*Second*', copyAsMarkdown: true }));
  document.body.replaceChildren(host);
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(host);
  selection.removeAllRanges(); selection.addRange(range);
  const data = new Map<string, string>([['text/html', 'old']]);
  let prevented = false;
  const event = { clipboardData: { clearData: () => data.clear(), setData: (type: string, value: string) => data.set(type, value) } as unknown as DataTransfer, preventDefault: () => { prevented = true; } };
  assert.equal(copyRenderedMarkdownSelection(host, event), true);
  assert.equal(prevented, true);
  assert.deepEqual([...data], [['text/plain', '**First**\n\n*Second*']]);
  selection.collapse(host, 0);
  assert.equal(copyRenderedMarkdownSelection(host, event), false);
  range.selectNodeContents(document.body);
  selection.removeAllRanges(); selection.addRange(range);
  assert.equal(copyRenderedMarkdownSelection(host, event), false);
});
