import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { lazyDocText, sourceCitationContext, sourceFileLinkContext, type SourceTextAccess } from "../../src/lib/markdown-source";
import { autoCompileDelayMs } from "../../src/components/libera/latex/latex-auto-compile-delay";

// sourcePopupPosition reads the window size.
Object.assign(globalThis, { window: { innerWidth: 1200, innerHeight: 900 } });
const point = () => ({ x: 10, y: 20 });

const FRAGMENTS = [
  "plain prose here ", "a longer sentence about nothing in particular, with commas. ", "\n", "\n\n", "# Heading one\n", "## Second heading\n",
  "[label](", "[label](docs/note.md)", "[a](#", "[a](<", "](", "[", ")", "(", "see [x](notes/a b.md) and more ", "@", "@smith2020", " [@smith2020; @lee19", "[@",
  "[see @doe21, p. 3]", "$x @ y$", "$$\n@a\n$$", "`code @a`", "```\n@fence\n```\n", "mail me@example.com ", "😀", "é", " ", "@ünï", "- list item\n",
];

function randomDoc(rng: () => number) {
  let text = "";
  const parts = 1 + Math.floor(rng() * 14);
  for (let i = 0; i < parts; i++) text += FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)];
  if (rng() < 0.15) text += "x".repeat(300 + Math.floor(rng() * 600));
  if (rng() < 0.15) text = "y".repeat(Math.floor(rng() * 600)) + "[l](" + text;
  return text;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spy(text: string) {
  const doc = Text.of(text.split("\n"));
  const counts = { read: 0, slices: 0, sliced: 0 };
  const lazy = lazyDocText(doc);
  const source: SourceTextAccess = {
    slice(from, to) { counts.slices++; counts.sliced += Math.max(0, to - from); return (lazy as { slice(a: number, b: number): string }).slice(from, to); },
    read() { counts.read++; return doc.toString(); },
  };
  return { source, counts };
}

test("the lazy text source gives the same popups as the string for random documents and carets", () => {
  const rng = mulberry32(20261117);
  let linkHits = 0;
  let citationHits = 0;
  for (let round = 0; round < 400; round++) {
    const text = randomDoc(rng);
    const carets = new Set<number>([0, text.length]);
    for (let i = 0; i < 40; i++) carets.add(Math.floor(rng() * (text.length + 1)));
    // Carets right after interesting characters.
    for (let i = 0; i < text.length; i++) if ((text[i] === "(" || text[i] === "@" || text[i] === "#") && rng() < 0.7) carets.add(i + 1);
    for (const caret of carets) {
      const { source } = spy(text);
      const viaString = sourceFileLinkContext(text, caret, caret, null, point);
      const viaLazy = sourceFileLinkContext(source, caret, caret, null, point);
      assert.deepEqual(viaLazy, viaString, `file link at ${caret} in ${JSON.stringify(text)}`);
      if (viaString) linkHits++;
      const previousLink = viaString;
      assert.deepEqual(sourceFileLinkContext(source, caret, caret, previousLink, point), sourceFileLinkContext(text, caret, caret, previousLink, point));

      for (const fileLinkOpen of [false, true]) {
        const options = { fileLinkOpen, previous: null, inserted: null, point };
        const a = sourceCitationContext(text, caret, caret, options);
        const b = sourceCitationContext(source, caret, caret, options);
        assert.deepEqual(b, a, `citation at ${caret} in ${JSON.stringify(text)}`);
        if (a.popup) citationHits++;
      }
      // A selection (not a caret) never opens either popup.
      const range = Math.min(text.length, caret + 3);
      assert.deepEqual(sourceCitationContext(source, caret, range, { fileLinkOpen: false, previous: null, inserted: null, point }),
        sourceCitationContext(text, caret, range, { fileLinkOpen: false, previous: null, inserted: null, point }));
    }
  }
  assert.ok(linkHits > 50, `only ${linkHits} link popups were exercised`);
  assert.ok(citationHits > 50, `only ${citationHits} citation popups were exercised`);
});

test("typing plain prose never materializes the whole document", () => {
  const prose = "The quick brown fox jumps over the lazy dog (twice), then rests.\n".repeat(2000);
  const { source, counts } = spy(prose);
  for (let caret = prose.length - 40; caret <= prose.length; caret++) {
    sourceFileLinkContext(source, caret, caret, null, point);
    sourceCitationContext(source, caret, caret, { fileLinkOpen: false, previous: null, inserted: null, point });
  }
  assert.equal(counts.read, 0);
  assert.ok(counts.sliced < 41 * 4 * 600, `windows should stay small, read ${counts.sliced} characters`);
});

test("the whole document is read only when a popup opens", () => {
  const text = "intro line\nwith a [link](#he";
  const link = spy(text);
  assert.ok(sourceFileLinkContext(link.source, text.length, text.length, null, point)?.headings);
  assert.equal(link.counts.read, 1);
  const plainLink = spy("a [link](notes/a");
  assert.ok(sourceFileLinkContext(plainLink.source, 16, 16, null, point));
  assert.equal(plainLink.counts.read, 0);

  const cited = spy("some words [@smi");
  const result = sourceCitationContext(cited.source, 16, 16, { fileLinkOpen: false, previous: null, inserted: null, point });
  assert.ok(result.popup);
  assert.equal(cited.counts.read, 1);
});

test("auto-compile delay: plugged in, on battery, hidden PDF and clamping", () => {
  const plugged = { onBattery: false, pdfHidden: false };
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: null }), 1200);
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: 300 }), 1200);
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: 2000 }), 3000);
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: 60000 }), 8000);
  assert.equal(autoCompileDelayMs({ onBattery: true, pdfHidden: false, lastCompileMs: null }), 4000);
  assert.equal(autoCompileDelayMs({ onBattery: true, pdfHidden: false, lastCompileMs: 1000 }), 4000);
  assert.equal(autoCompileDelayMs({ onBattery: true, pdfHidden: false, lastCompileMs: 5000 }), 10000);
  assert.equal(autoCompileDelayMs({ onBattery: true, pdfHidden: false, lastCompileMs: 90000 }), 15000);
  assert.equal(autoCompileDelayMs({ onBattery: false, pdfHidden: true, lastCompileMs: 3000 }), 6000);
  assert.equal(autoCompileDelayMs({ onBattery: false, pdfHidden: true, lastCompileMs: null }), 4000);
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: Number.NaN }), 1200);
  assert.equal(autoCompileDelayMs({ ...plugged, lastCompileMs: -5 }), 1200);
});
