import type { Text } from "@codemirror/state";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";

/**
 * A file that is all preamble: the "shared information" file a root `\input`s before its `\begin{document}` (SIAM's
 * `ex_shared.tex`, arXiv 2611.09593: packages, theorem styles, `\ifpdf … \fi`, `\headers`, `\title`, `\author`). Opened on its
 * own it has no `\begin{document}`, so it would read as a body; it is folded as a preamble is.
 */
const DECLARATIONS = /^(?:usepackage|RequirePackage|newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|newtheorem|theoremstyle|newsiam[A-Za-z]*|DeclareMathOperator|DeclareGraphicsExtensions|graphicspath|newif|newcounter|setlength|definecolor|crefname|Crefname|hypersetup|numberwithin|headers|title|author|date)$/;
/** What it may hold with no argument: TeX conditionals and `@` switches. */
const BARE = /^(?:ifpdf|else|fi|makeatletter|makeatother)$/;
/** The title block's own commands: the file carries class front matter, which only a preamble holds (a plain macros file is left as it is). */
const FRONT_MATTER = /^(?:headers|title|author|date)$/;
const DEFINITIONS = /^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef)$/;

const cache = new WeakMap<Text, boolean>();

/** Whether `doc` is a preamble fragment: only declarations, at least one of them a title-block command. */
export function isPreambleFragment(doc: Text) {
  let cached = cache.get(doc);
  if (cached === undefined) cache.set(doc, cached = scan(doc.length > 60_000 ? "" : doc.toString()));
  return cached;
}

function scan(text: string) {
  let frontMatter = false;
  let declarations = 0;
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "%") { const eol = text.indexOf("\n", i); i = eol < 0 ? text.length : eol + 1; continue; }
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    if (!command) return false;
    const name = command[1];
    i += command[0].length;
    if (BARE.test(name)) continue;
    if (!DECLARATIONS.test(name)) return false;
    declarations++;
    if (FRONT_MATTER.test(name)) frontMatter = true;
    // `\newcommand\x[1]{…}`, `\def\x#1{…}`: the name and parameters before the body.
    if (DEFINITIONS.test(name)) i += /^\s*\\[A-Za-z@]+(?:#\d)*/.exec(text.slice(i, i + 80))?.[0].length ?? 0;
    for (;;) {
      const blank = /^[ \t]*(?:\r?\n[ \t]*)?/.exec(text.slice(i, i + 200))![0].length;
      const at = i + blank;
      const group = text[at] === "[" ? readOptional(text, at, TEX_GROUPS) : text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
      if (!group) break;
      i = group.end;
    }
  }
  return frontMatter && declarations > 1;
}
