import { serializeBibtex } from "./bibtex";
import { entryForKey } from "./format";
import { encodeLatex } from "./latex-text";
import type { Citation, CitationItem, CitationLocatorLabel, ReferenceEntry } from "./types";

// biblatex citations for the Markdown → LaTeX export (docs/references/plan.md
// §4.6 "Later"). With the export option "Citations: biblatex", each citation
// placeholder (latex-citations.ts) is restored as a biblatex command instead
// of formatted text, the cited entries are written to `<output>.bib`, the
// preamble loads biblatex with the style closest to the notebook's CSL style,
// and the PDF is built latex → biber → latex → latex (latex-export.ts).
//
// Mapping of the Libera citation syntax:
//   [@a]                 \parencite{a}
//   [see @a, p. 12]      \parencite[see][p.~12]{a}
//   [@a, p. 12]          \parencite[p.~12]{a}
//   [-@a]                \parencite*{a}           (suppress author)
//   @a (narrative)       \textcite{a}
//   [@a; @b]             \parencite{a,b}
//   [see @a, p. 1; @b, ch. 2]
//                        \parencites[see][p.~1]{a}[ch.~2]{b}
// Keys resolve through aliases to the entry's current key. Keys that are not
// in the library stay as their source text (`@key?`), as in the formatted path.

/** CSL style id → biblatex style, for the bundled styles. */
export const BIBLATEX_STYLE_FOR_CSL: Readonly<Record<string, string>> = {
  apa: "apa",
  ieee: "ieee",
  "chicago-author-date": "chicago-authordate",
  nature: "nature",
  vancouver: "vancouver",
  "harvard-cite-them-right": "authoryear",
};

/** The citation format a CSL style declares (`<category citation-format="…"/>`). */
export function cslCitationFormat(styleXml: string | null | undefined) {
  return /<category\b[^>]*\bcitation-format\s*=\s*["']([^"']+)["']/.exec(styleXml ?? "")?.[1] ?? null;
}

/** The generic biblatex style for a CSL style's class: numeric for numeric and label styles, authoryear otherwise. */
export function genericBiblatexStyle(styleXml: string | null | undefined) {
  const format = cslCitationFormat(styleXml);
  return format === "numeric" || format === "label" ? "numeric" : "authoryear";
}

/**
 * The biblatex style for a library's style setting: the mapped style of a
 * bundled CSL style, else the generic style for the CSL class.
 */
export function biblatexStyleFor(styleSetting: string | null | undefined, styleXml?: string | null) {
  const mapped = styleSetting ? BIBLATEX_STYLE_FOR_CSL[styleSetting] : undefined;
  return mapped ?? genericBiblatexStyle(styleXml);
}

const LABEL_ABBREVIATIONS: Partial<Record<CitationLocatorLabel, [string, string]>> = {
  page: ["p.", "pp."],
  chapter: ["ch.", "chs."],
  section: ["sec.", "secs."],
  figure: ["fig.", "figs."],
  table: ["tab.", "tabs."],
  equation: ["eq.", "eqs."],
  line: ["l.", "ll."],
  note: ["n.", "nn."],
  paragraph: ["para.", "paras."],
  volume: ["vol.", "vols."],
  book: ["bk.", "bks."],
  column: ["col.", "cols."],
  part: ["pt.", "pts."],
  verse: ["v.", "vv."],
  folio: ["fol.", "fols."],
  issue: ["no.", "nos."],
  supplement: ["suppl.", "suppls."],
  appendix: ["app.", "apps."],
};

const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** Note text for LaTeX: Markdown escapes removed, special characters escaped. */
function noteText(text: string) {
  const plain = text.replace(MARKDOWN_ESCAPE, "$1").replace(/\s+/g, " ").trim();
  return plain.split(/([$<>|])/).map((part) => {
    switch (part) {
      case "$": return "\\$";
      case "<": return "\\textless{}";
      case ">": return "\\textgreater{}";
      case "|": return "\\textbar{}";
      default: return part ? encodeLatex(part, "biblatex") : "";
    }
  }).join("");
}

/** `p.~12`, `pp.~12--14`, `ch.~3`; labels without a common abbreviation are written out. */
export function biblatexLocator(item: Pick<CitationItem, "locator" | "label">) {
  if (!item.locator) return "";
  const locator = noteText(item.locator).replace(/\s*[-–—]+\s*/g, "--");
  const label = item.label ?? "page";
  const plural = /--|,|&|\band\b/.test(locator);
  const names = LABEL_ABBREVIATIONS[label];
  const prefix = names ? names[plural ? 1 : 0] : label.replace(/-/g, " ");
  return `${prefix}~${locator}`;
}

/** The postnote: the locator, then the suffix ("p.~12, emphasis added"). */
export function biblatexPostnote(item: CitationItem) {
  const suffix = item.suffix ? noteText(item.suffix.replace(/^\s*,\s*/, "")) : "";
  return [biblatexLocator(item), suffix].filter(Boolean).join(", ");
}

