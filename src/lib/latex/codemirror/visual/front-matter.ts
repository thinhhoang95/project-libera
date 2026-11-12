import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { isInLatexComment } from "../../macros/definitions";

/* What publishers' title blocks print besides the title and the authors' names: each author's affiliations, emails
 * and notes (revtex, acmart, elsarticle), the numbered institutes under the authors (llncs, svjour3), a subtitle and
 * small lines (a preprint number, PACS codes, corresponding-author and title notes). Read from the same commands by
 * the walk (what the block draws) and by title-edit.ts (where each line is written, to edit it in place), so the
 * lines are found in one order by both. Only the argument of a command is edited, never the command. */

export type SourceSpan = { from: number; to: number };
/** A line of the block: a plain label ("Email: "), its LaTeX, and where that LaTeX is written (null: not editable). */
export type FrontLine = { label: string; latex: string; source: SourceSpan | null };
export type FrontDetails = {
  subtitle: FrontLine | null;
  /** Lines under each author, by the author's place in the block (the authors split at `\and`). */
  authorLines: FrontLine[][];
  /** Lines after the authors (llncs's institutes, numbered as `\inst{1}` refers to them). */
  places: FrontLine[];
  /** Small lines after the abstract (a preprint number, PACS codes, notes). */
  notes: FrontLine[];
};
/** The same, as the widget keeps it: whether a line can be edited, not where it is (positions change with every edit). */
export type FrontDetailsView = {
  subtitle: FrontLineView | null; authorLines: FrontLineView[][]; places: FrontLineView[]; notes: FrontLineView[];
};
export type FrontLineView = { label: string; latex: string; editable: boolean };

const REVTEX = /^revtex4(?:-[12])?$/;
const ACMART = /^acmart$/;
// A&A's `aa` numbers its institutes as llncs does (`\institute{A \and B}`, `\inst{1}`).
const LLNCS = /^(?:llncs|svjour3?|svmult|aa)$/;
const ELSARTICLE = /^elsarticle$/;
const SNJNL = /^sn-jnl$/;
// Elsevier's CAS classes (cas-sc, cas-dc): elsarticle's commands with the address as `organization={…}, city={…}` keys.
const CAS = /^cas-[sd]c$/;
// The Logical Methods in Computer Science class: `\author[Short]{Name}[a]`, then an `\address` and `\email` per mark.
const LMCS = /^lmcs$/;
// IEEE Open Journal of Control Systems: `\author{Name\affilmark{1,2}}`, `\affil{…}` numbered by their order.
const OJCSYS = /^IEEEojcsys$/;

type Use = { name: string; optional: string | null; arg: SourceSpan & { latex: string }; at: number };

/** Each `\name[…]{…}` of `names` in `text` (outside comments), in order, with its last `{…}` argument at document positions. */
function uses(text: string, offset: number, names: string[]): Use[] {
  const found: Use[] = [];
  const pattern = new RegExp(`\\\\(${names.join("|")})(?![A-Za-z@])\\*?`, "g");
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isInLatexComment(text, index)) continue;
    // A definition of the command (`\renewcommand{\email}[1]{…}`) is not a use of it.
    if (/\\(?:(?:re|provide|new)command\*?|def|let)\s*\{?\s*$/.test(text.slice(Math.max(0, index - 30), index))) continue;
    let at = index + match[0].length;
    let optional: string | null = null;
    let arg: Use["arg"] | null = null;
    for (;;) {
      const space = /^[ \t]*\n?[ \t]*/.exec(text.slice(at, at + 80))![0];
      const next = at + space.length;
      if (text[next] === "[" && !arg) {
        const group = readOptional(text, next, TEX_GROUPS);
        if (!group) break;
        optional ??= group.content;
        at = group.end;
        continue;
      }
      if (text[next] !== "{" || arg) break;
      const group = readGroup(text, next, TEX_GROUPS);
      if (!group) break;
      arg = { latex: group.content, from: offset + next + 1, to: offset + group.end - 1 };
      at = group.end;
    }
    if (arg) found.push({ name: match[1], optional, arg, at: index });
  }
  return found;
}

