import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { findMarkdownSourceElementForOffset, getMarkdownSourceRange, MARKDOWN_SOURCE_BLOCK_SELECTOR } from '../../src/lib/markdown-source-map';

test('indexed source lookup matches nearest/deepest semantics and invalidates immediately', () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
  const root = dom.window.document.getElementById('root')!;
  let seed = 23;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let i = 0; i < 300; i++) {
    const node = dom.window.document.createElement('p'), start = random(500);
    node.dataset.sourceStart = String(start); node.dataset.sourceEnd = String(start + random(100)); node.dataset.sourceBlock = 'true';
    root.append(node);
  }
  function scan(offset: number) {
    let best: HTMLElement | null = null, span = Infinity, nearest: HTMLElement | null = null, distance = Infinity;
    for (const element of root.querySelectorAll<HTMLElement>(MARKDOWN_SOURCE_BLOCK_SELECTOR)) {
      const range = getMarkdownSourceRange(element)!;
      if (offset >= range.start && offset <= range.end) { if (range.end - range.start < span) { best = element; span = range.end - range.start; } }
      else { const d = offset < range.start ? range.start - offset : offset - range.end; if (d < distance) { distance = d; nearest = element; } }
    }
    return best ?? nearest;
  }
  try {
    for (let round = 0; round < 3; round++) {
      for (let offset = -5; offset < 610; offset++) assert.equal(findMarkdownSourceElementForOffset(root, offset), scan(offset));
      root.firstElementChild!.remove();
      const changed = root.lastElementChild as HTMLElement;
      changed.dataset.sourceStart = '0'; changed.dataset.sourceEnd = '700';
    }
    root.replaceChildren();
    assert.equal(findMarkdownSourceElementForOffset(root, 10), null);
  } finally { dom.window.close(); }
});
