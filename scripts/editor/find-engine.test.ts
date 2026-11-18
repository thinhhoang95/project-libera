import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileFind,
  compileFindReplacement,
  DEFAULT_FIND_OPTIONS,
  replaceAllInText,
  scanRegions,
  type FindOptions,
} from "../../src/lib/find";

/* The find & replace engine (src/lib/find, docs/find-replace-patterns-plan.md). */

function finderFor(query: string, options: Partial<FindOptions> = {}) {
  const compiled = compileFind(query, { ...DEFAULT_FIND_OPTIONS, mode: "pattern", flavor: "latex", ...options });
  assert.ok(compiled.ok, `${query}: ${JSON.stringify(!compiled.ok && compiled.error)}`);
  return compiled.finder;
}

function replaceAll(query: string, replacement: string, text: string, options: Partial<FindOptions> & { preserveCase?: boolean } = {}) {
  const finder = finderFor(query, options);
  const compiled = compileFindReplacement(finder, replacement, options.preserveCase ?? false);
  assert.ok(compiled.ok, `${replacement}: ${JSON.stringify(!compiled.ok && compiled.error)}`);
  const { matches, incomplete } = finder.find(text);
  assert.equal(incomplete, false);
  return replaceAllInText(text, matches, compiled.replacer).text;
}

function found(query: string, text: string, options: Partial<FindOptions> = {}) {
  return finderFor(query, options).find(text).matches.map((match) => text.slice(match.start, match.end));
}

test("the design's example table", () => {
  const table: [string, string, string, string][] = [
    ["\\(*\\)", "\\[@1\\]", "\\(4x+3\\)", "\\[4x+3\\]"],
    ["\\(*,*\\)", "\\(@2,@1\\)", "\\(4x+3,3y\\)", "\\(3y,4x+3\\)"],
    ["\\(*,*\\)", "\\(@2,@1\\)", "\\(f(a,b),3y\\)", "\\(3y,f(a,b)\\)"],
    ["\\(*,*\\)", "[@1|@2]", "\\(a,b,c\\)", "[a|b,c]"],
    ["\\(@x/[^,]+/,@y/[^,]+/\\)", "[@x|@y]", "\\(a,b,c\\) \\(d,e\\)", "\\(a,b,c\\) [d|e]"],
    ["$*$", "\\(@1\\)", "$a$ and $b$", "\\(a\\) and \\(b\\)"],
    ["\\frac@n:arg@d:arg", "\\dfrac{@n}{@d}", "\\frac12 + \\frac\\pi2 + \\frac{a}{b^{2}}", "\\dfrac{1}{2} + \\dfrac{\\pi}{2} + \\dfrac{a}{b^{2}}"],
    ["\\textbf{*}", "**@1**", "\\textbf{key}", "**key**"],
    ["\\*\\*@x\\*\\*", "\\textbf{@x}", "**key**", "\\textbf{key}"],
    ["@a+@a", "2@a", "x+x, x+y", "2x, x+y"],
    ["\\begin{@env}@body:block\\end{@env}", "\\begin{@env*}@body\\end{@env*}", "\\begin{equation}\na=b\n\n\\end{equation}", "\\begin{equation*}\na=b\n\n\\end{equation*}"],
    ["*^2", "\\sq{@1}", "y = (a+b)^2", "y = \\sq{(a+b)}"],
    ["x_*", "x[@1]", "x_{ij} + x_1", "x[{ij}] + x[1]"],
    ["x_@i:arg", "x[@i]", "x_{ij}, x_1", "x[ij], x[1]"],
    ["@p:num\\%", "@(p/100)", "50\\%", "0.5"],
    ["Fig. @n:int", "Figure~\\ref{fig:@n}", "Fig. 3", "Figure~\\ref{fig:3}"],
    ["\\section{*}", "\\section{@(1.title)}", "\\section{related work}", "\\section{Related Work}"],
    ["TODO", "TODO-@#", "TODO a TODO b TODO", "TODO-1 a TODO-2 b TODO-3"],
    ["\\left@o:arg*\\right@c:arg", "@o@1@c", "\\left(x\\right)", "(x)"],
  ];
  for (const [query, replacement, before, after] of table) {
    assert.equal(replaceAll(query, replacement, before), after, `${query} → ${replacement} on ${before}`);
  }
});

