import type { EditorState, Text } from "@codemirror/state";
import type { LatexAuxData } from "../../aux-file";
import type { LatexDefinitions } from "../../macros/definitions";
import { referenceText, type LabelTarget, type LatexNumbering } from "../../macros/numbering";
import { latexProjectField } from "../editing";
import { visualAux, visualDefinitions, visualNumbering } from "./model";
import { readGroup } from "../../../macros/core";
import { colorsForKatex } from "./math-render";
import { CONTROL_SYMBOLS, FONT_SWITCHES, LIGATURE_CHARS, readAccent, SIZE_COMMAND, SYMBOL_COMMANDS, TEXT_LIGATURES } from "./symbols";

/* What citation and reference chips say (docs/latex-visual-editor-plan.md §3). */

/**
 * `citeAuthor`, `label` and `number` come from a compiled bibliography (`.bbl`, `thebibliography`): what the citation
 * prints; `number` is the entry's place in it, which natbib's `numbers` option prints for an author–year `.bbl`.
 */
export type BibLookup = (key: string) => { author?: string; year?: string; title?: string; citeAuthor?: string; label?: string; number?: string } | null;

type ProjectBibEntry = NonNullable<ReturnType<typeof projectOf>>["bibEntries"][number];
const projectOf = (state: EditorState) => state.field(latexProjectField, false);
/** The project's entries by key, built once per list (a chip looks its keys up on every refresh). */
const bibIndexes = new WeakMap<readonly ProjectBibEntry[], Map<string, ProjectBibEntry[]>>();

export function bibLookup(state: EditorState): BibLookup {
  const project = projectOf(state);
  const list = project?.bibEntries ?? [];
  let index = bibIndexes.get(list);
  if (!index) {
    index = new Map();
    for (const entry of list) index.set(entry.key, [...(index.get(entry.key) ?? []), entry]);
    bibIndexes.set(list, index);
  }
  const entries = index;
  return (key) => {
    const matches = entries.get(key) ?? [];
    const entry = matches[0] ?? project?.libraryEntries?.find((candidate) => candidate.key === key || candidate.aliases.includes(key));
    if (!entry) return null;
    // A `.bib` entry comes first, but how the citation prints is the compiled bibliography's (a numeric `.bbl`'s [3]).
    const compiled = matches.find((candidate) => candidate.label !== undefined || candidate.citeAuthor !== undefined || candidate.number !== undefined);
    return {
      author: entry.author ?? compiled?.author, year: entry.year ?? compiled?.year, title: entry.title ?? compiled?.title,
      citeAuthor: compiled?.citeAuthor, label: compiled?.label, number: compiled?.number,
    };
  };
}

/** natbib's `numbers` (or `super`) option: citations print [3] whatever the bibliography gives. In its author–year mode `\cite` is `\citet`. */
export type CitationStyle = { numeric?: boolean; textualCite?: boolean; aliases?: ReadonlyMap<string, string> };

export function citationStyle(defs: LatexDefinitions): CitationStyle {
  const natbib = defs.packageOptions.get("natbib");
  if (natbib?.some((option) => option === "numbers" || option === "super")) return { numeric: true };
  return defs.packages.includes("natbib") ? { textualCite: true } : {};
}

/**
 * What the document says about its citations beyond the package options (cached per document version): natbib's
 * `\setcitestyle{numbers}`, `\defcitealias{key}{alias}`, and the keys of a `thebibliography` written in it.
 */
