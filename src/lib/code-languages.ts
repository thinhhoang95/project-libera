import { HighlightStyle, LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";

/* Syntax highlighting for plain-text and code files comes from
 * @codemirror/language-data: ~150 language descriptions matched by file name,
 * each loaded on demand. The overrides below pick a language for common file
 * names it does not know, or knows ambiguously (".m", ".cfg", ".text"). */

/** Lower-cased extension or file name → language-data name; null for plain text. */
const OVERRIDES: Record<string, string | null> = {
  txt: null, text: null, log: null, csv: null, tsv: null,
  m: "Octave",
  cfg: "Properties files", conf: "Properties files",
  jsonc: "JSON", json5: "JSON", jsonl: "JSON", ndjson: "JSON", geojson: "JSON", ipynb: "JSON",
  mdx: "Markdown", qmd: "Markdown", rmd: "Markdown",
  bbl: "LaTeX", dtx: "LaTeX", ins: "LaTeX",
  csl: "XML",
  svelte: "HTML",
  zsh: "Shell", fish: "Shell",
  cu: "C++", cuh: "C++",
  pyi: "Python",
  fsx: "F#",
  dockerfile: "Dockerfile",
  latexmkrc: "Perl",
  gemfile: "Ruby", rakefile: "Ruby", vagrantfile: "Ruby",
  jenkinsfile: "Groovy",
};

function overrideKey(fileName: string) {
  const name = fileName.split("/").pop()?.toLowerCase() ?? "";
  if (Object.hasOwn(OVERRIDES, name)) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

export function findCodeLanguage(fileName: string): LanguageDescription | null {
  const key = overrideKey(fileName);
  if (Object.hasOwn(OVERRIDES, key)) {
    const name = OVERRIDES[key];
    return name ? LanguageDescription.matchLanguageName(languages, name, false) : null;
  }
  return LanguageDescription.matchFilename(languages, fileName.split("/").pop() ?? fileName);
}

/** The language's display name, for the status bar. */
export function codeLanguageName(fileName: string) {
  return findCodeLanguage(fileName)?.name ?? "Plain text";
}

export async function loadCodeLanguage(fileName: string): Promise<LanguageSupport | null> {
  const description = findCodeLanguage(fileName);
  if (!description) return null;
  try {
    return await description.load();
  } catch {
    return null;
  }
}

/** Colors come from the same theme tokens as the LaTeX editor (--latex-*). */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.docComment], color: "var(--latex-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operatorKeyword, tags.modifier, tags.self], color: "var(--latex-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.character, tags.docString], color: "var(--latex-label)" },
  { tag: [tags.regexp, tags.escape], color: "var(--latex-math-delimiter)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "var(--latex-number)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "var(--latex-command)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: "var(--latex-environment)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--latex-math-command)" },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: "var(--foreground)", fontWeight: "600" },
  { tag: [tags.tagName, tags.heading], color: "var(--latex-heading)", fontWeight: "600" },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.documentMeta], color: "var(--latex-math-delimiter)" },
  { tag: [tags.operator, tags.derefOperator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator], color: "var(--latex-operator)" },
  { tag: [tags.bracket, tags.angleBracket, tags.squareBracket, tags.brace, tags.paren], color: "var(--latex-bracket)" },
  { tag: [tags.link, tags.url], color: "var(--latex-command)", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.inserted, color: "var(--latex-math)" },
  { tag: [tags.deleted, tags.invalid], color: "var(--destructive)" },
  { tag: tags.changed, color: "var(--latex-warning)" },
  { tag: tags.monospace, color: "var(--latex-verbatim)" },
]);
