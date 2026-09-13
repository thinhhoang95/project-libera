const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { normalizeMathMarkers, DEFAULT_INLINE_MATH_MARKERS, DEFAULT_BLOCK_MATH_MARKERS } = require('../../electron/math-markers.cjs');

test('Markdown marker textareas load defaults, save and reload persisted settings', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'libera-markers-'));
  const configPath = path.join(dir, 'config.json');
  let state = { dataDir: '/tmp/notebooks', hasApiKey: true, hasPasswordHash: true };
  const open = () => new JSDOM(readFileSync(path.join(__dirname, '../../electron/setup.html'), 'utf8'), {
    url: 'http://localhost/?mode=configuration', runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => state,
        save: async input => writeFileSync(configPath, JSON.stringify({ ...state,
          markdownInlineMathMarkers: normalizeMathMarkers(input.markdownInlineMathMarkers, DEFAULT_INLINE_MATH_MARKERS),
          markdownBlockMathMarkers: normalizeMathMarkers(input.markdownBlockMathMarkers, DEFAULT_BLOCK_MATH_MARKERS),
        })),
      };
    },
  });
  let dom = open();
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const inline = dom.window.document.querySelector('#markdown-inline-math-markers');
    assert.equal(inline.value, DEFAULT_INLINE_MATH_MARKERS);
    assert.equal(inline.closest('[data-section]').dataset.section, 'markdown');
    inline.value = '@@ @@\n\\( \\)';
    dom.window.document.querySelector('#markdown-block-math-markers').value = '%% %%';
    dom.window.document.querySelector('#setup-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.window.close();
    state = JSON.parse(readFileSync(configPath, 'utf8'));
    dom = open();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('#markdown-inline-math-markers').value, '@@ @@\n\\( \\)');
    assert.equal(dom.window.document.querySelector('#markdown-block-math-markers').value, '%% %%');
  } finally { dom.window.close(); rmSync(dir, { recursive: true }); }
});
