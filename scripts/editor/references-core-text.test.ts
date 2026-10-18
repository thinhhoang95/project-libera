import assert from "node:assert/strict";
import test from "node:test";
import { decodeLatex, decodeLatexVerbatim, encodeLatex, isSelfProtectingWord, markCaseProtection, protectTitleCase } from "../../src/lib/references/latex-text";
import { formatBibtexName, formatNameForDisplay, parseBibtexNameList, parseName, parsePersonList } from "../../src/lib/references/names";
import type { CslName } from "../../src/lib/references/types";

const NOCASE = (text: string) => `<span class="nocase">${text}</span>`;

test("decodes accent macros in every form", () => {
  const cases: Array<[string, string]> = [
    [String.raw`\'e`, "é"], [String.raw`\'{e}`, "é"], [String.raw`{\'e}`, "é"], [String.raw`{\'{e}}`, "é"], [String.raw`\' e`, "é"],
    [String.raw`\"o`, "ö"], [String.raw`{\"O}sterreich`, "Österreich"], [String.raw`\^a`, "â"], [String.raw`\`a`, "à"],
    [String.raw`\~n`, "ñ"], [String.raw`\=a`, "ā"], [String.raw`\.z`, "ż"], [String.raw`\u{a}`, "ă"], [String.raw`\v{s}`, "š"],
    [String.raw`\v s`, "š"], [String.raw`\H{o}`, "ő"], [String.raw`\c{c}`, "ç"], [String.raw`\c c`, "ç"], [String.raw`\k{a}`, "ą"],
    [String.raw`\r{a}`, "å"], [String.raw`\d{e}`, "ẹ"], [String.raw`\b{b}`, "ḇ"], [String.raw`\t{oo}`, "o͡o"],
    [String.raw`\'{\i}`, "í"], [String.raw`\'\i`, "í"], [String.raw`\^{\j}`, "ĵ"], [String.raw`\^{\d{e}}`, "ệ"],
    [String.raw`Erd\H{o}s`, "Erdős"], [String.raw`Dvo\v{r}\'ak`, "Dvořák"], [String.raw`\^{}`, "^"], [String.raw`\~{}`, "~"],
  ];
  for (const [input, expected] of cases) assert.equal(decodeLatex(input), expected, input);
});

test("decodes special letters, escapes, dashes, quotes and spaces", () => {
  const cases: Array<[string, string]> = [
    [String.raw`Stra\ss e`, "Straße"], [String.raw`\ss{}`, "ß"], [String.raw`{\o}`, "ø"], [String.raw`\O`, "Ø"], [String.raw`\aa`, "å"],
    [String.raw`\AA{}`, "Å"], [String.raw`\ae`, "æ"], [String.raw`\AE`, "Æ"], [String.raw`\oe`, "œ"], [String.raw`\OE`, "Œ"],
    [String.raw`\l{}ukasiewicz`, "łukasiewicz"], [String.raw`\L ukasiewicz`, "Łukasiewicz"], [String.raw`\i`, "ı"], [String.raw`\j`, "ȷ"],
    [String.raw`A \& B \% \$ \# \_ \{ \}`, "A & B % $ # _ { }"], ["12--14", "12–14"], ["a---b", "a—b"], ["``quoted''", "“quoted”"],
    ["`single'", "‘single'"], ["a~b", "a b"], ["  many \n\t spaces  ", "many spaces"], [String.raw`\textendash\ \textemdash`, "– —"],
    [String.raw`\LaTeX{} and \TeX`, "LaTeX and TeX"], [String.raw`\noopsort{a}Zed`, "Zed"], [String.raw`\url{http://x.org/a_b}`, "http://x.org/a_b"],
    [String.raw`\href{http://x.org}{Site}`, "Site"], [String.raw`\mbox{G}\"odel`, "Gödel"], [String.raw`A & B 50% #1`, "A & B 50% #1"],
    [String.raw`\unknowncommand{kept} text`, "kept text"], ["stray } brace", "stray brace"],
  ];
  for (const [input, expected] of cases) assert.equal(decodeLatex(input), expected, input);
});