const documentCitations = new WeakMap<Text, { numbers: boolean; aliases: Map<string, string>; bibitems: Set<string> }>();
function citationsInDocument(doc: Text) {
  let found = documentCitations.get(doc);
  if (found) return found;
  const text = doc.sliceString(0, Math.min(doc.length, 400_000)).replace(/(^|[^\\])%[^\n]*/g, "$1");
  const aliases = new Map<string, string>();
  for (const match of text.matchAll(/\\defcitealias\s*\{([^{}]*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) aliases.set(match[1].trim(), match[2].trim());
  const bibitems = new Set<string>();
  for (const match of text.matchAll(/\\bibitem\s*(?:\[(?:[^\]{}]|\{[^{}]*\})*\])?\s*\{([^{}]*)\}/g)) bibitems.add(match[1].trim());
  const numbers = [...text.matchAll(/\\setcitestyle\s*\{([^{}]*)\}/g)].some((match) => /(?:^|,)\s*(?:numbers|super)\s*(?:,|$)/.test(match[1]));
  documentCitations.set(doc, found = { numbers, aliases, bibitems });
  return found;
}

/** How the document's citations print: its packages' options, then `\setcitestyle` and `\defcitealias` in it. */
export function citationStyleFor(state: EditorState): CitationStyle {
  const base = citationStyle(visualDefinitions(state));
  const found = citationsInDocument(state.doc);
  return { ...(found.numbers ? { numeric: true } : base), ...(found.aliases.size ? { aliases: found.aliases } : {}) };
}

/**
 * The keys of a citation that no bibliography data knows: not in the `.bib` files, the References library, the
 * compiled `.bbl` or `.aux`, nor a `\bibitem` in the document. Empty when there is no bibliography data at all (before
 * the `.bib` is read, nothing is called missing).
 */
export function missingCitationKeys(state: EditorState, keys: readonly string[]): string[] {
  const project = projectOf(state);
  const aux = visualAux(state);
  const found = citationsInDocument(state.doc);
  const anyData = !!project?.bibEntries.length || !!project?.libraryEntries?.length || Object.keys(aux.citations).length > 0 || found.bibitems.size > 0;
  if (!anyData) return [];
  const bib = bibLookup(state);
  return keys.filter((key) => !aux.citations[key] && !found.bibitems.has(key) && !bib(key));
}

/** A multicite (`\parencites[12]{a}[34]{b}`): each group's citation, in one pair of brackets when they all have them. */
export function multiCitationText(command: string, groups: ReadonlyArray<{ keys: string[]; notes: { pre?: string; post?: string } }>, aux: LatexAuxData, bib: BibLookup, style: CitationStyle = {}) {
  const single = command.replace(/s(\*?)$/, "$1");
  const texts = groups.map((group) => citationText({ command: single, keys: group.keys, ...group.notes }, aux, bib, style));
  return texts.every((text) => /^\[.*\]$/.test(text)) ? `[${texts.map((text) => text.slice(1, -1)).join("; ")}]` : texts.join("; ");
}

/** BibTeX or `.aux` text as it prints: accents (`Boli\'c`, `{\"o}`), escapes and symbols decoded, braces dropped. */
export function plainTexText(text: string) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "{" || char === "}") { i++; continue; }
    if (char === "~") { out += " "; i++; continue; }
    if (char !== "\\") { out += char; i++; continue; }
    const accent = readAccent(text.slice(i, i + 12));
    if (accent) { out += accent.char; i += accent.length; continue; }
    const command = /^\\(?:[A-Za-z]+ ?|.)/.exec(text.slice(i))?.[0] ?? "\\";
    const name = command.trimEnd();
    const symbol = CONTROL_SYMBOLS[name] ?? SYMBOL_COMMANDS[name];
    out += symbol ?? name;
    i += command.length;
  }
  return out;
}

/** Commands whose argument a citation note prints as its text (the chip is plain text, so the style is not kept). */
const NOTE_WRAPPERS = /^\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|textup|textsl|textmd|textnormal|mbox|text)$/;

/**
 * A citation note as it prints (`[\emph{inter alia}]` is "inter alia", `[{\rm I\hspace{-.01em}I}. 7.1]` is "II. 7.1"):
 * emphasis and font switches give their text, spacing commands are dropped, `~` is a space, simple formulas their
 * characters. Null when the note holds anything else: the citation then stays source.
 */
