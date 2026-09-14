// Run from the repository root: node docs/audits/editor-efficiency-benchmark.cjs
// Synthetic inputs only. Measures CPU work, not battery power or browser layout.
require('tsx/cjs');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const { prepareMarkdownPreview, createMarkdownPreviewPatch } = require('../../src/lib/markdown-preview.ts');
const { markdownHeadingOffsets, newReview, syncReview, anchorAt } = require('../../src/lib/markdown-review.ts');
const { getMarkdownWordCountStats } = require('../../src/lib/markdown-word-count.ts');

function measure(name, fn, samples = 5) {
  fn();
  const wall = [], cpu = [];
  for (let i = 0; i < samples; i++) {
    const startCpu = process.cpuUsage(), start = performance.now();
    fn();
    wall.push(performance.now() - start);
    const used = process.cpuUsage(startCpu);
    cpu.push((used.user + used.system) / 1000);
  }
  wall.sort((a, b) => a - b); cpu.sort((a, b) => a - b);
  return { name, samples, medianWallMs: +wall[Math.floor(samples / 2)].toFixed(2), medianProcessCpuMs: +cpu[Math.floor(samples / 2)].toFixed(2) };
}
function documentText(sections, math = false) {
  return Array.from({ length: sections }, (_, i) => `## Section ${i}\n\nParagraph ${i} with **bold** words and a [link](other.md). More regular text.\n\n${math ? '$$\n\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}\n$$\n\n' : ''}`).join('');
}
async function wildcardProbe() {
  const entry = require.resolve('../../src/lib/text-find.ts');
  const registration = require.resolve('tsx/cjs');
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      require(workerData.registration);
      const { findTextMatches } = require(workerData.entry);
      parentPort.postMessage('ready');
      parentPort.on('message', () => {
        const start = performance.now();
        const result = findTextMatches('a'.repeat(80), '*a*a*a*a*a*a*a*a*b', { wildcards: true });
        parentPort.postMessage({ matches: result.length, elapsedMs: performance.now() - start });
      });
    `, { eval: true, workerData: { entry, registration } });
    let timer;
    worker.on('error', (error) => { clearTimeout(timer); reject(error); });
    worker.on('message', (message) => {
      if (message === 'ready') {
        timer = setTimeout(() => {
          void worker.terminate();
          resolve({ query: '*a*a*a*a*a*a*a*a*b', inputCharacters: 80, exceededWallBudgetMs: 500, terminated: true });
        }, 500);
        worker.postMessage('run');
      } else { clearTimeout(timer); void worker.terminate(); resolve(message); }
    });
  });
}
async function main() {
  const output = { node: process.version, architecture: process.arch, fixtures: [], measurements: [] };
  for (const [sections, math] of [[100, false], [500, false], [100, true]]) {
    const text = documentText(sections, math), label = `${sections} sections${math ? ' with math' : ''}`;
    output.fixtures.push({ label, bytes: Buffer.byteLength(text) });
    output.measurements.push(measure(`${label}: complete preview parse + KaTeX + patch signatures`, () => createMarkdownPreviewPatch(prepareMarkdownPreview(text), [])));
    output.measurements.push(measure(`${label}: heading worker parser`, () => markdownHeadingOffsets(text)));
    output.measurements.push(measure(`${label}: word count`, () => getMarkdownWordCountStats(text)));
    const baseline = createMarkdownPreviewPatch(prepareMarkdownPreview(text), []);
    for (const [position, changed] of [['start', text.replace('Section 0', 'Section 0x')], ['end', text.trimEnd() + 'x\n\n']]) {
      const tree = prepareMarkdownPreview(changed);
      const patch = createMarkdownPreviewPatch(tree, baseline.signatures);
      output.measurements.push({ name: `${label}: one character at ${position}`, totalBlocks: patch.children.length, reusedBlocks: patch.children.filter((n) => typeof n === 'number').length,
        elementBlocks: tree.children.filter((n) => n.type === 'element').length,
        replacedElementBlocks: patch.children.filter((n) => typeof n !== 'number' && n.type === 'element').length });
    }
  }
  const source = documentText(100);
  for (const count of [1, 10]) {
    const doc = newReview('synthetic', source, 'synthetic');
    doc.enabled = false;
    doc.threads = Array.from({ length: count }, (_, i) => ({ id: `thread-${i}`, status: 'resolved', messages: [], anchor: { ...anchorAt('Deleted paragraph.', { start: 0, end: 18 }), state: 'orphaned' } }));
    output.measurements.push(measure(`disabled review, ${count} resolved orphaned comments: sync after append`, () => syncReview(doc, source + 'x'), 3));
  }
  output.wildcardProbe = await wildcardProbe();
  console.log(JSON.stringify(output, null, 2));
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
