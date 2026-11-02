import { citationFrontMatterEnd, resolvedCitationOccurrences, scanCitations } from "./citation-syntax";
import { isLatexCitingPath, latexCitedKeys, scanLatexCitations } from "./latex-cite-syntax";

// Where a document cites an entry: each citation of one of its keys, with
// the text around it, for the reference card's "Cited in" list. Offsets are
// UTF-16 offsets into the Markdown or LaTeX source, like scanCitations'.

export type CitationSnippet = {
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  before: string;
  match: string;
  after: string;
};

export const SNIPPET_CONTEXT = 70;

/** Text on one side of a citation, cut at a paragraph break and at about `length` characters, with whitespace collapsed. */
function context(text: string, length: number, side: "before" | "after") {
  const paragraph = side === "before" ? text.split(/\n\s*\n/).at(-1) ?? "" : text.split(/\n\s*\n/)[0] ?? "";
  const flat = paragraph.replace(/\s+/g, " ");
  if (flat.length <= length) return side === "before" ? flat.trimStart() : flat.trimEnd();
  if (side === "before") {
    const cut = flat.slice(-length);
    const space = cut.indexOf(" ");
    return `…${space > 0 && space < 20 ? cut.slice(space + 1) : cut}`;
  }
  const cut = flat.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${space > length - 20 ? cut.slice(0, space) : cut}…`;
}

export type CitationSyntax = "markdown" | "latex";

/** The citation syntax of a library-relative document path. */
export function citationSyntaxForPath(path: string): CitationSyntax {
  return isLatexCitingPath(path) ? "latex" : "markdown";
}

/** Every citation in `markdown` (or LaTeX source) that cites one of `keys` (matched case-insensitively). Narrative `@key`s count. */
export function citationSnippets(markdown: string, keys: readonly string[], contextLength = SNIPPET_CONTEXT, syntax: CitationSyntax = "markdown"): CitationSnippet[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  if (!wanted.size) return [];
  const occurrences = syntax === "latex"
    ? scanLatexCitations(markdown).filter((citation) => citation.keys.some((key) => wanted.has(key.toLowerCase())))
    : resolvedCitationOccurrences(scanCitations(markdown), (key) => wanted.has(key.toLowerCase()))
      .filter(({ citation }) => citation.items.some((item) => wanted.has(item.key.toLowerCase())));
  // Context never reaches back into the front matter.
  const bodyStart = syntax === "latex" ? 0 : citationFrontMatterEnd(markdown);
  const snippets: CitationSnippet[] = [];
  let line = 1;
  let counted = 0;
  for (const { start, end } of occurrences) {
    for (let index = counted; index < start; index += 1) {
      if (markdown[index] === "\n" || (markdown[index] === "\r" && markdown[index + 1] !== "\n")) line += 1;
    }
    counted = start;
    snippets.push({
      start,
      end,
      line,
      before: context(markdown.slice(Math.max(bodyStart, start - contextLength * 3), start), contextLength, "before"),
      match: markdown.slice(start, end),
      after: context(markdown.slice(end, end + contextLength * 3), contextLength, "after"),
    });
  }
  return snippets;
}

/** Re-find a snippet in the live editor: its draft may have changed since the card loaded it. */
export function relocateLatexCitation(source: string, snippet: CitationSnippet): CitationSnippet | null {
  const candidates = citationSnippets(source, latexCitedKeys(snippet.match), SNIPPET_CONTEXT, "latex");
  const score = (candidate: CitationSnippet) => Number(candidate.match === snippet.match)
    + Number(Boolean(snippet.before) && candidate.before === snippet.before) * 2
    + Number(Boolean(snippet.after) && candidate.after === snippet.after) * 2;
  candidates.sort((a, b) => score(b) - score(a) || Math.abs(a.start - snippet.start) - Math.abs(b.start - snippet.start));
  return candidates.length && score(candidates[0]) ? candidates[0] : null;
}
