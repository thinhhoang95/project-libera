/** Saved LaTeX snippets and the insert templates of the LaTeX toolbar. Pure
 * text helpers, shared by the editor, the toolbar and the tests. */

export type LatexSnippet = { id: string; name: string; body: string };

/** Removes the indentation the selected lines share, so a snippet saved from
 * inside an environment is stored flush left. `lineIndent` is the indentation
 * of the line where the selection starts, which may not be selected. */
export function snippetBodyFromSelection(text: string, lineIndent: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
  const common = Math.min(lineIndent.length, ...lines.slice(1).filter((line) => line.trim()).map(indentOf));
  return [lines[0].trimStart(), ...lines.slice(1).map((line) => line.slice(Math.min(common, indentOf(line))))]
    .join("\n")
    .replace(/^\n+|\s+$/g, "");
}

/** Indents every line after the first, to sit at the insertion point. */
export function indentSnippet(body: string, indent: string) {
  return indent ? body.split("\n").map((line, index) => (index && line ? indent + line : line)).join("\n") : body;
}

export function matchingSnippets(snippets: LatexSnippet[], query: string) {
  const normalized = query.toLocaleLowerCase();
  return snippets
    .filter((snippet) => snippet.name.toLocaleLowerCase().includes(normalized) || (normalized.length > 2 && snippet.body.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) =>
      Number(!left.name.toLocaleLowerCase().startsWith(normalized)) - Number(!right.name.toLocaleLowerCase().startsWith(normalized))
      || left.name.localeCompare(right.name));
}

/* ---- Packages ----------------------------------------------------------------- */

/** Blanks out comments, keeping every other character at its position. */
function stripComments(text: string) {
  return text.replace(/(^|[^\\])(%.*)$/gm, (_match, before: string, comment: string) => before + " ".repeat(comment.length));
}

export function preambleOf(doc: string) {
  const start = doc.search(/\\documentclass\b/);
  if (start < 0) return null;
  const end = doc.search(/\\begin\s*\{document\}/);
  return end < 0 ? null : { from: start, to: end };
}

export function usesPackage(doc: string, name: string) {
  const pattern = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (const match of stripComments(doc).matchAll(pattern)) {
    if (match[1].split(",").some((entry) => entry.trim() === name)) return true;
  }
  return false;
}

export type TextChange = { from: number; to?: number; insert: string };

/** Adds lines to the preamble: after its last `\usepackage`, or else after
 * `\documentclass`. Null when the document has no preamble (a chapter file). */
export function preambleInsertion(doc: string, lines: string[]): TextChange | null {
  const preamble = preambleOf(doc);
  if (!preamble) return null;
  const text = stripComments(doc.slice(preamble.from, preamble.to));
  let anchor = -1;
  for (const match of text.matchAll(/^.*\\(?:usepackage|RequirePackage)\b.*$/gm)) anchor = (match.index ?? 0) + match[0].trimEnd().length;
  if (anchor < 0) {
    const classLine = /^.*\\documentclass\b.*$/m.exec(text);
    anchor = classLine ? classLine.index + classLine[0].trimEnd().length : 0;
  }
  // Past the rest of the line, so a trailing comment stays where it was.
  const lineEnd = doc.indexOf("\n", preamble.from + anchor);
  return { from: lineEnd < 0 ? preamble.from + anchor : lineEnd, insert: lines.map((line) => `\n${line}`).join("") };
}

/** The packages the document does not load yet, and the change that loads
 * them (null when there is nothing to add or no preamble to add it to). */
export function packageInsertion(doc: string, packages: string[]) {
  const missing = [...new Set(packages)].filter((name) => !usesPackage(doc, name));
  return { missing, change: missing.length ? preambleInsertion(doc, missing.map((name) => `\\usepackage{${name}}`)) : null };
}

/* ---- Bibliography --------------------------------------------------------------- */

export type BibliographyStyle = { value: string; label: string; system: "bibtex" | "biblatex"; packages?: string[] };

