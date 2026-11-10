// The parser module of codemirror-lang-latex (pinned in package.json). It is
// imported directly, not through the package root, so the package's linter,
// completion and data tables stay out of the bundle (latex-language.ts).
declare module "codemirror-lang-latex/src/latex.mjs" {
  import type { LRParser } from "@lezer/lr";
  export const parser: LRParser;
}
// Its tokenizers, so one can be replaced (latex-parser.ts).
declare module "codemirror-lang-latex/src/tokens.mjs" {
  import type { ExternalTokenizer } from "@lezer/lr";
  export const literalArgTokenizer: ExternalTokenizer;
  export const specializeCtrlSeq: (name: string, stack: unknown) => number;
  export const specializeEnvName: (name: string, terms: unknown) => number;
}
// KaTeX's mhchem extension (`\ce`, `\pu`), loaded on first use (visual/math-render.ts): it registers its macros on import.
declare module "katex/contrib/mhchem";
