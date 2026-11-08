import "./setup.cjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { TreeFragment, type Tree } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
// The parser Libera uses: the package's, with nested groups in file paths (latex-parser.ts).
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexHighlightStyle, latexLanguage as streamLanguage } from "../../src/lib/latex/codemirror/language";
import { latexTreeLanguage } from "../../src/lib/latex/codemirror/latex-language";

/* codemirror-lang-latex is pinned (docs/latex-visual-editor-plan.md §2). These
 * tests are the gate for upgrading it: the tree of the fixture must keep its
 * shape, incremental parses must equal fresh ones, and Source mode must keep
 * its colours. */

const FIXTURE = path.join(__dirname, "fixtures/latex/visual-sample.tex");
const SNAPSHOT = path.join(__dirname, "fixtures/latex/visual-sample.tree.txt");
const SAMPLE = readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");

function outline(tree: Tree, text: string) {
  const lines: string[] = [];
  tree.iterate({
    enter(node) {
      if (/^(?:Text|Normal|Whitespace|NewLine|OpenBrace|CloseBrace|LaTeX|Content|LongArg|ShortArg|ShortTextArgument|KnownCommand|Command)$/.test(node.name)) return;
      let depth = 0;
      for (let parent = node.node.parent; parent; parent = parent.parent) depth++;
      lines.push(`${" ".repeat(Math.min(depth, 12))}${node.type.isError ? "⚠" : node.name} ${JSON.stringify(text.slice(node.from, Math.min(node.to, node.from + 24)))}`);
    },
  });
  return lines.join("\n");
}

test("the fixture's tree keeps its shape (update the snapshot only after checking the new tree)", () => {
  const actual = outline(parser.parse(SAMPLE), SAMPLE);
  if (!existsSync(SNAPSHOT) || process.env.UPDATE_LATEX_SNAPSHOT) writeFileSync(SNAPSHOT, `${actual}\n`);
  assert.equal(actual, readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n").trimEnd());
});

test("the node names the Visual mode relies on are there", () => {
  const names = new Set<string>();
  parser.parse(SAMPLE).iterate({ enter(node) { names.add(node.name); } });
  for (const name of [
    "Section", "SubSection", "SectioningCommand", "SectioningArgument", "TextBoldCommand", "TextItalicCommand", "EmphasisCommand",
    "TextTeletypeCommand", "TextColorCommand", "HrefCommand", "UrlCommand", "FootnoteCommand", "DollarMath", "InlineMath",
    "EquationEnvironment", "EquationArrayEnvironment", "Cite", "BibKeyArgument", "Ref", "RefArgument", "Label", "LabelArgument",
    "FigureEnvironment", "TableEnvironment", "TabularEnvironment", "IncludeGraphics", "Caption", "ListEnvironment", "Item",
    "Environment", "BeginEnv", "EndEnv", "EnvNameGroup", "VerbatimEnvironment", "DocumentEnvironment", "Maketitle", "NewCommand",
    "NewTheoremCommand", "Comment", "Tilde", "UnknownCommand", "MultiColumn", "HorizontalLine",
  ]) assert.ok(names.has(name), `missing ${name}`);
});

test("incremental parses equal fresh parses after random edits", () => {
  const pieces = ["$", "{", "}", "\\textbf{", "\\begin{itemize}", "\\end{itemize}", "\n\n", "%", "\\section{x}", "a", "\\\\", "$$"];
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 8 }), insert: fc.constantFrom(...pieces) }), { minLength: 1, maxLength: 5 }), (edits) => {
    let text = SAMPLE;
    let tree = parser.parse(text);
    let fragments = TreeFragment.addTree(tree);
    for (const edit of edits) {
      const from = edit.at % text.length;
      const to = Math.min(text.length, from + edit.remove);
      text = text.slice(0, from) + edit.insert + text.slice(to);
      fragments = TreeFragment.applyChanges(fragments, [{ fromA: from, toA: to, fromB: from, toB: from + edit.insert.length }]);
      tree = parser.parse(text, fragments);
      fragments = TreeFragment.addTree(tree, fragments);
    }
    assert.equal(tree.toString(), parser.parse(text).toString());
  }), { numRuns: 80 });
});

function classesByCharacter(tree: Tree, length: number) {
  const classes: string[] = Array.from({ length }, () => "");
  highlightTree(tree, latexHighlightStyle, (from, to, value) => { for (let i = from; i < to; i++) classes[i] = value; });
  return classes;
}

test("Source mode keeps its colours with the new parser", () => {
  const stream = classesByCharacter(streamLanguage.parser.parse(SAMPLE), SAMPLE.length);
  const lezer = classesByCharacter(latexTreeLanguage.parser.parse(SAMPLE), SAMPLE.length);
  // Comments, section titles, label and citation keys and environment names are coloured the same.
  const checks: Array<[string, RegExp]> = [
    ["comment", /% \\section\{Commented out\}/],
    ["heading", /\\section\{(Introduction)\}/],
    ["label", /\\label\{(sec:intro)\}/],
    ["cite key", /\\cite\{(knuth1984)\}/],
    ["environment", /\\begin\{(itemize)\}/],
  ];
  for (const [what, pattern] of checks) {
    const match = pattern.exec(SAMPLE)!;
    const start = match.index + (match[1] ? match[0].indexOf(match[1]) : 0);
    const end = start + (match[1] ?? match[0]).length;
    for (let i = start; i < end; i++) assert.equal(lezer[i], stream[i], `${what} at ${i} (${JSON.stringify(SAMPLE.slice(start, end))})`);
    assert.ok(lezer[start], `${what} is highlighted`);
  }
  // Overall, almost every character keeps its colour.
  let same = 0;
  for (let i = 0; i < SAMPLE.length; i++) if (stream[i] === lezer[i]) same++;
  assert.ok(same / SAMPLE.length > 0.8, `only ${Math.round((same / SAMPLE.length) * 100)}% of characters keep their colour`);
});
