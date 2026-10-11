import assert from "node:assert/strict";
import { test } from "node:test";
import { plainParagraphRange } from "../../src/lib/markdown-review";

const tex = "\\section{Intro}\n\nFirst line\nsecond line.\n\n  \n\\begin{itemize}\n  \\item One\n\\end{itemize}\n";

test("LaTeX review selections expand to blank-line paragraphs", () => {
  const caret = tex.indexOf("second");
  const range = plainParagraphRange(tex, { start: caret, end: caret });
  assert.equal(tex.slice(range!.start, range!.end), "First line\nsecond line.");
  const across = plainParagraphRange(tex, { start: tex.indexOf("Intro"), end: tex.indexOf("One") });
  assert.equal(tex.slice(across!.start, across!.end), tex.trim());
  assert.equal(plainParagraphRange("   \n\n  ", { start: 1, end: 1 }), null);
});