export const BIBTEX_STYLES: BibliographyStyle[] = [
  { value: "plain", label: "Plain (numbered, sorted)", system: "bibtex" },
  { value: "unsrt", label: "Unsorted (order of citation)", system: "bibtex" },
  { value: "abbrv", label: "Abbreviated names", system: "bibtex" },
  { value: "alpha", label: "Alphabetic labels [Knu84]", system: "bibtex" },
  { value: "IEEEtran", label: "IEEE", system: "bibtex" },
  { value: "acm", label: "ACM", system: "bibtex" },
  { value: "siam", label: "SIAM", system: "bibtex" },
  { value: "apalike", label: "APA-like (author–year)", system: "bibtex" },
  { value: "plainnat", label: "natbib · plain (author–year)", system: "bibtex", packages: ["natbib"] },
  { value: "unsrtnat", label: "natbib · unsorted", system: "bibtex", packages: ["natbib"] },
  { value: "abbrvnat", label: "natbib · abbreviated", system: "bibtex", packages: ["natbib"] },
];

export const BIBLATEX_STYLES: BibliographyStyle[] = [
  { value: "numeric", label: "Numeric [1]", system: "biblatex" },
  { value: "numeric-comp", label: "Numeric, compressed [1–3]", system: "biblatex" },
  { value: "alphabetic", label: "Alphabetic [Knu84]", system: "biblatex" },
  { value: "authoryear", label: "Author–year (Knuth 1984)", system: "biblatex" },
  { value: "authortitle", label: "Author–title", system: "biblatex" },
  { value: "ieee", label: "IEEE", system: "biblatex" },
  { value: "apa", label: "APA 7th edition", system: "biblatex" },
  { value: "nature", label: "Nature", system: "biblatex" },
];

const BIBLATEX_PACKAGE = /\\usepackage\s*(\[([^\]]*)\])?\s*\{biblatex\}/;
const BIBTEX_STYLE = /\\bibliographystyle\s*\{([^}]*)\}/;

