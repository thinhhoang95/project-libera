import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMarkdownEditorLineIndex, getMarkdownEditorLineHighlight, initialMarkdownEditorHighlightState } from '../../src/lib/markdown-editor-highlighting';

test('line index retains suffix identities and propagates changed fences until convergence', () => {
  const index = createMarkdownEditorLineIndex();
  const original = index.update('## Heading\nParagraph\n```\n## Code\n```\n## Last');
  const inserted = index.update('New\n## Heading\nParagraph\n```\n## Code\n```\n## Last');
  original.forEach((line, i) => assert.equal(inserted[i + 1], line));
  const changed = index.update('New\n## Heading\nParagraph\ntext\n## Code\n```\n## Last');
  assert.equal(changed[4].tone, 'heading-2');
  assert.equal(changed[6].tone, undefined);
  assert.equal(index.update(changed.map(line => line.text).join('\n')), changed);
});

test('incremental highlighting agrees with full highlighting through randomized edits', () => {
  const index = createMarkdownEditorLineIndex();
  let source = '# A\n\n```js\n## hidden\n```\n> Quote\n    code\n~~~~\nfence\n~~~~\nLast';
  let seed = 71;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const inserts = ['\n', '```', '~~~~', '# ', '> ', 'text', '', '    '];
  for (let i = 0; i < 200; i++) {
    const start = random(source.length + 1), end = Math.min(source.length, start + random(8));
    source = source.slice(0, start) + inserts[random(inserts.length)] + source.slice(end);
    let state = initialMarkdownEditorHighlightState();
    const full = source.split('\n').map(text => { const line = { text, ...getMarkdownEditorLineHighlight(text, state) }; state = line.nextState; return line; });
    assert.deepEqual(index.update(source), full);
  }
});
