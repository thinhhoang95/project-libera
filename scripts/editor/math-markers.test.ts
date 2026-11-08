import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '../../src/components/markdown-renderer';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { MarkdownManager } from '@tiptap/markdown';
import { createMarkdownExtensions } from '../../src/lib/tiptap-markdown';
import { createMathExtensions } from '../../src/lib/tiptap-math';
import { remarkMathMarkers } from '../../src/lib/remark-math-markers';
import { normalizeMarkdownPreferences } from '../../src/lib/markdown-preferences';

const settings = { inlineMathMarkers: '$ $\n\\( \\)\n@@ @@', blockMathMarkers: '$$ $$\n\\[ \\]\n%% %%' };
const manager = new MarkdownManager({ extensions: [...createMarkdownExtensions(''), ...createMathExtensions(settings)] });
function renderTree(source: string) {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMathMarkers, settings).parse(source);
}
type TestNode = { type: string; attrs: Record<string, string>; marks: { type: string }[]; children?: TestNode[]; content?: TestNode[]; value?: string; text?: string };
function nodes(value: unknown, type: string): TestNode[] {
  const tree = value as TestNode;
  return [...(tree.type === type ? [tree] : []), ...(tree.children ?? tree.content ?? []).flatMap(node => nodes(node, type))];
}