export function citationNoteText(note: string, depth = 0): string | null {
  if (depth > 8) return null;
  let out = "";
  for (let i = 0; i < note.length;) {
    const char = note[i];
    if (char === "{" || char === "}") { i++; continue; }
    if (char === "~") { out += " "; i++; continue; }
    if (char === "$") {
      const close = note.indexOf("$", i + 1);
      const math = close < 0 ? null : note.slice(i + 1, close);
      if (math === null || !/^[\w\s.,;:+\-=()<>/'|]*$/.test(math)) return null;
      out += math;
      i = close + 1;
      continue;
    }
    if (char !== "\\") {
      const next = note.slice(i).search(/[{}~$\\]/);
      const end = next < 0 ? note.length : i + next;
      out += note.slice(i, end).replace(TEXT_LIGATURES, (ligature) => LIGATURE_CHARS[ligature]);
      i = end;
      continue;
    }
    const accent = readAccent(note.slice(i, i + 12));
    if (accent) { out += accent.char; i += accent.length; continue; }
    const command = /^\\(?:[A-Za-z]+\*?|.)/.exec(note.slice(i))?.[0] ?? "\\";
    let after = i + command.length;
    const symbol = CONTROL_SYMBOLS[command] ?? SYMBOL_COMMANDS[command];
    if (symbol !== undefined) { out += symbol; i = after + (/[A-Za-z]$/.test(command) && note[after] === " " ? 1 : 0); continue; }
    if (FONT_SWITCHES[command] || SIZE_COMMAND.test(command)) { i = after + (note[after] === " " ? 1 : 0); continue; }
    while (note[after] === " ") after++;
    const group = readGroup(note, after);
    if (/^\\(?:hspace|hskip)\*?$/.test(command) && group) { i = group.end; continue; }
    if (NOTE_WRAPPERS.test(command) && group) {
      const inner = citationNoteText(group.content, depth + 1);
      if (inner === null) return null;
      out += inner;
      i = group.end;
      continue;
    }
    return null;
  }
  return out.replace(/\s+/g, " ");
}

/** "Vaswani et al.", "Vaswani and Shazeer", "Vaswani" from a BibTeX author list. */
export function shortAuthors(author: string | undefined) {
  if (!author) return null;
  const names = author.split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean);
  const surname = (name: string) => {
    const cleaned = name.replace(/[{}]/g, "");
    if (cleaned.includes(",")) return cleaned.split(",")[0].trim();
    const parts = cleaned.split(/\s+/);
    return parts[parts.length - 1];
  };
  if (!names.length) return null;
  if (names.length === 1) return surname(names[0]);
  if (names.length === 2 && !/^others$/i.test(names[1])) return `${surname(names[0])} and ${surname(names[1])}`;
  return `${surname(names[0])} et al.`;
}

export type CitationParts = { command: string; keys: string[]; pre?: string; post?: string };

/** Citations that name the authors in the text: natbib's `\citet`, biblatex's `\textcite`, apacite's `\citeA`. */
const TEXTUAL_CITATIONS = /^(?:citet|textcite|Citet|Textcite|citeA)$/;

/** The chip text of a citation: numbers from the `.aux` when the style is numeric, else author and year. */
export function citationText(parts: CitationParts, aux: LatexAuxData, bib: BibLookup, style: CitationStyle = {}) {
  const name = parts.command.replace(/^\\/, "").replace(/\*$/, "");
  const items = parts.keys.map((key) => {
    const compiled = aux.citations[key];
    const entry = bib(key);
    const rawAuthors = compiled?.authors ?? entry?.citeAuthor ?? shortAuthors(entry?.author) ?? null;
    const authors = rawAuthors && plainTexText(rawAuthors);
    const year = compiled?.year ?? entry?.year ?? null;
    // A numeric or alphabetic label: the last compile's, else a compiled bibliography's (`\bibitem{key}` in order).
    // natbib's author–year `.aux` numbers its entries too (`\bibcite{athey2019}{{13}{2019}{{Athey et~al.}}…}`, SDID):
    // the authors win there unless natbib was loaded with `numbers`.
    const numeric = compiled
      ? (/^\d+[a-z]?$/.test(compiled.label) && (style.numeric || !compiled.authors) ? compiled.label : null)
      : entry?.label && (style.numeric || !entry.citeAuthor) ? entry.label : style.numeric ? entry?.number ?? null : null;
    return { key, authors, year, numeric };
  });
  const allNumeric = items.every((item) => item.numeric);
  // Notes as they print: `p.~5` is "p. 5".
  const pre = parts.pre ? (citationNoteText(parts.pre) ?? plainTexText(parts.pre)).trim() : "";
  const post = parts.post ? (citationNoteText(parts.post) ?? plainTexText(parts.post)).trim() : "";
  const note = (text: string) => `${pre ? `${pre} ` : ""}${text}${post ? `, ${post}` : ""}`;
  if (name === "citeauthor" || name === "Citeauthor") return items.map((item) => item.authors ?? item.key).join("; ");
  // biblatex's `\citetitle` prints the entry's title; `\fullcite` the whole entry, roughly as the list gives it.
  if (name === "citetitle" || name === "Citetitle") return items.map((item) => { const title = bib(item.key)?.title; return title ? plainTexText(title) : item.key; }).join("; ");
  if (name === "fullcite" || name === "footfullcite") {
    return items.map((item) => {
      const entry = bib(item.key);
      const parts = [entry?.author ? plainTexText(entry.author.split(/\s+and\s+/).join(", ")) : item.authors, entry?.title && plainTexText(entry.title), item.year].filter(Boolean);
      return parts.length > 1 ? parts.join(". ") : item.key;
    }).join("; ");
  }
  // natbib's `\citetalias{key}` prints the alias `\defcitealias{key}{Paper I}` gave it; `\citepalias` in parentheses.
  if (name === "citetalias" || name === "citepalias") {
    const text = items.map((item) => style.aliases?.get(item.key) ?? item.key).join("; ");
    return name === "citepalias" ? `(${note(text)})` : text;
  }
  // The number alone: `\citenum` (natbib), revtex's `\onlinecite`, biblatex's `\supercite` (a superscript).
  if ((name === "citenum" || name === "supercite" || name === "onlinecite") && allNumeric) return note(items.map((item) => item.numeric).join(","));
  // natbib's `\citealp` and `\citealt`: the citation without its brackets.
  if ((name === "citealp" || name === "Citealp") && allNumeric) return note(items.map((item) => item.numeric).join(", "));
  if (/^[cC]ite(?:alp|alt)$/.test(name) && items.every((item) => item.authors)) {
    return note(items.map((item) => `${item.authors}${item.year ? ` ${item.year}` : ""}`).join("; "));
  }
  if (name === "citeyear" || name === "citeyearpar") return items.map((item) => item.year ?? item.key).join("; ");
  if (name === "nocite") return `(not cited: ${parts.keys.join(", ")})`;
  // natbib's `\cite` is `\citet` in its author–year mode, `\citep` with numbers.
  const textual = TEXTUAL_CITATIONS.test(name) || (name === "cite" && !!style.textualCite && !allNumeric);
  if (allNumeric && !textual) return `[${note(items.map((item) => item.numeric).join(", "))}]`;
  if (textual) {
    // The notes go inside the parentheses: `\citet[see][p.~5]{jon90}` is "Jones et al. (see 1990, p. 5)".
    return items.map((item, index) => {
      const inner = `${index === 0 && pre ? `${pre} ` : ""}${allNumeric ? item.numeric : item.year ?? "n.d."}${index === items.length - 1 && post ? `, ${post}` : ""}`;
      return item.authors ? `${item.authors} ${allNumeric ? `[${inner}]` : `(${inner})`}` : item.key;
    }).join("; ");
  }
  const body = items.map((item) => (item.authors ? `${item.authors}${item.year ? ` ${item.year}` : ""}` : item.key)).join("; ");
  return `[${note(body)}]`;
}

/**
 * Labels with their numbers: the numbering pass for labels in this file; for labels in other files, the compiled
 * `.aux` when there is one, else the numbers the numbering pass read from the other files (position -1).
 */
export function labelTarget(key: string, numbering: LatexNumbering, aux: LatexAuxData): LabelTarget | null {
  const local = numbering.labels.get(key);
  if (local && local.pos >= 0) return local;
  const compiled = aux.labels[key];
  if (!compiled) return local ?? null;
  const kind = /^(?:eq|equation)[:.-]/i.test(key) ? "equation" : /^(?:fig|figure)[:.-]/i.test(key) ? "figure" : /^(?:tab|table)[:.-]/i.test(key) ? "table" : "section";
  return { number: compiled.number, kind, pos: -1, title: compiled.title };
}

/** The chip text of a reference command and its keys. */
export function referenceChipText(command: string, keys: string[], numbering: LatexNumbering, aux: LatexAuxData, defs: LatexDefinitions) {
  const name = command.replace(/^\\/, "").replace(/\*$/, "");
  if (name === "pageref" || name === "vpageref") {
    return keys.map((key) => aux.labels[key]?.page ?? "?").join(", ");
  }
  // cleveref's `\cpageref{a,b}`: "pages 3 and 5", from the last compile.
  if (name === "cpageref" || name === "Cpageref") {
    const pages = keys.map((key) => aux.labels[key]?.page ?? "?");
    const list = pages.length > 2 ? `${pages.slice(0, -1).join(", ")} and ${pages.at(-1)}` : pages.join(" and ");
    return `${name[0] === "C" ? "P" : "p"}age${pages.length > 1 ? "s" : ""} ${list}`;
  }
  const targets = keys.map((key) => labelTarget(key, numbering, aux));
  if (targets.every((target) => target === null)) return keys.map((key) => `?${key}`).join(", ");
  return referenceText(command, targets, defs, keys);
}

/** Reference and citation text from an editor state. */
export function stateReferenceText(state: EditorState, command: string, keys: string[]) {
  return referenceChipText(command, keys, visualNumbering(state), visualAux(state), visualDefinitions(state));
}

/** Whether a formula refers to labels (`$\mathcal{L}_{\ref{eq:loss}}$`), whose numbers KaTeX cannot know. */
export const REFERENCE_IN_MATH = /\\(?:(?:eq|auto|Auto|c|C)?ref|cite[A-Za-z]*|[pP]arencite|[tT]extcite)\b/;

/** A citation in a formula (`$x \text{by \cite{knuth}}$`), which KaTeX does not know: its chip text, as text. */
const CITE_IN_MATH = /\\((?:[cC]ite[A-Za-z]*|[pP]arencite|[tT]extcite))\*?((?:\s*\[[^\]]*\]){0,2})\s*\{([^{}]*)\}/g;