test("holes are shortest first, so two formulas stay two matches", () => {
  assert.deepEqual(found("s*d", "sad and sold"), ["sad", "sold"]);
  assert.deepEqual(found("\\(*\\)", "\\(a\\) and \\(b\\)"), ["\\(a\\)", "\\(b\\)"]);
});

test("holes keep brackets balanced, and fall back to braces only", () => {
  assert.deepEqual(found("\\frac{*}{*}", "\\frac{a^{2}}{b} + \\frac{x}{y}"), ["\\frac{a^{2}}{b}", "\\frac{x}{y}"]);
  // A half-open interval cannot be balanced; the braces-only retry still finds it.
  assert.deepEqual(found("\\(*\\)", "\\([0,1)\\) and \\(f(x\\)"), ["\\([0,1)\\)", "\\(f(x\\)"]);
  // A hole never contains half a {…} group.
  assert.deepEqual(found("{*,", "{a}, {b,"), ["{b,"]);
  // Escaped braces are not brackets.
  assert.deepEqual(found("(*)", "(\\{a)"), ["(\\{a)"]);
});

test("a hole stays in its paragraph unless typed block", () => {
  assert.deepEqual(found("a*b", "a\nb"), ["a\nb"]);
  assert.deepEqual(found("a*b", "a\n\nb"), []);
  assert.deepEqual(found("a@x:block b", "a\n\nb"), []);
  assert.deepEqual(found("a@x:block\\b", "a\n\n\\b"), ["a\n\n\\b"]);
});

test("edge holes take one operand", () => {
  assert.deepEqual(found("*^2", "$x^2$ \\(\\alpha^2\\) \\\\x^2 a+b^2 f(a,b)^2"), ["x^2", "\\alpha^2", "x^2", "b^2", "f(a,b)^2"]);
  assert.deepEqual(found("x_*", "$x_{ij}$, \\(x_1\\). x_2."), ["x_{ij}", "x_1", "x_2"]);
});

test("? is one character and \\* \\? \\@ \\\\ are literal", () => {
  assert.deepEqual(found("file-??.md", "file-01.md file-1.md"), ["file-01.md"]);
  assert.deepEqual(found("a\\*b", "a*b axb"), ["a*b"]);
  assert.deepEqual(found("a\\?b", "a?b axb"), ["a?b"]);
  assert.deepEqual(found("me\\@x", "me@x"), ["me@x"]);
  assert.deepEqual(found("🙂?", "🙂a🙂🙂"), ["🙂a", "🙂🙂"]);
  // `\\` is the LaTeX line break pair, so a hole may follow it.
  assert.equal(replaceAll("\\\\*", "[@1]", "a \\\\b"), "a [b]");
  assert.deepEqual(found("x\\\\*", "x\\\\y"), ["x\\\\y"]);
});

test("hole types", () => {
  assert.deepEqual(found("@:word!", "hi! ok!"), ["hi!", "ok!"]);
  assert.deepEqual(found("v@:int", "v12 v-3 vx"), ["v12", "v-3"]);
  assert.deepEqual(found("@:num px", "1.5 px .5 px 2e-3 px"), ["1.5 px", ".5 px", "2e-3 px"]);
  assert.deepEqual(found("a@:space.", "a  . a."), ["a  ."]);
  assert.deepEqual(found("@:cmd{x}", "\\textbf{x} \\,{x}"), ["\\textbf{x}", "\\,{x}"]);
  assert.deepEqual(found("% @:line", "% note here\nnext"), ["% note here"]);
  assert.equal(replaceAll("\\item@o:opt @:line", "<@o|@1>", "\\item[a] one\n\\item two"), "<a|one>\n<|two>");
  assert.deepEqual(found("@:math", "a $b$ \\(c\\) \\[d\\] $$e$$ \\begin{align}f\\end{align}"), ["$b$", "\\(c\\)", "\\[d\\]", "$$e$$", "\\begin{align}f\\end{align}"]);
});

test("a name used twice must match the same text", () => {
  assert.deepEqual(found("@a=@a", "x=x y=z"), ["x=x"]);
  assert.deepEqual(found("<@t>*</@t>", "<b>x</b> <i>y</b>"), ["<b>x</b>"]);
});

