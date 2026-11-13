import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
let position: typeof import('../../src/lib/textarea-position');

before(async () => { position = await import('../../src/lib/textarea-position'); });

const mirrors = () => document.querySelectorAll('body > div[aria-hidden="true"]');

function textarea(value: string) {
  const element = document.createElement('textarea');
  element.value = value;
  document.body.appendChild(element);
  return element;
}

test('releasing the measurements empties the mirror and the next measurement rebuilds it', () => {
  const area = textarea('hello world\nsecond line');
  position.getTextareaOffsetAtPoint(area, 0, 0);
  assert.equal(mirrors().length, 1);
  const mirror = mirrors()[0];
  assert.equal(mirror.textContent, 'hello world\nsecond line​');

  position.releaseTextareaMeasurements();
  assert.equal(mirror.textContent, '');
  assert.equal(mirrors().length, 1);

  // Same value as before the release: it must still be re-synced.
  position.getTextareaOffsetAtPoint(area, 0, 0);
  assert.equal(mirrors().length, 1);
  assert.equal(mirrors()[0], mirror);
  assert.equal(mirror.textContent, 'hello world\nsecond line​');
  area.remove();
});

test('releasing is safe before any measurement, twice in a row, and with an empty value', () => {
  position.releaseTextareaMeasurements();
  position.releaseTextareaMeasurements();
  const empty = textarea('');
  assert.equal(position.getTextareaOffsetAtPoint(empty, 0, 0), 0);
  const mirror = mirrors()[0];
  assert.equal(mirror.textContent, '​');
  position.releaseTextareaMeasurements();
  assert.equal(mirror.textContent, '');
  assert.equal(position.getTextareaOffsetAtPoint(empty, 0, 0), 0);
  assert.equal(mirror.textContent, '​');
  assert.equal(mirror.firstChild?.nodeType, 3);
  assert.equal(mirrors().length, 1);
  empty.remove();
});

test('another textarea measures correctly after a release', () => {
  const first = textarea('abc');
  position.getTextareaOffsetAtPoint(first, 0, 0);
  position.releaseTextareaMeasurements();
  const second = textarea('other text');
  position.getTextareaClientPointForOffset(second, 3);
  assert.equal(mirrors()[0].textContent, 'other text​');
  assert.equal(mirrors().length, 1);
  first.remove();
  second.remove();
});
