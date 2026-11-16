import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeMarkdown } from "../../src/lib/latex/markdown-paste/detect";

/* Libera's own Markdown syntax is recognised from the text alone (the context
 * menu's Paste cannot see the clipboard's Libera type), while LaTeX stays LaTeX. */

test("Libera-only syntax is Markdown by itself", () => {
  for (const text of [
    "[color=#dc2626]Important[/color] text.",
    "b> A blue box.",
    "r>>>red<<< g>>>green<<< b>>>blue<<<",
    ">>>plain mark<<<",
    "As shown [@smith2020, p. 4] and @doe2021.",
    "See [-@smith2020].",
    "> plain quote\n\ng> green box",
  ]) assert.equal(looksLikeMarkdown(text), true, text);
});

test("a lone bold or link in general text stays conservative", () => {
  for (const text of ["**Key** point.", "See [docs](https://x.org)", "<u>u</u>"]) assert.equal(looksLikeMarkdown(text), false, text);
});

test("LaTeX and math that resemble the syntax are not detected", () => {
  for (const text of [
    "\\textbf{x} [color] a > b",
    "$a > b$",
    "a & b & c \\\\\n1 & 2 & 3 \\\\",
    "\\begin{tabular}{>{\\bfseries}l}\nb> x \\\\\n\\end{tabular}",
    "\\cite{a} [@x] \\textbf{y}",
  ]) assert.equal(looksLikeMarkdown(text), false, text);
});