test("pattern errors and warnings", () => {
  const error = (query: string) => {
    const compiled = compileFind(query, { ...DEFAULT_FIND_OPTIONS, mode: "pattern" });
    assert.ok(!compiled.ok, query);
    return compiled.error.message.id;
  };
  assert.equal(error("@x:nope"), "unknownType");
  assert.equal(error("@x:"), "typeExpected");
  assert.equal(error("@x/[a/"), "unterminatedRegex");
  assert.equal(error("@x/(/"), "invalidRegex");
  assert.equal(error("@1"), "numberedHoleName");
  assert.equal(error("*"), "needsLiteral");
  assert.deepEqual(finderFor("a**b").warnings.map((warning) => warning.message.id), ["adjacentHoles"]);
  // A lone @ is literal.
  assert.deepEqual(found("a @ b", "a @ b"), ["a @ b"]);
});

test("query parts describe holes for the chips", () => {
  const finder = finderFor("\\(*,@x:num\\)");
  assert.deepEqual(finder.parts.map((part) => part.kind === "hole" ? `${part.group}${part.name ?? ""}${part.type ? `:${part.type}` : ""}` : part.kind), ["text", "1:any", "text", "2x:num", "text"]);
});

test("replacement language", () => {
  assert.equal(replaceAll("@a,@b", "@b,@a", "1,2"), "2,1");
  assert.equal(replaceAll("x=@n:int", "x=@(n+1)", "x=41"), "x=42");
  assert.equal(replaceAll("x=*;", "x=@(@1*2);", "x=21;"), "x=42;");
  assert.equal(replaceAll("x", "@(#+9)", "x x"), "10 11");
  assert.equal(replaceAll("@w:word", "@(w.upper)-@(w.lower)", "MiXed"), "MIXED-mixed");
  assert.equal(replaceAll("[*]", "@(1.trim)", "[  a  ]"), "a");
  assert.equal(replaceAll("@x:word", "@(x)y \\@ @0", "ab"), "aby @ ab");
  assert.equal(replaceAll("a", "b@", "a"), "b@");
  // $ and \ are literal in replacements.
  assert.equal(replaceAll("\\(*\\)", "$@1$", "\\(x\\)"), "$x$");

  const finder = finderFor("@a,");
  const unknown = compileFindReplacement(finderFor("x*"), "@nope", false);
  assert.ok(!unknown.ok && unknown.error.message.id === "unknownCapture");
  assert.ok(!compileFindReplacement(finder, "@(a", false).ok);
  assert.ok(!compileFindReplacement(finderFor("x*"), "@(1+)", false).ok);
});

test("arithmetic on a non-number skips that match", () => {
  const finder = finderFor("v=*;");
  const compiled = compileFindReplacement(finder, "v=@(@1+1);", false);
  assert.ok(compiled.ok);
  const text = "v=1; v=x; v=2;";
  const result = replaceAllInText(text, finder.find(text).matches, compiled.replacer);
  assert.deepEqual(result, { text: "v=2; v=x; v=3;", replaced: 2, skipped: 1 });
});

test("plain mode", () => {
  assert.deepEqual(found("one", "one ONE One", { mode: "plain" }), ["one", "ONE", "One"]);
  assert.deepEqual(found("one", "one ONE One", { mode: "plain", matchCase: true }), ["one"]);
  assert.deepEqual(found("a*b", "a*b axb", { mode: "plain" }), ["a*b"]);
  // Plain replacements are literal: no @ syntax.
  assert.equal(replaceAll("x", "@1 $& @#", "x", { mode: "plain" }), "@1 $& @#");
});

test("regex mode", () => {
  assert.equal(replaceAll("(\\d+)-(?<b>\\d+)", "@b-@1", "10-20", { mode: "regex" }), "20-10");
  assert.equal(replaceAll("^x", "y", "x\nx", { mode: "regex" }), "y\ny");
  assert.equal(replaceAll("a(b)?", "[@1]", "a ab", { mode: "regex" }), "[] [b]");
  assert.deepEqual(found("x*", "axxb", { mode: "regex" }), ["xx"]);
  const invalid = compileFind("(", { ...DEFAULT_FIND_OPTIONS, mode: "regex" });
  assert.ok(!invalid.ok && invalid.error.message.id === "invalidRegex");
  const compiled = compileFindReplacement(finderFor("(a)", { mode: "regex" }), "$1 $&", false);
  assert.ok(compiled.ok);
  assert.deepEqual(compiled.warnings.map((warning) => warning.message), [
    { id: "dollarReference", written: "$1", suggestion: "@1" },
    { id: "dollarReference", written: "$&", suggestion: "@0" },
  ]);
});

