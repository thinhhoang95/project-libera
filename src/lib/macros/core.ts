/**
 * Primitives shared by the Markdown macros (src/lib/markdown-macros.ts) and
 * the LaTeX macros of the Visual mode (src/lib/latex/macros/). The two
 * engines have different semantics; only what is the same in both lives here.
 */

/** Nesting limit for expansions, so a macro that uses itself cannot hang. */
export const MAX_MACRO_DEPTH = 16;

/** `comments`: `%` starts a comment to the end of the line, as in TeX (not in Markdown). */
export type GroupReadOptions = { comments?: boolean };

/** Reads a `{…}` group at `index`; braces escaped with a backslash do not count. */
export function readGroup(source: string, index: number, options?: GroupReadOptions): { content: string; end: number } | null {
  if (source[index] !== "{") return null;
  const comments = !!options?.comments;
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (comments && char === "%") { const end = source.indexOf("\n", i); if (end < 0) return null; i = end; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { content: source.slice(index + 1, i), end: i + 1 };
  }
  return null;
}

/** Reads a `[…]` optional argument at `index`, with balanced braces inside. */
export function readOptional(source: string, index: number, options?: GroupReadOptions): { content: string; end: number } | null {
  if (source[index] !== "[") return null;
  const comments = !!options?.comments;
  let braces = 0;
  for (let i = index + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (comments && char === "%") { const end = source.indexOf("\n", i); if (end < 0) return null; i = end; continue; }
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "]" && braces <= 0) return { content: source.slice(index + 1, i), end: i + 1 };
  }
  return null;
}

/** Comment-aware readers for TeX source. */
export const TEX_GROUPS: GroupReadOptions = { comments: true };

/** A small, stable string hash (FNV-1a), for fingerprints of definitions. */
export function hashString(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