/** A formula with its references and citations written as their numbers, for KaTeX. */
export function withReferenceNumbers(latex: string, state: EditorState) {
  const cited = !/\\(?:[cC]ite|[pP]arencite|[tT]extcite)/.test(latex) ? latex : latex.replace(CITE_IN_MATH, (_, name: string, optionals: string, keys: string) => {
    const notes = [...optionals.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]);
    const text = citationText({ command: `\\${name}`, keys: keys.split(",").map((key) => key.trim()).filter(Boolean), ...(notes.length > 1 ? { pre: notes[0] || undefined, post: notes[1] || undefined } : { post: notes[0] || undefined }) }, visualAux(state), bibLookup(state), citationStyleFor(state));
    return `\\text{${text.replace(/\\/g, "").replace(/[{}_#%&$^~]/g, (char) => `\\${char}`)}}`;
  });
  return referencesInMath(cited, visualNumbering(state), visualAux(state), visualDefinitions(state));
}

/** A formula with its references written as their numbers, from numbering, `.aux` and definitions (captions, cells). */
export function referencesInMath(latex: string, numbering: LatexNumbering, aux: LatexAuxData, defs: LatexDefinitions) {
  // The document's `\definecolor` names in the formula, as colours KaTeX takes.
  if (defs.colors.size) latex = colorsForKatex(latex, defs.colors);
  if (!REFERENCE_IN_MATH.test(latex)) return latex;
  return latex.replace(/\\(eq|auto|Auto|c|C)?ref\*?\s*\{([^{}]*)\}/g, (_, kind: string | undefined, keys: string) => {
    const text = referenceChipText(`\\${kind ?? ""}ref`, keys.split(",").map((key) => key.trim()).filter(Boolean), numbering, aux, defs);
    // A tag written in math (`\tag{$\mathcal{I}$}`) stays math.
    return text.split(/(\$[^$]+\$)/).map((part) => (/^\$[^$]+\$$/.test(part) ? `{${part.slice(1, -1)}}` : part ? `\\text{${part.replace(/[\\{}_#%&$^~]/g, (char) => `\\${char}`)}}` : "")).join("");
  });
}