test("match case, whole word, flexible spacing, preserve case", () => {
  assert.deepEqual(found("cat", "cat Cat concat cats", { wholeWord: true }), ["cat", "Cat"]);
  assert.deepEqual(found("cat", "cat Cat", { matchCase: true }), ["cat"]);
  assert.deepEqual(found("a b", "ab a  b a\nb", { flexibleSpacing: true }), ["ab", "a  b", "a\nb"]);
  assert.deepEqual(found("a b", "ab a  b", { flexibleSpacing: true, mode: "plain" }), ["ab", "a  b"]);
  assert.equal(replaceAll("word", "term", "word Word WORD", { mode: "plain", preserveCase: true }), "term Term TERM");
  // Preserve case only applies when Match case is off.
  assert.equal(replaceAll("Word", "term", "Word", { mode: "plain", preserveCase: true, matchCase: true }), "term");
});

test("Where scopes", () => {
  const latex = "x $x+1$ % x\n\\(x\\) \\verb|x| \\begin{verbatim}x\\end{verbatim}";
  const at = (scope: FindOptions["scope"]) => finderFor("x", { mode: "plain", scope }).find(latex).matches.map((match) => match.start);
  assert.deepEqual(at("insideMath"), [3, 14]);
  assert.deepEqual(at("outsideMath"), [0, 10, 24, 43]);
  assert.deepEqual(at("skipCommentsAndCode"), [0, 3, 14]);
  // A match that contains whole math spans is outside math.
  assert.deepEqual(found("\\(*\\)", "\\(x\\)", { scope: "outsideMath" }), ["\\(x\\)"]);

  const markdown = "x `x` $x$\n```\nx\n```\n<!-- x -->";
  assert.deepEqual(finderFor("x", { mode: "plain", scope: "skipCommentsAndCode", flavor: "markdown" }).find(markdown).matches.map((match) => match.start), [0, 7]);
  assert.deepEqual(scanRegions("a $b$ c", "markdown").math, [{ start: 2, end: 5, contentStart: 3, contentEnd: 4 }]);
  // `$ 5 and $ 6` is not math (a space after the opener).
  assert.deepEqual(scanRegions("$ 5 and $ 6", "markdown").math, []);
});

test("In selection and extra skipped ranges", () => {
  const finder = finderFor("x", { mode: "plain" });
  assert.deepEqual(finder.find("x x x", { within: [{ start: 1, end: 4 }] }).matches.map((match) => match.start), [2]);
  const code = finderFor("x", { mode: "plain", scope: "skipCommentsAndCode", flavor: "markdown" });
  assert.deepEqual(code.find("x x", { skipped: [{ start: 0, end: 1 }] }).matches.map((match) => match.start), [2]);
});

test("a rejected match does not hide a later one starting inside it", () => {
  assert.deepEqual(found("aa", "aaa", { wholeWord: true }), []);
  assert.deepEqual(found("ab", "xab ab", { wholeWord: true, mode: "plain" }), ["ab"]);
});

test("crossesParagraphs tells adapters when paragraph caching is exact", () => {
  assert.equal(finderFor("a*b").crossesParagraphs, false);
  assert.equal(finderFor("a@x:block b").crossesParagraphs, true);
  assert.equal(finderFor("a", { mode: "regex" }).crossesParagraphs, true);
});

test("hostile patterns stop at the step budget instead of freezing", { timeout: 5000 }, () => {
  const text = "a".repeat(20_000);
  const started = performance.now();
  const result = finderFor("@a:block a@b:block a@c:block b").find(text);
  assert.deepEqual(result.matches, []);
  assert.ok(performance.now() - started < 4000);
  // Without back-references failures are memoised, so a long paragraph of `\(` stays fast.
  const formulas = "\\(x\\) ".repeat(5000);
  const quick = performance.now();
  assert.equal(finderFor("\\(*\\)").find(formulas).matches.length, 5000);
  assert.ok(performance.now() - quick < 1500);
});
