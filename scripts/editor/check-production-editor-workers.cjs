// Run after npm run build. Execute the actual Turbopack worker bootstrap and
// browser dependency graph without a document/window, not Node source imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const directory = path.resolve('.next');
const chunkDirectory = path.join(directory, 'static/chunks');
const bootstraps = new Map();
for (const name of fs.readdirSync(chunkDirectory)) {
  if (name.startsWith('._') || !name.endsWith('.js')) continue;
  const code = fs.readFileSync(path.join(chunkDirectory, name), 'utf8');
  for (const match of code.matchAll(/"(static\/chunks\/turbopack-worker[^" ]+)",(\[[^\]]+\])/g)) {
    bootstraps.set(match[2], { entry: match[1], chunks: JSON.parse(match[2]) });
  }
}
assert.equal(bootstraps.size, 2, 'Expected preview and heading worker bootstraps');
async function main() {
for (const { entry, chunks } of bootstraps.values()) {
  const replies = [];
  class WorkerGlobalScope {
    static [Symbol.hasInstance](value) { return value?.WorkerGlobalScope === WorkerGlobalScope; }
  }
  const scope = new WorkerGlobalScope();
  Object.assign(scope, { WorkerGlobalScope, console, URL, setTimeout, clearTimeout, structuredClone, TextEncoder, TextDecoder,
    location: new URL(`http://localhost/_next/${entry}#params=${encodeURIComponent(JSON.stringify([chunks.map(chunk => '/_next/' + chunk), '', '', '']))}`),
    postMessage(data) { replies.push(JSON.parse(JSON.stringify(data))); },
  });
  scope.self = scope;
  const context = vm.createContext(scope);
  scope.importScripts = (...urls) => {
    for (const url of urls) {
      const relative = new URL(url, scope.location).pathname.replace(/^\/_next\//, '');
      const file = path.resolve(directory, relative);
      assert.ok(file.startsWith(directory + path.sep));
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file, timeout: 10000 });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(directory, entry), 'utf8'), context, { timeout: 10000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof scope.onmessage, 'function');
  const markdown = '# First &amp; title\n\n> ## Nested\n\nSetext\n------\n\n```md\n# Hidden\n```\n\n$$\nx^2\n$$\n\n## Last';
  scope.onmessage({ data: { id: 1, markdown } });
  assert.equal(replies[0].error, undefined);
  if (replies[0].offsets) {
    assert.deepEqual(replies[0].offsets, [0, markdown.indexOf('## Nested'), markdown.indexOf('Setext'), markdown.indexOf('## Last')]);
    console.log('PASS: production heading worker parses nested, setext, fenced and math content without a DOM.');
  } else {
    assert.ok(JSON.stringify(replies[0].children).includes('"katex"'));
    scope.onmessage({ data: { id: 2, markdown } });
    assert.ok(replies[1].children.every((node, index) => node === index));
    assert.deepEqual(replies[1].sources, replies[0].sources);
    scope.onmessage({ data: { id: 3, markdown: markdown.replace('First', 'Longer first') } });
    assert.equal(replies[2].children.filter(node => typeof node !== 'number').length, 1);
    assert.ok(replies[2].sources.some((source, index) => source.start !== replies[1].sources[index].start));
    console.log('PASS: production preview worker renders KaTeX, reuses content, and updates source offsets without a DOM.');
  }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