/** A span without the spaces at its ends, with its LaTeX. */
function trimmedLine(label: string, latex: string, from: number): FrontLine {
  const start = latex.length - latex.trimStart().length;
  const text = latex.trim();
  return { label, latex: text, source: { from: from + start, to: from + start + text.length } };
}

/** An argument split at `\and` (an author list, llncs's institutes), as lines; empty pieces are dropped. */
function andPieces(arg: Use["arg"]): Array<{ latex: string; from: number }> {
  const pieces: Array<{ latex: string; from: number }> = [];
  let start = 0;
  const push = (end: number) => { if (arg.latex.slice(start, end).trim()) pieces.push({ latex: arg.latex.slice(start, end), from: arg.from + start }); };
  for (const match of arg.latex.matchAll(/\\(?:and|And|AND)(?![A-Za-z])/g)) {
    push(match.index ?? 0);
    start = (match.index ?? 0) + match[0].length;
  }
  push(arg.latex.length);
  return pieces;
}

/** acmart's `\affiliation{\institution{…}\city{…}\country{…}}` as the line it prints ("University A, Paris, France"). */
function acmAffiliation(latex: string) {
  const parts = /^\s*(?:\\(?:institution|department|streetaddress|city|state|country|postcode|orgdiv|orgname)\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*|%[^\n]*\n\s*)+$/.test(latex)
    ? [...latex.matchAll(/\\(?:institution|department|streetaddress|city|state|country|postcode|orgdiv|orgname)\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((match) => match[1].trim()).filter(Boolean)
    : null;
  return parts ? parts.join(", ") : latex.trim();
}

/** Elsevier CAS's `organization={…}, city={…}, country={…}` as the line it prints; null when it is not key-value. */
function casAffiliation(latex: string): string | null {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < latex.length; i++) {
    if (latex[i] === "\\") { i++; continue; }
    if (latex[i] === "{") depth++;
    else if (latex[i] === "}") depth--;
    else if (latex[i] === "," && depth === 0) { pieces.push(latex.slice(start, i)); start = i + 1; }
  }
  pieces.push(latex.slice(start));
  const values: string[] = [];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const match = /^\s*[A-Za-z]+\s*=\s*([\s\S]*?)\s*$/.exec(piece);
    if (!match) return null;
    values.push(match[1].replace(/^\{([\s\S]*)\}$/, "$1").trim());
  }
  return values.length ? values.join(", ") : null;
}

/**
 * The lines a class adds to its title block, from the commands in `text` (document positions from `offset`), for a
 * block that draws `authorCount` authors. Null for a class without them, or when the commands cannot be matched to
 * the drawn authors (the block then shows what it showed before).
 */
