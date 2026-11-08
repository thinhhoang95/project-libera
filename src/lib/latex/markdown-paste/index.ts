import type { MathMarkerSettings } from "@/lib/math-markers";
import { collectStructure, summarizeStructure, type MarkdownPasteAnalysis, type MarkdownStructure } from "./analyze";
import { resolveChoices } from "./choices";
import { createPasteContext, type LatexPasteContext } from "./context";
import { MarkdownLatexConverter, type ConvertResult } from "./convert";
import { DEFAULT_MARKDOWN_PASTE_OPTIONS, type MarkdownPasteChoices, type MarkdownPasteOptions } from "./options";
import { htmlToMarkdownTree } from "./html";
import { parseMarkdown, type ParsedMarkdown } from "./parse";

/* Pasting Markdown as LaTeX (docs/latex-markdown-paste-plan.md). Pure: the
 * editor parses once (`prepareMarkdownPaste`), shows the analysis in the
 * dialog, and converts again for every change of an option. */

export type PreparedMarkdownPaste = {
  parsed: ParsedMarkdown;
  structure: MarkdownStructure;
  analysis: MarkdownPasteAnalysis;
};

export function prepareMarkdownPaste(markdown: string, mathMarkers?: MathMarkerSettings): PreparedMarkdownPaste {
  const parsed = parseMarkdown(markdown, mathMarkers);
  const structure = collectStructure(parsed);
  return { parsed, structure, analysis: summarizeStructure(structure) };
}

/** Clipboard HTML (Word, Google Docs, a web page) prepared like Markdown, or null when its plain text should be pasted. */
export function prepareHtmlPaste(html: string): PreparedMarkdownPaste | null {
  const tree = htmlToMarkdownTree(html);
  if (!tree) return null;
  const parsed: ParsedMarkdown = { tree: tree as unknown as ParsedMarkdown["tree"], source: "" };
  const structure = collectStructure(parsed);
  return { parsed, structure, analysis: summarizeStructure(structure) };
}

export function convertPreparedMarkdown(prepared: PreparedMarkdownPaste, choices: MarkdownPasteChoices, context: LatexPasteContext): ConvertResult {
  return new MarkdownLatexConverter(prepared.parsed, prepared.structure, choices, context).convert();
}

/** Markdown as LaTeX with saved (or default) settings, for a paste that needs no dialog and for tests. */
export function markdownToLatex(
  markdown: string,
  options: Partial<MarkdownPasteOptions> = {},
  context: LatexPasteContext = createPasteContext(),
  overrides: Partial<MarkdownPasteChoices> = {},
  mathMarkers?: MathMarkerSettings,
): ConvertResult & { analysis: MarkdownPasteAnalysis } {
  const prepared = prepareMarkdownPaste(markdown, mathMarkers);
  const choices = { ...resolveChoices({ ...DEFAULT_MARKDOWN_PASTE_OPTIONS, ...options }, prepared.analysis, context), ...overrides };
  return { ...convertPreparedMarkdown(prepared, choices, context), analysis: prepared.analysis };
}

export { scoreMarkdown, looksLikeMarkdown } from "./detect";
export { createPasteContext, readPreambleInfo, sectionBefore, hasChapters, isTwoColumn, bibliographyDialect, type LatexPasteContext } from "./context";
export { resolveChoices, headingMapFor, headingLadder, autoTopHeading, parseHeadingTemplate } from "./choices";
export type { MarkdownPasteAnalysis } from "./analyze";
export type { ConvertResult, RequiredPackage, PasteWarning } from "./convert";
export * from "./options";