test('mixed math delimiters render and preserve their markers through Markdown save/reopen', () => {
  const source = 'Inline $x$ and \\(y\\) and @@z@@.\n\n\\[\na_b + \\frac{1}{2}\n\\]\n\n%%q%%\n\n$$\nr\n$$';
  const json = manager.parse(source);
  assert.equal(nodes(json, 'inlineMath').length, 3);
  assert.equal(nodes(json, 'blockMath').length, 3);
  const saved = manager.serialize(json);
  assert.match(saved, /\\\(y\\\)/);
  assert.match(saved, /@@z@@/);
  assert.match(saved, /\\\[\na_b/);
  assert.deepEqual(manager.parse(saved), json);
  const tree = renderTree(source);
  assert.equal(nodes(tree, 'inlineMath').length, 3);
  assert.equal(nodes(tree, 'math').length, 3);
  assert.equal(nodes(tree, 'math')[0].value, 'a_b + \\frac{1}{2}');
});

test('math parsing leaves code, escapes, unmatched delimiters and links intact', () => {
  const source = '`\\(code\\)` and \\$5 and [link](https://example.com) and \\(unclosed\n\n```tex\n\\[code\\]\n```\n\n    $$code$$';
  for (const tree of [manager.parse(source), renderTree(source)]) {
    assert.equal(nodes(tree, 'inlineMath').length, 0);
    assert.equal(nodes(tree, 'blockMath').length + nodes(tree, 'math').length, 0);
  }
});

test('math works in lists, blockquotes and tables', () => {
  const source = '- \\(a\\)\n\n> \\[\n> b\n> \\]\n\n| Formula |\n| --- |\n| @@c@@ |';
  assert.equal(nodes(manager.parse(source), 'inlineMath').length, 2);
  assert.equal(nodes(renderTree(source), 'inlineMath').length, 2);
  assert.equal(nodes(renderTree(source), 'math').length, 1);
});

test('text continuing a tight list item after display math stays in a paragraph', () => {
  // An AI Chat reply: pasting it threw "Invalid content for node listItem".
  const source = '- Pairs scale as:\n  \\[\n  P \\sim \\varepsilon^2\n  \\]\n  Similarly, triples scale as $\\varepsilon^3$.\n- Next';
  const [InlineMath, BlockMath] = createMathExtensions(settings);
  const editor = new Editor({ extensions: [...createMarkdownExtensions(''), InlineMath, BlockMath], content: 'x', contentType: 'markdown' });
  try {
    for (const json of [manager.parse(source), editor.markdown!.parse(source)]) {
      const item = nodes(json, 'listItem')[0];
      assert.deepEqual(item.content!.map(node => node.type), ['paragraph', 'blockMath', 'paragraph']);
      assert.deepEqual(item.content![2].content!.map(node => node.type), ['text', 'inlineMath', 'text']);
      editor.schema.nodeFromJSON(json).check();
    }
    assert.equal(editor.commands.insertContentAt(editor.state.doc.content.size, editor.markdown!.parse(source).content!), true);
  } finally {
    editor.destroy();
  }
});

test('preferences survive JSON storage, reject invalid markers and allow disabling math', () => {
  assert.deepEqual(normalizeMarkdownPreferences(JSON.parse(JSON.stringify(settings))).inlineMathMarkers, settings.inlineMathMarkers);
  assert.throws(() => normalizeMarkdownPreferences({ inlineMathMarkers: 'one' }));
  const disabled = { inlineMathMarkers: '', blockMathMarkers: '' };
  const tree = unified().use(remarkParse).use(remarkMathMarkers, disabled).parse('$x$\n\n$$y$$');
  assert.equal(nodes(tree, 'inlineMath').length + nodes(tree, 'math').length, 0);
});

test('defaults recognize double dollars as inline math in both editors', () => {
  const prefs = normalizeMarkdownPreferences();
  const source = 'Before $$x^2$$ after.\n\n\\[\ny\n\\]';
  const visual = new MarkdownManager({ extensions: [...createMarkdownExtensions(''), ...createMathExtensions(prefs)] });
  const tree = unified().use(remarkParse).use(remarkMathMarkers, prefs).parse(source);
  assert.equal(nodes(visual.parse(source), 'inlineMath')[0].attrs.latex, 'x^2');
  assert.equal(nodes(tree, 'inlineMath')[0].value, 'x^2');
  assert.equal(nodes(tree, 'math').length, 1);
  assert.match(visual.serialize(visual.parse(source)), /Before \$\$x\^2\$\$ after/);
});

test('display math allows blank lines and leaves an unmatched opener as text', () => {
  assert.equal(nodes(renderTree('\\[\na\n\nb\n\\]'), 'math')[0].value, 'a\n\nb');
  assert.equal(nodes(renderTree('\\[\nunclosed\n\ntext'), 'math').length, 0);
});

test('display math accepts trailing whitespace but not trailing prose', () => {
  assert.equal(nodes(renderTree('\\[x\\]  \n\ntext'), 'math')[0].value, 'x');
  assert.equal(nodes(renderTree('\\[x\\]\t\r\n\r\ntext'), 'math')[0].value, 'x');
  assert.equal(nodes(renderTree('\\[x\\] trailing prose'), 'math').length, 0);
});

test('indented display math parses in the visual editor as it does in the preview', () => {
  // An AI Chat reply pasted as Markdown: the visual editor took `\[` with leading
  // spaces for a paragraph, so `\[` `\;` lost their backslashes and `_…_` italicised.
  const prefs = normalizeMarkdownPreferences();
  const visual = new MarkdownManager({ extensions: [...createMarkdownExtensions(''), ...createMathExtensions(prefs)] });
  const formula = String.raw`\Delta R_r(z) = \underbrace{\sum_{f \in \mathcal{V}_r(z)} \xi_f}_{\text{+1 entrants}} \;-\; \underbrace{\sum_{f \in \mathcal{W}_r(z)} \xi_f}_{\text{-1 exiters}}.`;
  const indented = (indent: string, opener = indent) => `${opener}\\[\n${indent}${formula}\n${indent}\\]`;
  const cases: [string, string][] = [
    ['flush, straight after a paragraph line', `Variables:\n${indented('')}\nwhere`],
    ['three spaces', `Variables:\n\n${indented('   ')}\n\nwhere`],
    ['two spaces, straight after a paragraph line', `Variables:\n${indented('  ')}\nwhere`],
    ['only the opener indented', `Variables:\n\n${indented('', '  ')}\n\nwhere`],
    ['over-indented under a bullet', `- Variables:\n    \\[\n    ${formula}\n    \\]\n- Next`],
    ['under a number', `1. Variables:\n   \\[\n   ${formula}\n   \\]\n2. Next`],
    ['over-indented under a number', `1. Variables:\n     \\[\n     ${formula}\n     \\]\n2. Next`],
    ['three spaces over-indented under a number', `1. Variables:\n      \\[\n      ${formula}\n      \\]\n2. Next`],
    ['nested under a number', `1. Outer\n   1. Variables:\n      \\[\n      ${formula}\n      \\]`],
    ['under a task', `- [ ] Variables:\n  \\[\n  ${formula}\n  \\]\n- [ ] Next`],
    ['under-indented under a bullet', `- Variables:\n \\[\n ${formula}\n \\]\n- Next`],
    ['indented in a blockquote', `>   \\[\n>   ${formula}\n>   \\]`],
    ['CRLF line endings', `Variables:\r\n\r\n  \\[\r\n  ${formula}\r\n  \\]\r\n`],
  ];
  for (const [label, source] of cases) {
    const preview = unified().use(remarkParse).use(remarkGfm).use(remarkMathMarkers, prefs).parse(source);
    assert.equal(nodes(preview, 'math').length, 1, `preview: ${label}`);
    const json = visual.parse(source);
    const blocks = nodes(json, 'blockMath');
    assert.equal(blocks.length, 1, `visual editor: ${label}`);
    assert.equal(blocks[0].attrs.latex, formula, `latex without indentation: ${label}`);
    assert.equal(nodes(json, 'text').some(node => node.marks?.some(mark => mark.type === 'italic')), false, label);
    assert.deepEqual(visual.parse(visual.serialize(json)), json, `save/reopen: ${label}`);
  }
  // Indentation stays in multi-line bodies only beyond the opener's own.
  assert.equal(nodes(visual.parse('  \\[\n  a \\\\\n    b\n  \\]'), 'blockMath')[0].attrs.latex, 'a \\\\\n  b');
  // Four spaces is an indented code block in both editors.
  const code = 'Text\n\n    \\[\n    x\n    \\]';
  assert.equal(nodes(visual.parse(code), 'blockMath').length, 0);
  assert.equal(nodes(visual.parse(code), 'codeBlock').length, 1);
  assert.equal(nodes(unified().use(remarkParse).use(remarkMathMarkers, prefs).parse(code), 'math').length, 0);
});

test('typing and rich HTML paste recognize custom markers without changing code', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.assign(globalThis, { window: dom.window, ClipboardEvent: dom.window.Event, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle });
  const editor = new Editor({ extensions: [...createMarkdownExtensions(''), ...createMathExtensions()], content: '<p></p>' });
  try {
    const type = (text: string) => {
      for (const char of text) {
        const { from, to } = editor.state.selection;
        const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
      }
    };
    type('$$x$$');
    assert.equal(nodes(editor.getJSON(), 'inlineMath')[0].attrs.mathOpen, '$$');
    editor.commands.setContent('<p></p>');
    type('\\[y\\]');
    assert.equal(nodes(editor.getJSON(), 'blockMath')[0].attrs.mathOpen, '\\[');
    editor.commands.setContent('<p></p>');
    editor.view.pasteHTML('<p><strong>Before</strong> \\(x\\) and <code>\\(code\\)</code></p>');
    assert.equal(nodes(editor.getJSON(), 'inlineMath').length, 1);
    assert.equal(nodes(editor.getJSON(), 'text').find(node => node.text === 'Before')!.marks[0].type, 'bold');
    editor.commands.setContent('<p></p>');
    editor.view.pasteHTML('<p>\\[<br>y<br>\\]</p>');
    assert.equal(nodes(editor.getJSON(), 'blockMath').length, 1);
    editor.commands.setContent('<p></p>');
    editor.view.pasteHTML('<p>&nbsp;&nbsp;\\[<br>y<br>\\]</p>');
    assert.equal(nodes(editor.getJSON(), 'blockMath')[0]?.attrs.latex, 'y');
  } finally { editor.destroy(); dom.window.close(); }
});


test('Source Editor renderer produces inline and display KaTeX with configured markers', () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, {
    content: 'Before @@x^2@@ after.\n\n%%\ny^2\n%%', mathMarkers: settings,
  }));
  const dom = new JSDOM(html);
  try {
    assert.equal(dom.window.document.querySelectorAll('.katex').length, 2);
    assert.equal(dom.window.document.querySelectorAll('.katex-display').length, 1);
    assert.equal(dom.window.document.querySelectorAll('.katex-error').length, 0);
  } finally { dom.window.close(); }
});