export function frontMatterDetails(text: string, offset: number, documentClass: string, authorCount: number, frontmatterEnv = false): FrontDetails | null {
  const details: FrontDetails = { subtitle: null, authorLines: Array.from({ length: authorCount }, () => []), places: [], notes: [] };
  const authorIndices = (use: Use) => andPieces(use.arg).length;
  if (REVTEX.test(documentClass)) {
    // revtex: an `\affiliation` belongs to every author since the last one; `\email`, `\homepage`, `\altaffiliation`
    // and `\thanks` to the last author.
    let author = -1;
    let group: number[] = [];
    let afterAffiliation = false;
    for (const use of uses(text, offset, ["author", "affiliation", "altaffiliation", "email", "homepage", "thanks", "collaboration", "preprint", "pacs"])) {
      if (use.name === "author") {
        if (afterAffiliation) { group = []; afterAffiliation = false; }
        for (let k = authorIndices(use); k > 0; k--) group.push(++author);
        continue;
      }
      if (use.name === "preprint") { details.notes.push(trimmedLine("Preprint: ", use.arg.latex, use.arg.from)); continue; }
      if (use.name === "pacs") { details.notes.push(trimmedLine("PACS: ", use.arg.latex, use.arg.from)); continue; }
      if (use.name === "collaboration") { details.notes.push(trimmedLine("Collaboration: ", use.arg.latex, use.arg.from)); continue; }
      // A `\thanks` in the title is the title's footnote.
      if (use.name === "thanks" && author < 0) continue;
      if (author < 0 || author >= authorCount) return null;
      if (use.name === "affiliation") {
        for (const index of group) details.authorLines[index].push(trimmedLine("", use.arg.latex, use.arg.from));
        afterAffiliation = true;
      } else {
        // `\altaffiliation{Also at …}` prints its argument as written.
        const label = use.name === "email" ? "Email: " : use.name === "homepage" ? "URL: " : "";
        details.authorLines[author].push(trimmedLine(label, use.arg.latex, use.arg.from));
      }
    }
    return author + 1 === authorCount ? details : null;
  }
  if (ACMART.test(documentClass)) {
    let author = -1;
    for (const use of uses(text, offset, ["author", "affiliation", "additionalaffiliation", "email", "orcid", "authornote", "subtitle"])) {
      if (use.name === "author") { author += authorIndices(use); continue; }
      if (use.name === "subtitle") { details.subtitle = trimmedLine("", use.arg.latex, use.arg.from); continue; }
      if (author < 0 || author >= authorCount) return null;
      const line = trimmedLine(use.name === "email" ? "Email: " : use.name === "orcid" ? "ORCID: " : use.name === "authornote" ? "Note: " : "", use.arg.latex, use.arg.from);
      if (use.name === "affiliation" || use.name === "additionalaffiliation") line.latex = acmAffiliation(line.latex);
      details.authorLines[author].push(line);
    }
    return author + 1 === authorCount ? details : null;
  }
  if (LLNCS.test(documentClass)) {
    // llncs and Springer's svjour3: the institutes, split at `\and`, numbered as `\inst{1}` refers to them.
    for (const use of uses(text, offset, ["institute", "subtitle"])) {
      if (use.name === "subtitle") { details.subtitle = trimmedLine("", use.arg.latex, use.arg.from); continue; }
      details.places = andPieces(use.arg).map((piece, index) => trimmedLine(`${index + 1} `, piece.latex, piece.from));
    }
    return details;
  }
  if ((ELSARTICLE.test(documentClass) && frontmatterEnv) || SNJNL.test(documentClass) || CAS.test(documentClass)) {
    // elsarticle: `\author[a,b]{…}` takes the addresses labelled a and b (one unlabelled address is everyone's);
    // `\ead{…}` is the last author's email; `\cortext`, `\tnotetext` and `\fntext` are notes. Springer Nature's sn-jnl
    // does the same with `\author*[1,2]{…}`, `\affil[1]{…}` and `\email{…}`.
    const all = uses(text, offset, ["author", "address", "affiliation", "affil", "ead", "email", "cortext", "tnotetext", "fntext"]);
    const addresses = new Map<string, FrontLine>();
    const unlabelled: FrontLine[] = [];
    for (const use of all) {
      if (use.name !== "address" && use.name !== "affiliation" && use.name !== "affil") continue;
      const line = trimmedLine("", use.arg.latex, use.arg.from);
      if (CAS.test(documentClass)) {
        // The key-value address is printed as one line, so its text is not the argument: a click shows the source.
        const printed = casAffiliation(line.latex);
        if (printed !== null) { line.latex = printed; line.source = null; }
      }
      if (use.optional?.trim()) addresses.set(use.optional.trim(), line);
      else unlabelled.push(line);
    }
    let author = -1;
    for (const use of all) {
      if (use.name === "author") {
        const count = authorIndices(use);
        const labels = (use.optional ?? "").split(",").map((label) => label.trim()).filter(Boolean);
        for (let k = 0; k < count; k++) {
          if (++author >= authorCount) return null;
          for (const label of labels) { const line = addresses.get(label); if (line) details.authorLines[author].push(line); }
          if (!labels.length && unlabelled.length === 1) details.authorLines[author].push(unlabelled[0]);
        }
      } else if (use.name === "ead" || use.name === "email") {
        if (author < 0) return null;
        details.authorLines[author].push(trimmedLine(/url/i.test(use.optional ?? "") ? "URL: " : "Email: ", use.arg.latex, use.arg.from));
      } else if (use.name === "cortext") details.notes.push(trimmedLine("∗ ", use.arg.latex, use.arg.from));
      else if (use.name === "tnotetext") details.notes.push(trimmedLine("☆ ", use.arg.latex, use.arg.from));
      else if (use.name === "fntext") details.notes.push(trimmedLine("", use.arg.latex, use.arg.from));
    }
    if (author + 1 !== authorCount) return null;
    // Several unlabelled addresses (one per author group): listed after the authors.
    if (unlabelled.length > 1) details.places = unlabelled;
    return details;
  }
  if (LMCS.test(documentClass)) {
    // `\author[Short]{Name}[a]` takes the address and email of the group marked `a`; the `\address`es (each with the `\email`
    // after it) are the groups a, b, c in order.
    const all = uses(text, offset, ["author", "address", "email"]);
    const groups: FrontLine[][] = [];
    for (const use of all) {
      if (use.name === "address") groups.push([trimmedLine("", use.arg.latex, use.arg.from)]);
      else if (use.name === "email") { if (!groups.length) return null; groups.at(-1)!.push(trimmedLine("Email: ", use.arg.latex, use.arg.from)); }
    }
    let author = -1;
    for (const use of all) {
      if (use.name !== "author") continue;
      const mark = /^\s*\[([A-Za-z])\]/.exec(text.slice(use.arg.to - offset + 1, use.arg.to - offset + 20))?.[1].toLowerCase();
      const group = mark ? groups[mark.charCodeAt(0) - 97] : undefined;
      for (let k = authorIndices(use); k > 0; k--) {
        if (++author >= authorCount) return null;
        if (group) details.authorLines[author].push(...group);
      }
    }
    return author + 1 === authorCount ? details : null;
  }
  if (OJCSYS.test(documentClass)) {
    // `\affil{…}` are numbered in order, the number each author's `\affilmark{1,2}` gives; `\authornote` is a note.
    const all = uses(text, offset, ["author", "affil", "authornote"]);
    const places = all.filter((use) => use.name === "affil").map((use) => trimmedLine("", use.arg.latex, use.arg.from));
    let author = -1;
    for (const use of all) {
      if (use.name === "authornote") { details.notes.push(trimmedLine("Note: ", use.arg.latex, use.arg.from)); continue; }
      if (use.name !== "author") continue;
      const labels = [...use.arg.latex.matchAll(/\\affilmark\s*\{([^{}]*)\}/g)].flatMap((match) => match[1].split(",").map((label) => label.trim()));
      for (let k = authorIndices(use); k > 0; k--) {
        if (++author >= authorCount) return null;
        for (const label of labels) { const place = places[Number(label) - 1]; if (place) details.authorLines[author].push(place); }
      }
    }
    return author + 1 === authorCount ? details : null;
  }
  // AAAI's `\affiliations{…}` (aaai25.sty, in the article class): its lines after the authors.
  const affiliations = uses(text, offset, ["affiliations"]).at(-1);
  if (affiliations) {
    details.places = [trimmedLine("", affiliations.arg.latex, affiliations.arg.from)];
    return details;
  }
  return null;
}

/** The lines that can be edited, in the one order the widget and the editor number them. */
export function editableLines<T extends { source: SourceSpan | null } | { editable: boolean }>(details: { subtitle: T | null; authorLines: T[][]; places: T[]; notes: T[] }): T[] {
  return [details.subtitle, ...details.authorLines.flat(), ...details.places, ...details.notes].filter((line): line is T => !!line && ("editable" in line ? line.editable : !!line.source));
}

/** The details as the widget keeps them. */
export function detailsView(details: FrontDetails | null): FrontDetailsView | null {
  if (!details) return null;
  const view = (line: FrontLine): FrontLineView => ({ label: line.label, latex: line.latex, editable: !!line.source });
  const result = { subtitle: details.subtitle && view(details.subtitle), authorLines: details.authorLines.map((lines) => lines.map(view)), places: details.places.map(view), notes: details.notes.map(view) };
  return result.subtitle || result.authorLines.some((lines) => lines.length) || result.places.length || result.notes.length ? result : null;
}
