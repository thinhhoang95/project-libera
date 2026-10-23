import { citationFrontMatterEnd, resolvedCitationOccurrences, scanCitations } from "./citation-syntax";

// Where a document cites an entry: each citation of one of its keys, with
// the text around it, for the reference card's "Cited in" list. Offsets are
// UTF-16 offsets into the Markdown source, like scanCitations'.

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

/** Every citation in `markdown` that cites one of `keys` (matched case-insensitively). Narrative `@key`s count. */
export function citationSnippets(markdown: string, keys: readonly string[], contextLength = SNIPPET_CONTEXT): CitationSnippet[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  if (!wanted.size) return [];
  const occurrences = resolvedCitationOccurrences(scanCitations(markdown), (key) => wanted.has(key.toLowerCase()));
  // Context never reaches back into the front matter.
  const bodyStart = citationFrontMatterEnd(markdown);
  const snippets: CitationSnippet[] = [];
  let line = 1;
  let counted = 0;
  for (const { citation, start, end } of occurrences) {
    if (!citation.items.some((item) => wanted.has(item.key.toLowerCase()))) continue;
    for (let index = counted; index < start; index += 1) if (markdown.charCodeAt(index) === 10) line += 1;
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