test("decodes formatting to CSL rich text, keeps math, and marks protected case", () => {
  const cases: Array<[string, string]> = [
    [String.raw`\textit{Drosophila}`, "<i>Drosophila</i>"], [String.raw`\emph{x}`, "<i>x</i>"], [String.raw`\textbf{b}`, "<b>b</b>"],
    [String.raw`\textsc{Small}`, '<span style="font-variant:small-caps;">Small</span>'], [String.raw`H\textsubscript{2}O`, "H<sub>2</sub>O"],
    [String.raw`x\textsuperscript{2}`, "x<sup>2</sup>"], [String.raw`{\em Emphasis here} after`, "<i>Emphasis here</i> after"],
    [String.raw`{\bf bold}`, "<b>bold</b>"], ["The $x^2_{i} + \\alpha$ term", "The $x^2_{i} + \\alpha$ term"], ["$$E=mc^2$$", "$$E=mc^2$$"],
    ["costs $5", "costs $5"], [String.raw`{Bayesian} inference`, `${NOCASE("Bayesian")} inference`],
    [String.raw`{The Netherlands}`, NOCASE("The Netherlands")], [String.raw`{{Nested} Braces}`, NOCASE("Nested Braces")],
    [String.raw`\textit{A {Bayesian} View}`, `<i>A ${NOCASE("Bayesian")} View</i>`], [String.raw`\NoCaseChange{Kept}`, NOCASE("Kept")],
    // Groups whose words protect themselves need no span (see latex-text.ts).
    [String.raw`The {DNA} of {iPhone}s`, "The DNA of iPhones"], [String.raw`{NASA JPL}`, "NASA JPL"], [String.raw`{2020}`, "2020"],
    [String.raw`{D}NA`, `${NOCASE("D")}NA`], [String.raw`{DNA-binding}`, "DNA-binding"],
  ];
  for (const [input, expected] of cases) assert.equal(decodeLatex(input), expected, input);
  assert.equal(decodeLatex(String.raw`\textit{The {Bayesian}} way`, { markup: "plain" }), "The Bayesian way");
  assert.equal(decodeLatex(String.raw`{Bayesian} way`, { protectCase: false }), "Bayesian way");
  assert.equal(decodeLatexVerbatim(String.raw`\url{https://x.org/~a/b\_c--d}`), "https://x.org/~a/b_c--d");
  assert.equal(decodeLatexVerbatim("{10.1000/{ABC}}"), "10.1000/ABC");
});

test("encodes Unicode and rich text to BibTeX-safe LaTeX in both dialects", () => {
  const bibtex: Array<[string, string]> = [
    ["Café", String.raw`Caf{\'e}`], ["Österreich", String.raw`{\"O}sterreich`], ["Straße", String.raw`Stra{\ss}e`],
    ["Łódź", String.raw`{\L}{\'o}d{\'z}`], ["çš", String.raw`{\c{c}}{\v{s}}`], ["Erdős", String.raw`Erd{\H{o}}s`], ["í", String.raw`{\'{\i}}`],
    ["ệ", String.raw`{\^{\d{e}}}`], ["Ångström", String.raw`{\AA}ngstr{\"o}m`], ["日本", "日本"], ["’", String.raw`\textquoteright{}`],
  ];
  for (const [input, expected] of bibtex) assert.equal(encodeLatex(input, "bibtex"), expected, input);
  const both: Array<[string, string]> = [
    ["A & B 50% $5 #1 a_b", String.raw`A \& B 50\% \$5 \#1 a\_b`], ["{x}", String.raw`\{x\}`], ["a~b", String.raw`a\textasciitilde{}b`],
    ["x^y", String.raw`x\textasciicircum{}y`], ["a\\b", String.raw`a\textbackslash{}b`], ["a b", "a~b"], ["1–2 a—b", "1--2 a---b"],
    ["“q”", "``q''"], ["a--b", "a-{}-b"], ["the $x^2$ term", "the $x^2$ term"], ["costs $5 and $10", String.raw`costs \$5 and \$10`],
    ["<i>it</i> <b>b</b> <sup>2</sup><sub>i</sub>", String.raw`\textit{it} \textbf{b} \textsuperscript{2}\textsubscript{i}`],
    ['<span style="font-variant:small-caps;">sc</span>', String.raw`\textsc{sc}`], [`${NOCASE("Bayesian")} view`, "{Bayesian} view"],
  ];
  for (const [input, expected] of both) {
    assert.equal(encodeLatex(input, "bibtex"), expected, `bibtex: ${input}`);
    assert.equal(encodeLatex(input, "biblatex"), expected, `biblatex: ${input}`);
  }
  assert.equal(encodeLatex("Café Straße", "biblatex"), "Café Straße");
});

test("decode(encode(text)) returns the text", () => {
  const samples = [
    "Café, Straße and Łódź: Erdős–Rényi graphs", "A & B: 50% of $x^2$ — “quoted” ’n’ a b", "<i>Drosophila</i> and H<sub>2</sub>O",
    `A ${NOCASE("Bayesian")} view of ${NOCASE("van der Waals")} forces`, "a--b and x^y_z {braces} back\\slash ~tilde",
    "Ångström ç ő ệ ı í", "Dvořák’s <b>bold</b> <sup>th</sup>",
  ];
  for (const dialect of ["bibtex", "biblatex"] as const) {
    for (const sample of samples) assert.equal(decodeLatex(encodeLatex(sample, dialect)), sample, `${dialect}: ${sample}`);
  }
});

