import { hasBalancedBraces, hasUnsafeTex } from "../latex-text";
import type { MarkdownPasteAnalysis } from "./analyze";
import { hasChapters, type LatexPasteContext } from "./context";
import { SECTION_COMMANDS, type HeadingTarget, type MarkdownPasteChoices, type MarkdownPasteOptions, type SectionCommand } from "./options";

/** The sectioning commands the document class has, in order (`\chapter` only where it exists). */
export function headingLadder(context: LatexPasteContext): SectionCommand[] {
  return SECTION_COMMANDS.filter((command) => command !== "chapter" || hasChapters(context));
}

/** One level below the section the cursor is in; without one, `\chapter` for book-like classes and `\section` otherwise. */
export function autoTopHeading(context: LatexPasteContext): SectionCommand {
  const ladder = headingLadder(context);
  if (context.sectionLevel === null) return hasChapters(context) && context.documentClass !== null ? "chapter" : "section";
  const below = ladder.find((command) => SECTION_COMMANDS.indexOf(command) > context.sectionLevel!);
  return below ?? "subparagraph";
}

/**
 * What each heading rank becomes when the top one becomes `top`: the next
 * ranks step down the class's ladder, and ranks past `\subparagraph` become
 * bold paragraphs. After a top that is not a sectioning command, the ranks
 * below continue from one below the automatic top.
 */
export function headingMapFor(top: MarkdownPasteOptions["headingTop"], ranks: number, context: LatexPasteContext): HeadingTarget[] {
  const ladder = headingLadder(context);
  const resolved: HeadingTarget = top === "auto" ? autoTopHeading(context) : top === "chapter" && !hasChapters(context) ? "section" : top;
  const map: HeadingTarget[] = [resolved];
  let index = ladder.indexOf(resolved as SectionCommand);
  if (index < 0) index = ladder.indexOf(autoTopHeading(context));
  for (let rank = 1; rank < ranks; rank++) map.push(ladder[index + rank] ?? "bold");
  return map.slice(0, Math.max(0, ranks));
}

export type HeadingTemplate = { template: string } | { error: string };

/**
 * A custom heading: a command name (`\frametitle`, `\section*`), written as
 * `\name{Title}`, or a one-line template with exactly one `#1`
 * (`\textbf{\large #1}\par`). Balanced, no environments, nothing unsafe.
 */
export function parseHeadingTemplate(input: string): HeadingTemplate {
  const text = input.trim();
  if (!text) return { error: "Enter a command such as \\frametitle, or a template with #1." };
  if (/^\\[A-Za-z@]+\*?$/.test(text)) {
    if (hasUnsafeTex(text) || /^\\(?:begin|end|item)\b/.test(text)) return { error: `${text} cannot be used for headings.` };
    return { template: `${text}{#1}` };
  }
  if (/\n/.test(text)) return { error: "The template must be one line." };
  // Exactly one parameter, #1: any other unescaped # would be a stray macro parameter.
  const parameters = text.match(/(?<!\\)#./g) ?? [];
  if (parameters.length !== 1 || parameters[0] !== "#1" || /(?<!\\)#$/.test(text)) return { error: "Use #1 exactly once, where the heading's text goes, and no other #." };
  if (!hasBalancedBraces(text.replace("#1", ""))) return { error: "The braces in the template do not balance." };
  if (/\\(?:begin|end)\b|(?<!\\)%/.test(text) || hasUnsafeTex(text)) return { error: "The template may not contain environments, comments, ^^ notation or commands that read files or define macros." };
  return { template: text };
}

/** The choices for one paste: the saved settings, the heading map for the levels present, and a caption per table. */
export function resolveChoices(options: MarkdownPasteOptions, analysis: MarkdownPasteAnalysis, context: LatexPasteContext): MarkdownPasteChoices {
  const ranks = analysis.headingDepths.length;
  return {
    ...options,
    headingLabels: options.headingLabels || analysis.internalLinks,
    headingMap: headingMapFor(options.headingTop, ranks, context),
    headingCustoms: Array.from({ length: ranks }, () => options.headingCustom),
    tables: analysis.tables.map((table) => ({ caption: options.tableCaptionFromText ? table.caption : "", label: "" })),
    addPackages: false,
  };
}
