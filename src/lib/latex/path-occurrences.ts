// Where a LaTeX source names a file, with the offsets of each name, for the
// rewrite of a move (lib/move-rewrites.ts). The commands and patterns are the
// ones the dependency reader reads (latex/dependencies.ts, readLatexIncludes
// in latex/root.ts, readLatexBibliographyReferences in latex/project.ts);
// `\import` and `\subimport` (a folder and a name) are left out.
// Pure: the app applies the same rewrite to unsaved text.

export type LatexPathKind = "latex-include" | "latex-graphics" | "latex-pdf" | "latex-listing" | "latex-bibliography" | "latex-bibresource";

export type LatexPathOccurrence = { kind: LatexPathKind; written: string; start: number; end: number };

/** Comments replaced by spaces, so offsets stay the source's (stripLatexComments, latex/project.ts, removes them). */
export function blankLatexComments(source: string) {
  return source.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, (match: string, before: string, slashes: string) =>
    `${before}${slashes}${" ".repeat(match.length - before.length - slashes.length)}`);
}

const PATTERNS: [LatexPathKind, RegExp][] = [
  ["latex-include", /\\(?:input|include|subfile)\s*\{([^}]+)\}/g],
  ["latex-graphics", /\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g],
  ["latex-pdf", /\\includepdf\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g],
  ["latex-listing", /\\lstinputlisting\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g],
  ["latex-bibresource", /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g],
];

/** A braced argument's text without the spaces around it, as the readers trim it. */
function trimmed(kind: LatexPathKind, value: string, offset: number): LatexPathOccurrence | null {
  const start = offset + (value.length - value.trimStart().length);
  const written = value.trim();
  return written ? { kind, written, start, end: start + written.length } : null;
}

/** Every file name a LaTeX source writes in a command the dependency reader reads, in source order. */
export function latexPathOccurrences(source: string): LatexPathOccurrence[] {
  const text = blankLatexComments(source);
  const found: LatexPathOccurrence[] = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // The argument is the last braced group of the match.
      const occurrence = trimmed(kind, match[1], match.index! + match[0].length - 1 - match[1].length);
      if (occurrence) found.push(occurrence);
    }
  }
  for (const match of text.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) {
    let offset = match.index! + match[0].length - 1 - match[1].length;
    for (const name of match[1].split(",")) {
      const occurrence = trimmed("latex-bibliography", name, offset);
      if (occurrence) found.push(occurrence);
      offset += name.length + 1;
    }
  }
  return found.sort((left, right) => left.start - right.start);
}
