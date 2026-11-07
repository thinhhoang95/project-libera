// The parser module of codemirror-lang-latex (pinned in package.json). It is
// imported directly, not through the package root, so the package's linter,
// completion and data tables stay out of the bundle (latex-language.ts).
declare module "codemirror-lang-latex/src/latex.mjs" {
  import type { LRParser } from "@lezer/lr";
  export const parser: LRParser;
}
