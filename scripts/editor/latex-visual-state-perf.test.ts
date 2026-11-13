import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { EditorState } from "@codemirror/state";
import { bodyStartOf, collectLatexDefinitions, definitionsFingerprint, readLatexDefinitions, type LatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { disabledRegions, discardingMacros, macroEnvironmentRegions, outermostRegions, withoutContained } from "../../src/lib/latex/macros/structure";
import { definitionsField, disabledField, heldMacroRegions, macroRegionsFor, visualStateFields } from "../../src/lib/latex/codemirror/visual/model";

/* Shared Visual state: the definitions object stays when an edit cannot change it, and what is cached by it with it. */

const PREAMBLE = "\\documentclass{article}\n\\newcommand{\\foo}{x}\n\\newcommand{\\beq}{\\begin{equation}}\n\\newcommand{\\eeq}{\\end{equation}}\n\\begin{document}\n";

const open = (doc: string) => EditorState.create({ doc, extensions: visualStateFields });
const fresh = (state: EditorState) => collectLatexDefinitions([], { text: state.doc.toString(), bodyStart: bodyStartOf(state.doc.toString()) });
/** Definitions without the fingerprint (edits map positions and keep the one the decorations were built with), and without undefined fields. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(plain);
  if (value instanceof Set) return [...value].map(plain);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, plain(item)]));
  return value;
}
const content = (defs: LatexDefinitions) => plain({ ...defs, fingerprint: "" });
const typeAt = (state: EditorState, at: number, text: string) => state.update({ changes: { from: at, insert: text } }).state;
const endOfLine = (state: EditorState, needle: string) => state.doc.lineAt(state.doc.toString().indexOf(needle)).to;

test("typing in the body after the definitions keeps the definitions object", () => {
  let state = open(`${PREAMBLE}Some text here.\nMore text.\n\\end{document}\n`);
  const before = state.field(definitionsField);
  assert.ok(before.extents.length > 0);
  for (let i = 0; i < 5; i++) state = typeAt(state, endOfLine(state, "More text."), "x");
  assert.equal(state.field(definitionsField), before);
  assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
});

test("an edit in the preamble gives definitions equal to a fresh read", () => {
  let state = open(`${PREAMBLE}Some text here.\n\\end{document}\n`);
  const before = state.field(definitionsField);
  state = typeAt(state, PREAMBLE.indexOf("\\newcommand{\\foo}"), "% a note\n");
  assert.notEqual(state.field(definitionsField), before);
  assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
  state = typeAt(state, state.doc.toString().indexOf("{x}") + 2, "y");
  assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
  assert.equal(state.field(definitionsField).macros.get("foo")![0].body, "xy");
});

test("definitions made in the body: edits after them keep the object, edits before them move them", () => {
  let state = open(`${PREAMBLE}Intro.\n\\newcommand{\\bar}{y}\nAfter.\n\\end{document}\n`);
  const before = state.field(definitionsField);
  assert.ok(before.macros.get("bar")![0].pos > 0);
  state = typeAt(state, endOfLine(state, "After."), "z");
  assert.equal(state.field(definitionsField), before);
  state = typeAt(state, endOfLine(state, "Intro."), "q");
  assert.notEqual(state.field(definitionsField), before);
  assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
  assert.equal(state.field(definitionsField).macros.get("bar")![0].pos, state.doc.toString().indexOf("\\newcommand{\\bar}"));
});

test("a definition's own extent is never skipped over by the shortcut", () => {
  let state = open(`${PREAMBLE}Text.\n\\newcommand{\\bar}{y}\n\\end{document}\n`);
  const before = state.field(definitionsField);
  state = typeAt(state, state.doc.toString().indexOf("{y}") + 2, "w");
  assert.notEqual(state.field(definitionsField), before);
  assert.equal(state.field(definitionsField).macros.get("bar")![0].body, "yw");
});

test("lines with \\iff or \\newline are not definitions; \\newcommand, \\ifdraft, \\newif and unknown \\new… still read them", () => {
  const body = ["Plain text.", "so $a \\iff b$ holds", "one\\newline two \\newpage \\newblock", "\\ifdraft yes\\fi", "\\newlinex stuff", "\\newif\\ifzzz", "\\newcommand{\\late}{q}", "after $a \\iff b$ \\iffalse x\\fi"];
  const same = body.map((line) => {
    // One document per line: a definition made above it would move on any edit above, whatever the line.
    const base = open(`${PREAMBLE}${line}\n\\end{document}\n`);
    const defs = base.field(definitionsField);
    const state = typeAt(base, endOfLine(base, line), " k");
    assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
    // A re-read gives a new object even for the same definitions (it carries the extents just read).
    return state.field(definitionsField) === defs;
  });
  assert.deepEqual(same, [true, true, true, false, false, false, false, false]);
});

test("when the document defines \\newline or \\iff, a line using it is read again", () => {
  const base = open(`${PREAMBLE}\\newcommand{\\newline}{\\\\}\nline one\\newline two\n\\end{document}\n`);
  const defs = base.field(definitionsField);
  const state = typeAt(base, endOfLine(base, "line one"), "k");
  assert.notEqual(state.field(definitionsField), defs);
  assert.deepEqual(content(state.field(definitionsField)), content(fresh(state)));
});

test("disabled regions follow edits near \\iff and conditionals as a fresh computation", () => {
  const text = `${PREAMBLE}so $a \\iff b$ here\n\\iffalse\nhidden\n\\fi\n\\unless\\iff x\nafter \\iff\\ifx a b c\\fi\n\\end{document}\n`;
  fc.assert(fc.property(fc.array(fc.tuple(fc.nat(text.length + 20), fc.nat(3), fc.constantFrom("a", " ", "f", "\\iff", "i", "\n", "\\fi", "x")), { minLength: 1, maxLength: 6 }), (edits) => {
    let state = open(text);
    for (const [at, length, insert] of edits) {
      const from = Math.min(at, state.doc.length);
      state = state.update({ changes: { from, to: Math.min(state.doc.length, from + length), insert } }).state;
      const expected = disabledRegions(state.doc.toString(), discardingMacros(state.field(definitionsField)), state.field(definitionsField));
      assert.deepEqual(state.field(disabledField), expected);
    }
  }), { numRuns: 150 });
});

test("a top-level read has a fingerprint, as collect does", () => {
  const text = `${PREAMBLE}\\newcommand{\\defmacro}[2]{\\newcommand{#1}{#2}}\n\\defmacro{\\zed}{z}\nText\n\\end{document}\n`;
  const read = readLatexDefinitions(text);
  assert.equal(read.fingerprint, definitionsFingerprint(read));
  assert.notEqual(read.fingerprint, "");
  assert.ok(read.macros.has("zed"));
  const collected = collectLatexDefinitions([], { text });
  assert.equal(collected.fingerprint, definitionsFingerprint(collected));
  assert.deepEqual(content(collected), content(read));
});

type Range = { from: number; to: number; id: number };

test("outermost sweeps equal the filters they replace", () => {
  const regions = fc.array(fc.tuple(fc.nat(12), fc.nat(8)), { maxLength: 14 }).map((pairs) => pairs.map(([from, length], id): Range => ({ from, to: from + length, id })).sort((a, b) => a.from - b.from));
  fc.assert(fc.property(regions, (list) => {
    const outer = list.filter((region, index) => !list.some((other, at) => at !== index && other.from <= region.from && other.to >= region.to && (other.from !== region.from || other.to !== region.to)));
    assert.deepEqual(outermostRegions(list), outer);
    const contained = list.filter((region, index) => !list.some((other, at) => at !== index && other.from <= region.from && other.to >= region.to && (at < index || other.from !== region.from || other.to !== region.to)));
    assert.deepEqual(withoutContained(list), contained);
  }), { numRuns: 2000 });
});

const BODY_PIECES = [
  "\\beq x+y \\eeq\n", "\\begin{equation} y \\end{equation}\n", "% \\beq in a comment\n", "100\\% \\beq z \\eeq\n", "plain text here\n", "\\beq a \\begin{equation} b \\end{equation} c \\eeq\n",
  "\\eeq stray\n", "\\begin {equation}\n u\n\\end {equation}\n", "word \\begin{align} q \\end{align} tail\n", "\\beq\\eeq\\beq k \\eeq\n",
];
const INSERTS = ["a", " ", "e", "q", "beq", "begin", "equation", "x y", "a", " ", "e", "q", "{", "}", "\\", "%", "\n", "\\beq", "\\eeq", "\\%", ""];

test("macro environment regions after any edit equal a fresh computation, and are carried over inert ones", () => {
  let carried = 0;
  let steps = 0;
  const edit = fc.record({ at: fc.nat(1000), length: fc.nat(4), insert: fc.constantFrom(...INSERTS), second: fc.oneof({ weight: 6, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.record({ at: fc.nat(1000), length: fc.nat(3), insert: fc.constantFrom(...INSERTS) }) }) });
  fc.assert(fc.property(fc.array(fc.constantFrom(...BODY_PIECES), { minLength: 1, maxLength: 8 }), fc.array(edit, { minLength: 1, maxLength: 8 }), (pieces, edits) => {
    let state = open(`${PREAMBLE}${pieces.join("")}\\end{document}\n`);
    macroRegionsFor(state.doc, state.field(definitionsField));
    for (const step of edits) {
      const size = state.doc.length;
      const spec = (item: { at: number; length: number; insert: string }) => { const base = item.at % 8 ? Math.min(size, PREAMBLE.length) : 0; const from = base + Math.floor(item.at / 8) % (size - base + 1); return { from, to: Math.min(size, from + item.length), insert: item.insert }; };
      const changes = [spec(step)];
      if (step.second) {
        const other = spec(step.second);
        if (other.to < changes[0].from || other.from > changes[0].to) changes.push(other);
      }
      state = state.update({ changes }).state;
      const defs = state.field(definitionsField);
      const held = heldMacroRegions(state.doc, defs);
      const regions = macroRegionsFor(state.doc, defs);
      steps++;
      if (held) carried++;
      assert.deepEqual(regions, macroEnvironmentRegions(state.doc.toString(), { ...defs }), `after ${JSON.stringify(step)} in ${JSON.stringify(state.doc.toString())}`);
    }
  }), { numRuns: 400 });
  assert.ok(steps > 500);
  assert.ok(carried > 100, `only ${carried} of ${steps} carried`);
});

test("typing in prose carries the regions over", () => {
  let state = open(`${PREAMBLE}one \\beq x \\eeq two\nthree\n\\end{document}\n`);
  const defs = state.field(definitionsField);
  const regions = macroRegionsFor(state.doc, defs);
  assert.equal(regions.length, 1);
  state = typeAt(state, endOfLine(state, "three"), "ab");
  assert.ok(heldMacroRegions(state.doc, defs));
  state = typeAt(state, state.doc.toString().indexOf("one"), "ab ");
  const moved = heldMacroRegions(state.doc, defs)!;
  assert.equal(state.doc.sliceString(moved[0].from, moved[0].to), "\\beq x \\eeq");
});
