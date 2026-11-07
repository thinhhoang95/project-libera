import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { applyTexChanges, canonicalTokens, texDiff, tokenizeTex } from "../../src/lib/latex/codemirror/visual/tex-tokens";
import { deleteColumn, deleteRow, insertColumn, insertRow, parseColumnSpec, parseTabular, setCellText, type TableChange } from "../../src/lib/latex/codemirror/visual/table-model";
import { escapeLatexText, htmlToLatex } from "../../src/lib/latex/codemirror/visual/html2latex";
import { refusalReason } from "../../src/lib/latex/codemirror/visual/math-edit";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.defineProperty(globalThis, "DOMParser", { value: dom.window.DOMParser, configurable: true });
after(() => dom.window.close());

function apply(source: string, changes: TableChange[]) {
  let out = source;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/* ---- Formula write-back --------------------------------------------------------- */

test("TeX tokens: control words, symbols, braces and spaces", () => {
  assert.deepEqual(tokenizeTex("\\frac{a}{b} \\, x^2").map((token) => token.text), ["\\frac", "{", "a", "}", "{", "b", "}", " ", "\\,", " ", "x", "^", "2"]);
  assert.deepEqual(canonicalTokens("x^{2} + \\frac{1}{2}").map((token) => token.text), ["x", "^", "2", "+", "\\frac", "1", "2"]);
});

test("MathLive's rewrites of unchanged parts write nothing", () => {
  assert.deepEqual(texDiff("x^2+\\frac12", "x^{2}+\\frac{1}{2}"), []);
  assert.deepEqual(texDiff("a \\le b", "a\\leq b"), []);
  assert.deepEqual(texDiff("  \\alpha  ", "\\alpha"), []);
});

test("only the tokens that changed are written, at their place in the document", () => {
  const original = "x^2 + y^{2} = r^2";
  const changes = texDiff(original, "x^{2}+y^{3}=r^2", 100);
  // The one-token group `{2}` is replaced whole, by MathLive's spelling of the new one.
  assert.deepEqual(changes, [{ from: 108, to: 111, insert: "{3}" }]);
  assert.equal(applyTexChanges(original, changes, 100), "x^2 + y^{3} = r^2");
  const inserted = texDiff("\\alpha", "\\alpha b");
  assert.equal(applyTexChanges("\\alpha", inserted), "\\alpha b");
});

test("a diff applied to the original always typesets as the edited formula", () => {
  const atoms = fc.constantFrom("x", "y", "2", "+", "=", "\\alpha", "\\beta", "^", "_", "{a}", "{b c}", "\\frac{1}{2}", " ", "(", ")");
  fc.assert(fc.property(fc.array(atoms, { maxLength: 14 }), fc.array(atoms, { maxLength: 14 }), (a, b) => {
    const original = a.join("");
    const edited = b.join("");
    const result = applyTexChanges(original, texDiff(original, edited));
    assert.deepEqual(canonicalTokens(result).map((token) => token.text), canonicalTokens(edited).map((token) => token.text));
  }), { numRuns: 300 });
});

test("formulas MathLive would change are refused", () => {
  assert.equal(refusalReason("x^2", false), null);
  assert.ok(refusalReason("a \\\\ b", false));
  assert.ok(refusalReason("a & b", false));
  assert.ok(refusalReason("x \\label{eq}", false));
  assert.ok(refusalReason("x % note", false));
  assert.equal(refusalReason("x \\% y", false), null);
  assert.ok(refusalReason("a\nb", false));
  assert.ok(refusalReason("\\vect{n}", true));
});

/* ---- Tables --------------------------------------------------------------------- */

const TABLE = String.raw`\begin{tabular}{l|cr}
  \hline
  Model & BLEU & Cost \\
  \hline
  Base & 27.3 & $10^{18}$ \\
  \multicolumn{2}{c}{Big} & 41.0 \\
  \bottomrule
\end{tabular}`;

test("every cell maps to its exact source range, \\multicolumn and rules included", () => {
  const model = parseTabular(TABLE, 50)!;
  assert.deepEqual(model.columns, ["l", "c", "r"]);
  assert.equal(model.rows.length, 3);
  assert.deepEqual(model.rows.map((row) => row.cells.map((cell) => cell.text)), [["Model", "BLEU", "Cost"], ["Base", "27.3", "$10^{18}$"], ["\\multicolumn{2}{c}{Big}", "41.0"]]);
  assert.deepEqual(model.rows.map((row) => row.rulesBefore), [["\\hline"], ["\\hline"], []]);
  assert.deepEqual(model.rulesAfter, ["\\bottomrule"]);
  for (const row of model.rows) for (const cell of row.cells) assert.equal(TABLE.slice(cell.from - 50, cell.to - 50), cell.text);
  const big = model.rows[2].cells[0];
  assert.equal(big.span, 2);
  assert.equal(TABLE.slice(big.contentFrom! - 50, big.contentTo! - 50), "Big");
  assert.deepEqual(parseColumnSpec("@{}l*{3}{c}p{2cm}>{\\bfseries}r@{}"), ["l", "c", "c", "c", "p", "r"]);
});

test("cells with comments or line breaks are edited as source", () => {
  const model = parseTabular(String.raw`\begin{tabular}{ll}
a % note
& b \\
\makecell{x\\y} & z
\end{tabular}`)!;
  assert.equal(model.rows[0].cells[0].sourceOnly, true);
  assert.equal(model.rows[1].cells[0].sourceOnly, true);
  assert.equal(model.rows[1].cells[1].sourceOnly, false);
});

test("editing a cell rewrites only that cell", () => {
  const model = parseTabular(TABLE)!;
  assert.equal(apply(TABLE, [setCellText(model.rows[1].cells[1], "28.4")]), TABLE.replace("27.3", "28.4"));
  assert.equal(apply(TABLE, [setCellText(model.rows[2].cells[0], "Large")]), TABLE.replace("{Big}", "{Large}"));
});

test("rows and columns are added and removed with the fewest changes", () => {
  const model = parseTabular(TABLE)!;
  const withRow = apply(TABLE, insertRow(model, TABLE, 0, 0));
  assert.match(withRow, /Cost \\\\\n  & & \\\\\n/);
  assert.equal(parseTabular(withRow)!.rows.length, 4);
  const withoutRow = apply(TABLE, deleteRow(model, TABLE, 0, 1));
  assert.ok(!withoutRow.includes("Base"));
  assert.equal(parseTabular(withoutRow)!.rows.length, 2);
  const simple = String.raw`\begin{tabular}{lc}
a & b \\
c & d
\end{tabular}`;
  const simpleModel = parseTabular(simple)!;
  const withColumn = apply(simple, insertColumn(simpleModel, 0)!);
  assert.equal(withColumn, String.raw`\begin{tabular}{llc}
a & & b \\
c & & d
\end{tabular}`);
  const withoutColumn = apply(simple, deleteColumn(simpleModel, 1)!);
  assert.equal(withoutColumn, String.raw`\begin{tabular}{l}
a \\
c
\end{tabular}`);
  // A \multicolumn over the column makes it impossible.
  assert.equal(deleteColumn(model, 0), null);
  // The last row gains a `\\` before a new row.
  assert.equal(apply(simple, insertRow(simpleModel, simple, 0, 1)), String.raw`\begin{tabular}{lc}
a & b \\
c & d \\
&
\end{tabular}`);
});

/* ---- Paste ---------------------------------------------------------------------- */

test("text is escaped and symbols become commands", () => {
  assert.equal(escapeLatexText("50% of $5 & #1_x {ok} ~^\\"), "50\\% of \\$5 \\& \\#1\\_x \\{ok\\} \\textasciitilde{}\\textasciicircum{}\\textbackslash{}");
  assert.equal(escapeLatexText("α ≤ β"), "$\\alpha \\le \\beta$");
  assert.equal(escapeLatexText("“quoted” — and… done"), "``quoted'' --- and\\ldots{} done");
});

test("rich text from Word, Google Docs and web pages becomes LaTeX", () => {
  assert.equal(htmlToLatex("<h1>Title</h1><p>Some <b>bold</b>, <i>italic</i> and <a href=\"https://x.org\">a link</a>.</p><p>Second</p>"),
    "\\section{Title}\n\n\\textbf{bold}".replace("\\textbf{bold}", "Some \\textbf{bold}, \\emph{italic} and \\href{https://x.org}{a link}.") + "\n\nSecond");
  assert.equal(htmlToLatex("<ul><li>One</li><li>Two<ol><li>Nested</li></ol></li></ul>"),
    "\\begin{itemize}\n  \\item One\n  \\item Two\n  \\begin{enumerate}\n    \\item Nested\n  \\end{enumerate}\n\\end{itemize}");
  assert.equal(htmlToLatex("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2%</td></tr></table>"),
    "\\begin{tabular}{ll}\n  \\hline\n  A & B \\\\\n  \\hline\n  1 & 2\\% \\\\\n  \\hline\n\\end{tabular}");
  // Google Docs: styles on spans, inside a font-weight:normal wrapper.
  assert.equal(htmlToLatex("<b style=\"font-weight:normal;\" id=\"docs-internal-guid\"><span style=\"font-weight:700\">Bold</span> <span style=\"font-style:italic\">it</span></b>"), "\\textbf{Bold} \\emph{it}");
  // MathML with a TeX annotation keeps the TeX.
  assert.equal(htmlToLatex("<p>See <math><semantics><mi>x</mi><annotation encoding=\"application/x-tex\">x^2</annotation></semantics></math>.</p>"), "See $x^2$.");
  assert.equal(htmlToLatex("<pre><code>a_b {c}</code></pre>"), "\\begin{verbatim}\na_b {c}\n\\end{verbatim}");
  // Code editors' clipboards are source text: pasted as plain text.
  assert.equal(htmlToLatex("<div><span style=\"color:#f00\">\\textbf{x}</span></div>"), null);
  assert.equal(htmlToLatex("<script>alert(1)</script><p>safe</p>"), "safe");
});
