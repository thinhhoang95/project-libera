import { readGroup } from "../macros/core";

/* Labels and citation labels from a compiled job's `.aux` file: the exact
 * numbers TeX gave them. The Visual mode uses them for labels defined in
 * other files of the project, numeric citations and page references
 * (docs/latex-visual-editor-plan.md §7.7). */

export type AuxLabel = { number: string; page?: string; title?: string };
export type AuxCitation = { label: string; year?: string; authors?: string };
export type LatexAuxData = { labels: Record<string, AuxLabel>; citations: Record<string, AuxCitation> };

export const EMPTY_AUX: LatexAuxData = { labels: {}, citations: {} };

/** The `{…}` groups that follow `index`, up to `count`. */
function groups(text: string, index: number, count: number) {
  const out: string[] = [];
  for (let i = index; out.length < count;) {
    while (text[i] === " ") i++;
    const group = readGroup(text, i);
    if (!group) break;
    out.push(group.content);
    i = group.end;
  }
  return out;
}

/** Text of a label number as TeX wrote it: `\relax`, protected spaces and braces removed. */
function clean(value: string) {
  return value.replace(/\\(?:relax|protect|nobreakspace|@\s*)\s*/g, "").replace(/\\ /g, " ").replace(/~/g, " ").replace(/[{}]/g, "").trim();
}

export function parseLatexAux(text: string): LatexAuxData {
  const labels: Record<string, AuxLabel> = {};
  const citations: Record<string, AuxCitation> = {};
  for (const match of text.matchAll(/\\newlabel\{([^}]*)\}/g)) {
    const key = match[1];
    // cleveref writes a second entry per label.
    if (key.endsWith("@cref")) continue;
    const [value] = groups(text, (match.index ?? 0) + match[0].length, 1);
    if (value === undefined) continue;
    const [number, page, title] = groups(value, 0, 3);
    if (number === undefined) continue;
    labels[key] = { number: clean(number), page: page !== undefined ? clean(page) : undefined, title: title !== undefined ? clean(title) : undefined };
  }
  for (const match of text.matchAll(/\\bibcite\{([^}]*)\}/g)) {
    const [value] = groups(text, (match.index ?? 0) + match[0].length, 1);
    if (value === undefined) continue;
    // natbib: {{number}{year}{{short authors}}{{long authors}}}
    const parts = groups(value, 0, 4);
    citations[match[1]] = parts.length ? { label: clean(parts[0]), year: parts[1] !== undefined ? clean(parts[1]) : undefined, authors: parts[2] !== undefined ? clean(parts[2]) : undefined } : { label: clean(value) };
  }
  return { labels, citations };
}
