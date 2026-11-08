import type { EditorState } from "@codemirror/state";
import type { LatexAuxData } from "../../aux-file";
import type { LatexDefinitions } from "../../macros/definitions";
import { referenceText, type LabelTarget, type LatexNumbering } from "../../macros/numbering";
import { latexProjectField } from "../editing";
import { visualAux, visualDefinitions, visualNumbering } from "./model";
import { CONTROL_SYMBOLS, readAccent, SYMBOL_COMMANDS } from "./symbols";

/* What citation and reference chips say (docs/latex-visual-editor-plan.md §3). */

export type BibLookup = (key: string) => { author?: string; year?: string; title?: string } | null;

export function bibLookup(state: EditorState): BibLookup {
  const project = state.field(latexProjectField, false);
  return (key) => {
    const entry = project?.bibEntries.find((candidate) => candidate.key === key)
      ?? project?.libraryEntries?.find((candidate) => candidate.key === key || candidate.aliases.includes(key));
    return entry ? { author: entry.author, year: entry.year, title: entry.title } : null;
  };
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

/** The chip text of a citation: numbers from the `.aux` when the style is numeric, else author and year. */
export function citationText(parts: CitationParts, aux: LatexAuxData, bib: BibLookup) {
  const name = parts.command.replace(/^\\/, "").replace(/\*$/, "");
  const items = parts.keys.map((key) => {
    const compiled = aux.citations[key];
    const entry = bib(key);
    const rawAuthors = compiled?.authors ?? shortAuthors(entry?.author) ?? null;
    const authors = rawAuthors && plainTexText(rawAuthors);
    const year = compiled?.year ?? entry?.year ?? null;
    const numeric = compiled && /^\d+[a-z]?$/.test(compiled.label) ? compiled.label : null;
    return { key, authors, year, numeric };
  });
  const allNumeric = items.every((item) => item.numeric);
  const note = (text: string) => {
    const pre = parts.pre ? `${parts.pre} ` : "";
    const post = parts.post ? `, ${parts.post}` : "";
    return `${pre}${text}${post}`;
  };
  if (name === "citeauthor" || name === "Citeauthor") return items.map((item) => item.authors ?? item.key).join("; ");
  if (name === "citeyear" || name === "citeyearpar") return items.map((item) => item.year ?? item.key).join("; ");
  if (name === "nocite") return `(not cited: ${parts.keys.join(", ")})`;
  if (allNumeric && !/^(?:citet|textcite|Citet|Textcite)$/.test(name)) return `[${note(items.map((item) => item.numeric).join(", "))}]`;
  if (/^(?:citet|textcite|Citet|Textcite)$/.test(name)) {
    return items.map((item) => (item.authors ? `${item.authors} ${allNumeric ? `[${item.numeric}]` : `(${item.year ?? "n.d."})`}` : item.key)).join("; ");
  }
  const body = items.map((item) => (item.authors ? `${item.authors}${item.year ? ` ${item.year}` : ""}` : item.key)).join("; ");
  return `[${note(body)}]`;
}

/** Labels with their numbers: the numbering pass first, then the compiled `.aux` for labels in other files. */
export function labelTarget(key: string, numbering: LatexNumbering, aux: LatexAuxData): LabelTarget | null {
  const local = numbering.labels.get(key);
  if (local) return local;
  const compiled = aux.labels[key];
  if (!compiled) return null;
  const kind = /^(?:eq|equation)[:.-]/i.test(key) ? "equation" : /^(?:fig|figure)[:.-]/i.test(key) ? "figure" : /^(?:tab|table)[:.-]/i.test(key) ? "table" : "section";
  return { number: compiled.number, kind, pos: -1, title: compiled.title };
}

/** The chip text of a reference command and its keys. */
export function referenceChipText(command: string, keys: string[], numbering: LatexNumbering, aux: LatexAuxData, defs: LatexDefinitions) {
  const name = command.replace(/^\\/, "").replace(/\*$/, "");
  if (name === "pageref" || name === "vpageref") {
    return keys.map((key) => aux.labels[key]?.page ?? "?").join(", ");
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
export const REFERENCE_IN_MATH = /\\(?:eq|auto|Auto|c|C)?ref\b/;

/** A formula with its references written as their numbers, for KaTeX. */
export function withReferenceNumbers(latex: string, state: EditorState) {
  if (!REFERENCE_IN_MATH.test(latex)) return latex;
  return latex.replace(/\\(eq|auto|Auto|c|C)?ref\*?\s*\{([^{}]*)\}/g, (_, kind: string | undefined, keys: string) => {
    const text = stateReferenceText(state, `\\${kind ?? ""}ref`, keys.split(",").map((key) => key.trim()).filter(Boolean));
    return `\\text{${text.replace(/[\\{}_#%&$^~]/g, (char) => `\\${char}`)}}`;
  });
}