test("protects internal capitals and acronyms for BibTeX titles", () => {
  assert.equal(isSelfProtectingWord("iPhone"), true);
  assert.equal(isSelfProtectingWord("DNA"), true);
  assert.equal(isSelfProtectingWord("Smith"), false);
  assert.equal(isSelfProtectingWord("A"), false);
  const cases: Array<[string, string]> = [
    ["The iPhone and DNA of COVID-19", "The {iPhone} and {DNA} of {COVID-19}"], ["A Simple Title", "A Simple Title"],
    [`In ${NOCASE("Bayesian")} Statistics`, "In {Bayesian} Statistics"], ["McDonald’s RNA-seq", String.raw`{McDonald’s} {RNA-seq}`],
    ["<i>E. coli</i> in the USA", String.raw`\textit{E. coli} in the {USA}`], ["The $O(N)$ Method", "The $O(N)$ Method"],
  ];
  for (const [input, expected] of cases) assert.equal(protectTitleCase(input, "biblatex"), expected, input);
  assert.equal(protectTitleCase("Über DNA", "bibtex"), String.raw`{\"U}ber {DNA}`);
  assert.equal(markCaseProtection("of DNA"), `of ${NOCASE("DNA")}`);
  // Protected words decode back to the original title.
  assert.equal(decodeLatex(protectTitleCase("The iPhone and DNA of COVID-19")), "The iPhone and DNA of COVID-19");
});

