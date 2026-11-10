const BEGIN_DOCUMENT = /\\begin\s*\{document\}/g;

/** Whether a `%` before `index` on its line comments it out (`\%` is a percent sign). */
function commentedOut(source: string, index: number) {
  for (let i = source.lastIndexOf("\n", index - 1) + 1; i < index; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "%") return true;
  }
  return false;
}

/**
 * The `\begin{document}` that starts the body: the first one outside a comment (AASTeX templates say "the
 * \begin{document} command" in a preamble comment). `index` is where it starts, `end` where the body starts.
 */
export function findBeginDocument(source: string): { index: number; end: number } | null {
  for (const match of source.matchAll(BEGIN_DOCUMENT)) {
    if (!commentedOut(source, match.index)) return { index: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Where `\begin{document}` starts, or -1 (like `String.search`). */
export function beginDocumentIndex(source: string) {
  return findBeginDocument(source)?.index ?? -1;
}