export function biblatexPrenote(item: CitationItem) {
  return item.prefix ? noteText(item.prefix) : "";
}

/** An optional argument; braces keep a `]` in the note from ending it. */
function optional(text: string) {
  return /[\][]/.test(text) ? `[{${text}}]` : `[${text}]`;
}

/** `[pre][post]`, `[post]` or nothing. */
function notes(pre: string, post: string) {
  if (pre) return optional(pre) + optional(post);
  return post ? optional(post) : "";
}

type ResolvedItem = { item: CitationItem; key: string };

function command(narrative: boolean, star: boolean, multi: boolean) {
  return `\\${narrative ? "textcite" : "parencite"}${multi ? "s" : ""}${star ? "*" : ""}`;
}

/** One group of items that share the suppress-author flag, as one command. */
function groupCommand(items: ResolvedItem[], narrative: boolean, star: boolean): string {
  if (items.length === 1) {
    const [{ item, key }] = items;
    return `${command(narrative, star, false)}${notes(biblatexPrenote(item), biblatexPostnote(item))}{${key}}`;
  }
  // One command with all keys works when only the first item has a prenote and only the last a postnote.
  const inner = items.slice(1, -1);
  const simple = !biblatexPostnote(items[0].item) && !biblatexPrenote(items[items.length - 1].item)
    && inner.every(({ item }) => !biblatexPrenote(item) && !biblatexPostnote(item));
  if (simple) {
    const keys = [...new Set(items.map(({ key }) => key))].join(",");
    return `${command(narrative, star, false)}${notes(biblatexPrenote(items[0].item), biblatexPostnote(items[items.length - 1].item))}{${keys}}`;
  }
  // Multicite: per-item notes. The starred forms have no multicite variant, so star groups split.
  if (star) return items.map((resolved) => groupCommand([resolved], narrative, true)).join(" ");
  return command(narrative, false, true) + items.map(({ item, key }) => {
    const pre = biblatexPrenote(item);
    const post = biblatexPostnote(item);
    // In a multicite, an item with only a prenote still needs the empty postnote.
    return `${pre ? optional(pre) + optional(post) : post ? optional(post) : ""}{${key}}`;
  }).join("");
}

/**
 * A citation as biblatex commands. `entries` maps keys and aliases to
 * entries (citationEntriesForDocument). Unresolved keys are kept as
 * `@key?` text after the command.
 */
export function biblatexCitation(citation: Citation, entries: Record<string, ReferenceEntry>) {
  const resolved: ResolvedItem[] = [];
  const unresolved: string[] = [];
  for (const item of citation.items) {
    const entry = entryForKey(entries, item.key);
    if (entry) resolved.push({ item, key: entry.key });
    else if (!unresolved.includes(item.key)) unresolved.push(item.key);
  }
  const narrative = citation.narrative === true;
  // Consecutive items with the same suppress-author flag share a command.
  const groups: { star: boolean; items: ResolvedItem[] }[] = [];
  for (const item of resolved) {
    const star = item.item.suppressAuthor === true;
    const last = groups[groups.length - 1];
    if (last && last.star === star) last.items.push(item);
    else groups.push({ star, items: [item] });
  }
  const parts = groups.map((group) => groupCommand(group.items, narrative, group.star));
  if (unresolved.length) parts.push(noteText(unresolved.map((key) => `@${key}?`).join("; ")));
  return parts.join(" ");
}

/** The cited, resolved entries as a BibLaTeX file, in order of first citation. */
export function biblatexBibliography(citations: Citation[], entries: Record<string, ReferenceEntry>) {
  const cited: ReferenceEntry[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    for (const item of citation.items) {
      const entry = entryForKey(entries, item.key);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      cited.push(entry);
    }
  }
  return { entries: cited, text: cited.length ? `% Generated by Libera from the notebook's References.\n\n${serializeBibtex(cited, { dialect: "biblatex" })}` : "" };
}

/** The preamble lines that load biblatex with `style` and the export's `.bib` file. */
export function biblatexPreamble(style: string, bibFileName: string) {
  return [
    "\\usepackage{csquotes}",
    `\\usepackage[backend=biber,style=${style}]{biblatex}`,
    `\\addbibresource{${bibFileName}}`,
  ].join("\n");
}

/** Insert lines into a preamble just before `\begin{document}`; packages already loaded are skipped. */
export function addBiblatexPreamble(opening: string, preamble: string) {
  const at = opening.search(/\\begin\{document\}/);
  if (at < 0) return opening;
  const lines = preamble.split("\n").filter((line) => {
    const name = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/.exec(line)?.[1];
    return !name || !new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${name}\\b[^}]*\\}`).test(opening);
  });
  if (!lines.length) return opening;
  return `${opening.slice(0, at)}${lines.join("\n")}\n${opening.slice(at)}`;
}