/** Which bibliography system the document uses, and its current style. */
export function readBibliographySetup(doc: string): { system: "bibtex" | "biblatex" | null; style: string | null } {
  const text = stripComments(doc);
  const biblatex = BIBLATEX_PACKAGE.exec(text);
  if (biblatex) {
    const options = biblatex[2] ?? "";
    const style = /(?:^|,)\s*(?:style|bibstyle)\s*=\s*([^,\s]+)/.exec(options)?.[1] ?? "numeric";
    return { system: "biblatex", style };
  }
  const bibtex = BIBTEX_STYLE.exec(text);
  if (bibtex) return { system: "bibtex", style: bibtex[1].trim() };
  if (/\\bibliography\s*\{/.test(text)) return { system: "bibtex", style: null };
  return { system: null, style: null };
}

/** Changes that switch the style in place, or null when the document has none
 * yet and a bibliography block has to be inserted. Positions refer to `doc`. */
export function restyleBibliography(doc: string, style: BibliographyStyle): TextChange[] | null {
  const masked = stripComments(doc);
  if (style.system === "biblatex") {
    const match = BIBLATEX_PACKAGE.exec(masked);
    if (!match) return null;
    const options = match[2] ?? "";
    const styleOption = /(^|,)(\s*)(style|bibstyle)(\s*=\s*)([^,\s]+)/.exec(options);
    if (styleOption) {
      const optionsFrom = match.index + match[0].indexOf("[") + 1;
      const valueFrom = optionsFrom + styleOption.index + styleOption[0].length - styleOption[5].length;
      return [{ from: valueFrom, to: valueFrom + styleOption[5].length, insert: style.value }];
    }
    if (match[1]) {
      const at = match.index + match[0].indexOf("[") + 1;
      return [{ from: at, insert: options.trim() ? `style=${style.value},` : `style=${style.value}` }];
    }
    const at = match.index + "\\usepackage".length;
    return [{ from: at, insert: `[style=${style.value}]` }];
  }
  const match = BIBTEX_STYLE.exec(masked);
  if (!match) {
    // A bibliography without a style gets one just before it.
    const bibliography = /\\bibliography\s*\{/.exec(masked);
    return bibliography ? [{ from: bibliography.index, insert: `\\bibliographystyle{${style.value}}\n` }] : null;
  }
  const from = match.index + match[0].indexOf("{") + 1;
  return [{ from, to: from + match[1].length, insert: style.value }];
}

/** What to insert at the cursor for a new bibliography in the given style. */
export function bibliographyBlock(style: BibliographyStyle, bibFile: string) {
  if (style.system === "biblatex") return "\\printbibliography";
  return `\\bibliographystyle{${style.value}}\n\\bibliography{${bibFile.replace(/\.bib$/i, "")}}`;
}

/* ---- Insert templates ----------------------------------------------------------- */
/* CodeMirror snippet templates: `${name}` fields are visited with Tab, `${}` is
 * where the cursor ends. A tab at the start of a line becomes one indent unit. */

/** Escapes text so a snippet template inserts it literally. */
export function literalField(text: string) {
  return text.replace(/[{}]/g, (brace) => `\\${brace}`);
}

function labelFromPath(path: string) {
  return path.split("/").at(-1)!.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "label";
}

export function figureTemplate(imagePath?: string) {
  const file = imagePath ? literalField(imagePath) : "file";
  return [
    "\\begin{figure}[htbp]",
    "\t\\centering",
    `\t\\includegraphics[width=\${0.8}\\linewidth]{\${${file}}}`,
    "\t\\caption{${Caption}}",
    `\t\\label{fig:\${${imagePath ? labelFromPath(imagePath) : "label"}}}`,
    "\\end{figure}",
    "${}",
  ].join("\n");
}

export function sideBySideTemplate(count: 2 | 3 = 2, images: string[] = []) {
  const width = count === 2 ? "0.48" : "0.31";
  const panels = Array.from({ length: count }, (_, index) => {
    const letter = "abc"[index];
    const image = images[index];
    return [
      `\t\\begin{subfigure}[t]{${width}\\linewidth}`,
      "\t\t\\centering",
      `\t\t\\includegraphics[width=\\linewidth]{\${${image ? literalField(image) : `file-${letter}`}}}`,
      `\t\t\\caption{\${Caption ${letter.toUpperCase()}}}`,
      `\t\t\\label{fig:\${${image ? labelFromPath(image) : `label-${letter}`}}}`,
      "\t\\end{subfigure}",
    ].join("\n");
  });
  return [
    "\\begin{figure}[htbp]",
    "\t\\centering",
    panels.join("\n\t\\hfill\n"),
    "\t\\caption{${Overall caption}}",
    "\t\\label{fig:${label}}",
    "\\end{figure}",
    "${}",
  ].join("\n");
}

export function tableTemplate(rows: number, columns: number) {
  // Header cells show placeholder names; body cells are empty tab stops.
  const header = Array.from({ length: columns }, (_, index) => `\${Header ${index + 1}}`).join(" & ");
  const cells = Array.from({ length: columns }, () => "${}").join(" & ");
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => `\t\t${cells} \\\\`);
  return [
    "\\begin{table}[htbp]",
    "\t\\centering",
    "\t\\caption{${Caption}}",
    "\t\\label{tab:${label}}",
    `\t\\begin{tabular}{${"l".repeat(columns)}}`,
    "\t\t\\toprule",
    `\t\t${header} \\\\`,
    "\t\t\\midrule",
    ...body,
    "\t\t\\bottomrule",
    "\t\\end{tabular}",
    "\\end{table}",
    "${}",
  ].join("\n");
}

export const CODE_LANGUAGES = ["Python", "C", "C++", "Java", "JavaScript", "R", "Matlab", "bash", "SQL", "HTML", "TeX"];

export function codeTemplate(kind: "verbatim" | "listing", selection: string, language?: string) {
  const content = selection ? literalField(selection.replace(/\s+$/, "")) : "${code}";
  if (kind === "verbatim") return `\\begin{verbatim}\n${content}\n\\end{verbatim}\n\${}`;
  const options = [language ? `language=${language}` : "", "caption={${Caption}}", "label={lst:${label}}"].filter(Boolean).join(", ");
  return `\\begin{lstlisting}[${options}]\n${content}\n\\end{lstlisting}\n\${}`;
}

/** Wraps the selection when there is one, so `${}` lands after it. */
export function environmentTemplate(name: string, selection: string, first = "") {
  const content = selection ? selection.split("\n").map((line) => `\t${literalField(line)}`).join("\n") : `\t${first}\${}`;
  return `\\begin{${name}}\n${content}\n\\end{${name}}`;
}

export function listTemplate(name: "itemize" | "enumerate" | "description", selection: string) {
  const label = name === "description" ? "[${term}] " : "";
  const items = selection.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!items.length) return `\\begin{${name}}\n\t\\item ${label}\${}\n\\end{${name}}`;
  return `\\begin{${name}}\n${items.map((line) => `\t\\item ${literalField(line.replace(/^([-*•]|\d+[.)])\s+/, ""))}`).join("\n")}\n\\end{${name}}\${}`;
}
