/**
 * Primitives shared by the Markdown macros (src/lib/markdown-macros.ts) and
 * the LaTeX macros of the Visual mode (src/lib/latex/macros/). The two
 * engines have different semantics; only what is the same in both lives here.
 */

/** Nesting limit for expansions, so a macro that uses itself cannot hang. */
export const MAX_MACRO_DEPTH = 16;

/** Reads a `{…}` group at `index`; braces escaped with a backslash do not count. */
export function readGroup(source: string, index: number): { content: string; end: number } | null {
  if (source[index] !== "{") return null;
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { content: source.slice(index + 1, i), end: i + 1 };
  }
  return null;
}

/** Reads a `[…]` optional argument at `index`, with balanced braces inside. */
export function readOptional(source: string, index: number): { content: string; end: number } | null {
  if (source[index] !== "[") return null;
  let braces = 0;
  for (let i = index + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "]" && braces <= 0) return { content: source.slice(index + 1, i), end: i + 1 };
  }
  return null;
}

/** A small, stable string hash (FNV-1a), for fingerprints of definitions. */
export function hashString(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
