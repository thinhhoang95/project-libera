import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { renderKatex } from "./math-render";

/* Bibliography entries written as markup (audit round 8): the `.bbl` files of BibTeX styles that wrap every field in a
 * command (REVTeX's `\bibinfo{author}{…}`, cond-mat 2611.17927) and the classes' own bibliography commands (EPL's
 * `\Name{…} \REVIEW{…}`, q-bio 2610.35161). A command is rewritten to the plain LaTeX it prints, and an entry is drawn
 * only when nothing is left that the text renderer does not know. */

type Rule = { args: number; make: (args: string[]) => string };

const same = (name: string): Rule => ({ args: 1, make: ([a]) => `\\${name}{${a}}` });

/** What REVTeX's `apsrev4-2.bst` writes, as the text it prints. */
const REVTEX_RULES: Record<string, Rule> = {
  bibinfo: { args: 2, make: ([, text]) => text },
  bibfield: { args: 2, make: ([, text]) => text },
  "href@noop": { args: 2, make: ([, text]) => text },
  BibitemOpen: { args: 0, make: () => "" },
  BibitemShut: { args: 1, make: () => "" },
  bibnamefont: { args: 1, make: ([a]) => a },
  bibfnamefont: { args: 1, make: ([a]) => a },
  citenamefont: { args: 1, make: ([a]) => a },
  natexlab: { args: 1, make: ([a]) => a },
  selectlanguage: { args: 1, make: () => "" },
  enquote: { args: 1, make: ([a]) => `“${a}”` },
  translation: { args: 1, make: ([a]) => `[${a}]` },
  Eprint: { args: 2, make: ([url, text]) => `\\href{${url}}{${text}}` },
  href: { args: 2, make: ([url, text]) => `\\href{${url}}{${text}}` },
  url: same("url"),
  emph: same("emph"), textbf: same("textbf"), textit: same("textit"), textsc: same("textsc"), textrm: same("textrm"), textsl: same("textsl"), texttt: same("texttt"),
};

/** EPL's bibliography commands (`epl2.cls`: `\Name` is the authors in small capitals, `\REVIEW{journal}{volume}{year}{page}` "journal, volume (year) page"). */
const EPL_RULES: Record<string, Rule> = {
  Name: { args: 1, make: ([names]) => `\\textsc{${names}},` },
  and: { args: 0, make: () => " and " },
  REVIEW: { args: 4, make: ([journal, volume, year, page]) => `\\textit{${journal}}, \\textbf{${volume}} (${year}) ${page}` },
};

/**
 * `text` with each command of `rules` replaced by what it prints, its arguments (groups, spaces between them allowed, as TeX
 * reads them) rewritten first; null when a command lacks its arguments.
 */
function rewrite(text: string, rules: Record<string, Rule>): string | null {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "%") {
      // A comment: to the end of the line, and the spaces that start the next one.
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      while (text[i] === " " || text[i] === "\t") i++;
      continue;
    }
    if (char !== "\\") { out += char; i++; continue; }
    const name = /^\\([A-Za-z@]+)/.exec(text.slice(i, i + 40));
    if (!name || !Object.hasOwn(rules, name[1])) {
      // Another command, or `\ `, `\&`, `\'`: copied with the character it escapes.
      out += name ? name[0] : text.slice(i, i + 2);
      i += name ? name[0].length : 2;
      continue;
    }
    const rule = rules[name[1]];
    i += name[0].length;
    const args: string[] = [];
    for (let n = 0; n < rule.args; n++) {
      while (/\s/.test(text[i] ?? "")) i++;
      const group = readGroup(text, i, TEX_GROUPS);
      if (!group) return null;
      const inner = rewrite(group.content, rules);
      if (inner === null) return null;
      args.push(inner);
      i = group.end;
    }
    out += rule.make(args);
    // TeX skips the spaces after a control word; the rule's output carries its own.
    if (rule.args === 0) while (text[i] === " " || text[i] === "\t") i++;
  }
  return out;
}

/** Commands the text renderer draws (or that a rewritten entry may still hold): any other command makes the entry source. */
const DRAWN = /^(?:emph|textbf|textit|textsc|textrm|textsl|texttt|href|url|ss|o|O|ae|AE|oe|OE|aa|AA|l|L|i|j|c|v|u|H|k|r|d|t|newblock)$/;

/** The LaTeX an entry holds once its bibliography markup is rewritten; null when something it uses is not understood. */
function finish(text: string | null): string | null {
  if (text === null) return null;
  const tidy = text.replace(/[ \t]*\n[ \t]*/g, " ").replace(/ {2,}/g, " ").trim();
  // A formula in the entry (`{SU(3)}$\times${SU(3)}`) is drawn when KaTeX reads it as it is.
  let formulas = true;
  const outside = tidy.replace(/\$([^$]*)\$/g, (_, formula: string) => { if (!renderKatex(formula, false)) formulas = false; return " "; });
  if (!formulas) return null;
  for (const match of outside.matchAll(/\\([A-Za-z@]+)/g)) if (!DRAWN.test(match[1])) return null;
  // (`\href{…}{…}` alone prints its text: what stays between braces is read by the renderer.)
  return tidy || null;
}

/** The markup of REVTeX's `.bbl` entries. */
export const REVTEX_ENTRY = /\\(?:bibinfo|bibfield|BibitemOpen|BibitemShut)(?![A-Za-z@])/;

/** A REVTeX `.bbl` entry's body (after `\bibitem[…]{key}`) as LaTeX the renderer draws; null when it is not understood. */
export function revtexEntryLatex(body: string): string | null {
  return finish(rewrite(body, REVTEX_RULES));
}

/** EPL's `\Name{A \and B}` as LaTeX; null when it is not understood. */
export function eplNameLatex(source: string): string | null {
  return finish(rewrite(source, EPL_RULES));
}

/** EPL's `\REVIEW{journal}{volume}{year}{page}` as LaTeX; null when it is not understood. */
export function eplReviewLatex(source: string): string | null {
  return finish(rewrite(source, EPL_RULES));
}

/** Where the use of `\name` with `count` arguments at `at` ends (spaces between arguments allowed); null when it lacks one. */
export function commandUseEnd(text: string, at: number, name: string, count: number): number | null {
  if (!text.startsWith(`\\${name}`, at)) return null;
  let i = at + name.length + 1;
  for (let n = 0; n < count; n++) {
    while (/\s/.test(text[i] ?? "")) i++;
    const group = readGroup(text, i, TEX_GROUPS);
    if (!group) return null;
    i = group.end;
  }
  return i;
}

/**
 * `\bibitem [label] {key}` at `at` as REVTeX writes it (spaces and a line end between the parts): where it ends, the
 * label and the key; null when it is not one.
 */
export function readBibitemHead(text: string, at: number): { end: number; label: string | null; key: string } | null {
  const command = /^\\bibitem(?![A-Za-z@])/.exec(text.slice(at, at + 20));
  if (!command) return null;
  let i = at + command[0].length;
  const gap = () => { while (/\s/.test(text[i] ?? "")) i++; };
  gap();
  let label: string | null = null;
  if (text[i] === "[") {
    const optional = readOptional(text, i, TEX_GROUPS);
    if (!optional) return null;
    label = optional.content;
    i = optional.end;
    gap();
  }
  const key = readGroup(text, i, TEX_GROUPS);
  return key ? { end: key.end, label, key: key.content.trim() } : null;
}