test("parses names in every BibTeX and RIS form", () => {
  const cases: Array<[string, CslName]> = [
    ["Smith, John", { family: "Smith", given: "John" }],
    ["John Smith", { family: "Smith", given: "John" }],
    ["J. R. R. Tolkien", { family: "Tolkien", given: "J. R. R." }],
    ["Smith, J.", { family: "Smith", given: "J." }],
    ["Plato", { family: "Plato" }],
    ["King, Jr, Martin Luther", { family: "King", given: "Martin Luther", suffix: "Jr" }],
    ["King, Martin Luther, Jr.", { family: "King", given: "Martin Luther", suffix: "Jr." }],
    ["King, Jr.", { family: "King", suffix: "Jr." }],
    ["Martin Luther King Jr.", { family: "King", given: "Martin Luther", suffix: "Jr." }],
    ["Henry Ford III", { family: "Ford", given: "Henry", suffix: "III" }],
    ["Gates, William, II", { family: "Gates", given: "William", suffix: "II" }],
    ["Ludwig van Beethoven", { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" }],
    ["van Beethoven, Ludwig", { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" }],
    ["van der Waals, J. D.", { family: "Waals", given: "J. D.", "non-dropping-particle": "van der" }],
    ["Johannes Diderik van der Waals", { family: "Waals", given: "Johannes Diderik", "non-dropping-particle": "van der" }],
    ["Jean de La Fontaine", { family: "La Fontaine", given: "Jean", "non-dropping-particle": "de" }],
    ["de la Cruz, Juan", { family: "Cruz", given: "Juan", "non-dropping-particle": "de la" }],
    ["Ursula von der Leyen", { family: "Leyen", given: "Ursula", "non-dropping-particle": "von der" }],
    ["Charles du Bois", { family: "Bois", given: "Charles", "non-dropping-particle": "du" }],
    ["Leonardo da Vinci", { family: "Vinci", given: "Leonardo", "non-dropping-particle": "da" }],
    ["Anna Di Lorenzo", { family: "Di Lorenzo", given: "Anna" }],
    ["Johannes Van Der Berg", { family: "Van Der Berg", given: "Johannes" }],
    ["Van Gogh, Vincent", { family: "Van Gogh", given: "Vincent" }],
    ["Ali al Hassan", { family: "Hassan", given: "Ali", "non-dropping-particle": "al" }],
    ["Mohammed bin Salman", { family: "Salman", given: "Mohammed", "non-dropping-particle": "bin" }],
    ["Ortega y Gasset, José", { family: "Ortega y Gasset", given: "José" }],
    ["Jean-Paul Sartre", { family: "Sartre", given: "Jean-Paul" }],
    ["World Health Organization", { literal: "World Health Organization" }],
    ["  Smith ,  Jane  ", { family: "Smith", given: "Jane" }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseName(input), expected, input);
});

test("parses BibTeX names with braces and LaTeX", () => {
  const cases: Array<[string, CslName]> = [
    ["{World Health Organization}", { literal: "World Health Organization" }],
    ["{Barnes and Noble, Inc.}", { literal: "Barnes and Noble, Inc." }],
    [String.raw`{\'E}mile Zola`, { family: "Zola", given: "Émile" }],
    [String.raw`M{\"u}ller, J{\"u}rgen`, { family: "Müller", given: "Jürgen" }],
    [String.raw`{van Gogh}, Vincent`, { family: "van Gogh", given: "Vincent" }],
    [String.raw`Charles Louis Xavier Joseph de~la Vall{\'e}e Poussin`, { family: "Vallée Poussin", given: "Charles Louis Xavier Joseph", "non-dropping-particle": "de la" }],
    [String.raw`{\L}ukasiewicz, Jan`, { family: "Łukasiewicz", given: "Jan" }],
    ["World Health Organization", { family: "Organization", given: "World Health" }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseName(input, { latex: true }), expected, input);
});

test("splits BibTeX name lists on top-level `and` and recognizes others", () => {
  assert.deepEqual(parseBibtexNameList("Smith, John and Doe, Jane"), { names: [{ family: "Smith", given: "John" }, { family: "Doe", given: "Jane" }], etAl: false });
  assert.deepEqual(parseBibtexNameList("A. Smith AND B. Jones and others"), { names: [{ family: "Smith", given: "A." }, { family: "Jones", given: "B." }], etAl: true });
  assert.deepEqual(parseBibtexNameList("{Barnes and Noble} and Smith, J."), { names: [{ literal: "Barnes and Noble" }, { family: "Smith", given: "J." }], etAl: false });
  assert.deepEqual(parseBibtexNameList("Alexander,\n  Brandon and\n  Cassandra Dee"), { names: [{ family: "Alexander", given: "Brandon" }, { family: "Dee", given: "Cassandra" }], etAl: false });
  assert.deepEqual(parseBibtexNameList("Anderson"), { names: [{ family: "Anderson" }], etAl: false });
  assert.deepEqual(parseBibtexNameList(""), { names: [], etAl: false });
});

test("parses RIS-style person lists", () => {
  assert.deepEqual(parsePersonList("Smith, John"), [{ family: "Smith", given: "John" }]);
  assert.deepEqual(parsePersonList("Smith, J.; Doe, Jane"), [{ family: "Smith", given: "J." }, { family: "Doe", given: "Jane" }]);
  assert.deepEqual(parsePersonList("Jane Doe and John Smith"), [{ family: "Doe", given: "Jane" }, { family: "Smith", given: "John" }]);
  assert.deepEqual(parsePersonList("Smith, John\nDoe, Jane"), [{ family: "Smith", given: "John" }, { family: "Doe", given: "Jane" }]);
  assert.deepEqual(parsePersonList("World Health Organization"), [{ literal: "World Health Organization" }]);
});

test("formats names for BibTeX and display, and BibTeX names parse back", () => {
  const names: CslName[] = [
    { family: "Smith", given: "John" }, { family: "Waals", given: "J. D.", "non-dropping-particle": "van der" },
    { family: "King", given: "Martin Luther", suffix: "Jr." }, { literal: "World Health Organization" },
    { family: "Müller", given: "Jürgen" }, { family: "van Gogh", given: "Vincent" }, { family: "Plato" },
    { family: "Ortega y Gasset", given: "José" }, { family: "Dvořák", given: "Antonín" },
  ];
  assert.equal(formatBibtexName(names[0]), "Smith, John");
  assert.equal(formatBibtexName(names[1]), "van der Waals, J. D.");
  assert.equal(formatBibtexName(names[2]), "King, Jr., Martin Luther");
  assert.equal(formatBibtexName(names[3]), "{World Health Organization}");
  assert.equal(formatBibtexName(names[4], "bibtex"), String.raw`M{\"u}ller, J{\"u}rgen`);
  assert.equal(formatBibtexName(names[5]), "{van Gogh}, Vincent");
  assert.equal(formatBibtexName({ family: "Barnes and Noble" }), "{Barnes and Noble}");
  for (const dialect of ["bibtex", "biblatex"] as const) {
    const text = names.map((name) => formatBibtexName(name, dialect)).join(" and ");
    assert.deepEqual(parseBibtexNameList(text).names, names, dialect);
  }
  assert.equal(formatNameForDisplay(names[1]), "J. D. van der Waals");
  assert.equal(formatNameForDisplay(names[2]), "Martin Luther King Jr.");
  assert.equal(formatNameForDisplay(names[1], { order: "family-first" }), "van der Waals, J. D.");
  assert.equal(formatNameForDisplay(names[3], { order: "family-first" }), "World Health Organization");
  assert.equal(formatNameForDisplay({ given: "Madonna" }), "Madonna");
});
