import assert from "node:assert/strict";
import { test } from "node:test";
import { createMathExtensions, matchBlockMath } from "../../src/lib/tiptap-math";
import { mathMarkerPairs, matchMath, type MathMarkerSettings } from "../../src/lib/math-markers";

type Start = (source: string) => number;

function newStart(settings?: MathMarkerSettings, display = true) {
  const extension = createMathExtensions(settings)[display ? 1 : 0] as unknown as { config: { markdownTokenizer: { start: Start } } };
  return extension.config.markdownTokenizer.start;
}

// The per-character loop the display hook used before it visited line starts only.
function referenceStart(source: string, settings: MathMarkerSettings | undefined, display: boolean) {
  const pairs = mathMarkerPairs(settings);
  for (let i = 0; i < source.length; i++) {
    if (display && i > 0 && source[i - 1] !== "\n") continue;
    if (display ? matchBlockMath(source.slice(i), pairs) : matchMath(source.slice(i), pairs, false)) return i;
  }
  return -1;
}

const display = "$$\nx^2\n$$";
const sources = [
  "",
  "no math here\nat all\n",
  "plain\n\n" + display + "\n\nafter",
  display,
  display + "\n",
  "text\n\\[\ny\n\\]\nmore",
  "\\[\ny\n\\]",
  ...[0, 1, 2, 3, 4].map(n => `para\n\n${" ".repeat(n)}$$\n${" ".repeat(n)}x\n${" ".repeat(n)}$$\n`),
  ...[0, 1, 2, 3, 4].map(n => `para\n${" ".repeat(n)}\\[\nx\n\\]\n`),
  "para\r\n\r\n$$\r\nx\r\n$$\r\n\r\nafter",
  "para\r\n$$\r\nx\r\n$$",
  "para \\$$\nx\n$$\n",
  "\\$$\nx\n$$\n",
  "para\n$$\nnever closed\nmore text\n",
  "para\n\\[\nnever closed",
  "inline $$ x $$ mid-line\nnext line\n",
  "text $$\nx\n$$\n",
  "text \\[\nx\n\\]\n",
  "para\n$$ x $$\n",
  "para\n$$\n\n$$\n",
  "a\n$x$ inline only\n$$\nx\n$$ trailing\n",
  "a\n$$\nx\n$$\n$$\ny\n$$\n",
  "line one\nline two\n$$\nx\n$$",
  "ends with newline\n",
  "\n\n\n",
];

const customSettings: MathMarkerSettings[] = [
  {},
  { blockMathMarkers: "$$ $$" },
  { inlineMathMarkers: "$ $\n\\( \\)", blockMathMarkers: "\\[ \\]\n[[ ]]\n$$ $$" },
  { blockMathMarkers: "@@ @@" },
  { inlineMathMarkers: "", blockMathMarkers: "" },
];

const customSources = [
  ...sources,
  "para\n@@\nx\n@@\n",
  "para\n  [[\nx\n]]\n",
  "para\n\\[\nx\n\\]\n[[\ny\n]]\n",
  "para\n@@ x @@\n",
];

test("display start matches the per-character reference over many sources and settings", () => {
  for (const settings of customSettings) {
    const start = newStart(settings);
    for (const source of customSources) {
      assert.equal(start(source), referenceStart(source, settings, true), `${JSON.stringify(settings)} ${JSON.stringify(source)}`);
    }
  }
});

test("display start finds math at the expected offsets", () => {
  const start = newStart();
  assert.equal(start("\\[\nx\n\\]"), 0);
  assert.equal(start("para\n\n  \\[\nx\n\\]\n"), 6);
  assert.equal(start("para\n\n    \\[\nx\n\\]\n"), -1);
  assert.equal(start("text \\[\nx\n\\]\n"), -1);
  assert.equal(start("no math\n"), -1);
  const dollars = newStart({ blockMathMarkers: "@@ @@" });
  assert.equal(dollars("para\n@@\nx\n@@\n"), 5);
  assert.equal(start("para\n$$\nx\n$$\n"), -1);
});

test("inline start is unchanged", () => {
  const start = newStart(undefined, false);
  for (const source of sources) assert.equal(start(source), referenceStart(source, undefined, false), JSON.stringify(source));
});
