import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTextMatches, replaceTextMatches } from '../../src/lib/text-find';

function previousMatcher(value: string, query: string) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = '';
  for (let i = 0; i < query.length; i++) {
    const char = query[i], next = query[i + 1];
    if (char === '\\' && next && ['*', '?', '\\'].includes(next)) { pattern += escape(next); i++; }
    else if (char === '*') { pattern += '[^\\r\\n]*'; while (query[i + 1] === '*') i++; }
    else if (char === '?') pattern += '[^\\r\\n]';
    else pattern += escape(char);
  }
  return Array.from(value.matchAll(new RegExp(pattern, 'giu')), m => ({ start: m.index, end: m.index + m[0].length })).filter(m => m.end > m.start);
}

test('bounded wildcard matcher preserves greedy, escaped, Unicode and multiline results', () => {
  const values = ['', 'abABab', 'a\nb\r\na', '🙂a🙂\nB', 'ſKKs', '*a?\\b', 'İiıI'];
  const queries = ['*', '?', '*a*', 'a*b', '?*?', '*a?b*', 'a\nb', '\\*', '\\?', '\\\\', '🙂*', 's', 'k', 'i', '*\\**'];
  let seed = 41;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = ['a', 'b', 'A', '\n', '🙂', '*', '?', '\\'];
  for (let i = 0; i < 250; i++) {
    values.push(Array.from({ length: 8 }, () => alphabet[random(alphabet.length)]).join(''));
    queries.push(Array.from({ length: 4 }, () => alphabet[random(alphabet.length)]).join(''));
  }
  values.forEach((value, i) => {
    for (const query of [...queries.slice(0, 15), queries[i % queries.length]]) {
      assert.deepEqual(findTextMatches(value, query, { wildcards: true }), previousMatcher(value, query), JSON.stringify({ value, query }));
    }
  });
});

test('adversarial wildcard completes without exponential backtracking', { timeout: 2000 }, () => {
  assert.deepEqual(findTextMatches('a'.repeat(20_000), '*a*a*a*a*a*a*a*a*b', { wildcards: true }), []);
});

test('replace all preserves literal replacement text and Unicode source offsets', () => {
  const text = '🙂a🙂a';
  const matches = findTextMatches(text, '🙂?', { wildcards: true });
  assert.deepEqual(matches, [{ start: 0, end: 3 }, { start: 3, end: 6 }]);
  assert.equal(replaceTextMatches(text, matches, '$&'), '$&$&');
});
