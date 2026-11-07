import { foldService, indentNodeProp, indentUnit, LRLanguage, syntaxHighlighting, type TreeIndentContext } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { styleTags, tags } from "@lezer/highlight";
// The parser module itself: the package root would also bundle its linter,
// completion, tooltips and data tables, none of which Libera uses.
import { parser } from "codemirror-lang-latex/src/latex.mjs";
import { bibtexLanguage, latexFoldRange, latexHighlightStyle, latexLanguage as streamLatexLanguage } from "./language";

/* `.tex` files are parsed by codemirror-lang-latex (AGPL-3.0-or-later, based
 * on Overleaf's Lezer grammar), giving one syntax tree for the source
 * highlighting and the Visual mode (docs/latex-visual-editor-plan.md §2). The
 * style tags map its nodes onto the tags `latexHighlightStyle` already
 * colours, so Source mode looks as it did with the stream tokenizer. */

const KEYWORD_CTRL_SEQS = [
  "Begin", "End", "DocumentClassCtrlSeq", "UsePackageCtrlSeq", "InputCtrlSeq", "IncludeCtrlSeq", "SubfileCtrlSeq",
  "ItemCtrlSeq", "NewCommandCtrlSeq", "RenewCommandCtrlSeq", "NewEnvironmentCtrlSeq", "RenewEnvironmentCtrlSeq",
  "DefCtrlSeq", "LetCtrlSeq", "MaketitleCtrlSeq", "BibliographyCtrlSeq", "BibliographyStyleCtrlSeq", "CaptionCtrlSeq",
  "CenteringCtrlSeq", "NewTheoremCtrlSeq", "TheoremStyleCtrlSeq", "TitleCtrlSeq", "BookCtrlSeq", "PartCtrlSeq",
  "ChapterCtrlSeq", "SectionCtrlSeq", "SubSectionCtrlSeq", "SubSubSectionCtrlSeq", "ParagraphCtrlSeq", "SubParagraphCtrlSeq",
];

const COMMAND_CTRL_SEQS = [
  "CtrlSeq", "RefCtrlSeq", "RefStarrableCtrlSeq", "CiteCtrlSeq", "CiteStarrableCtrlSeq", "LabelCtrlSeq", "MathTextCtrlSeq",
  "HboxCtrlSeq", "HrefCtrlSeq", "UrlCtrlSeq", "VerbCtrlSeq", "LstInlineCtrlSeq", "IncludeGraphicsCtrlSeq", "IncludeSvgCtrlSeq",
  "LeftCtrlSeq", "RightCtrlSeq", "AuthorCtrlSeq", "AffilCtrlSeq", "AffiliationCtrlSeq", "DateCtrlSeq", "TextColorCtrlSeq",
  "ColorBoxCtrlSeq", "HLineCtrlSeq", "TopRuleCtrlSeq", "MidRuleCtrlSeq", "BottomRuleCtrlSeq", "MultiColumnCtrlSeq",
  "ParBoxCtrlSeq", "TextBoldCtrlSeq", "TextItalicCtrlSeq", "TextSmallCapsCtrlSeq", "TextTeletypeCtrlSeq", "TextMediumCtrlSeq",
  "TextSansSerifCtrlSeq", "TextSuperscriptCtrlSeq", "TextSubscriptCtrlSeq", "TextStrikeOutCtrlSeq", "EmphasisCtrlSeq",
  "UnderlineCtrlSeq", "SetLengthCtrlSeq", "FootnoteCtrlSeq", "EndnoteCtrlSeq", "LiteralArgContent", "Csname",
];

const ENV_NAMES = [
  "EnvName", "DocumentEnvName", "TabularEnvName", "EquationEnvName", "EquationArrayEnvName", "VerbatimEnvName",
  "TikzPictureEnvName", "FigureEnvName", "ListEnvName", "TableEnvName",
];

export const latexStyleTags = styleTags({
  Comment: tags.comment,
  [KEYWORD_CTRL_SEQS.join(" ")]: tags.keyword,
  [COMMAND_CTRL_SEQS.join(" ")]: tags.macroName,
  [ENV_NAMES.join(" ")]: tags.className,
  "CtrlSym KnownCtrlSym OpenParenCtrlSym CloseParenCtrlSym OpenBracketCtrlSym CloseBracketCtrlSym": tags.escape,
  "LineBreakCtrlSym LineBreak/...": tags.operator,
  "SectioningArgument/... Title/TextArgument/...": tags.heading,
  "LabelArgument/... RefArgument/... BibKeyArgument/...": tags.labelName,
  "OpenBrace CloseBrace": tags.brace,
  "OpenBracket CloseBracket": tags.squareBracket,
  "Ampersand Tilde": tags.operator,
  "VerbatimContent VerbContent LstInlineContent TikzPictureContent": tags.content,
  // Math: delimiters, then everything inside.
  "Dollar OpenBracketMath CloseBracketMath OpenParenMath CloseParenMath": tags.processingInstruction,
  "Math/...": tags.special(tags.variableName),
  "MathChar": tags.special(tags.variableName),
  "Number": tags.number,
  "MathSpecialChar Math/Ampersand": tags.operator,
  "MathCommand/MathUnknownCommand/CtrlSeq MathCommand/MathUnknownCommand/CtrlSym MathOpening MathClosing MathDelimiter": tags.special(tags.macroName),
});

const ENVIRONMENT_NODES = [
  "Environment", "TabularEnvironment", "EquationEnvironment", "EquationArrayEnvironment", "VerbatimEnvironment",
  "TikzPictureEnvironment", "FigureEnvironment", "ListEnvironment", "TableEnvironment",
];

/** One unit deeper than the line that opened the environment or group; its closing line goes back. */
function nested(closing: RegExp) {
  return (context: TreeIndentContext) => context.baseIndent + (closing.test(context.textAfter) ? 0 : context.unit);
}

export const latexIndentation = indentNodeProp.add({
  ...Object.fromEntries(ENVIRONMENT_NODES.map((name) => [name, nested(/^\s*\\end\b/)])),
  // The document environment is not indented, as in the stream tokenizer.
  DocumentEnvironment: (context: TreeIndentContext) => context.baseIndent,
  "Group NonEmptyGroup TextArgument": nested(/^\s*\}/),
});

export const latexTreeLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({ props: [latexStyleTags, latexIndentation] }),
  languageData: {
    commentTokens: { line: "%" },
    indentOnInput: /^\s*(?:\\end\{?|\})$/,
    closeBrackets: { brackets: ["{", "[", "(", "$"], before: ")]}$:;>,." },
    wordChars: "@:-",
  },
});

/** "stream" keeps the previous line tokenizer for `.tex` (no Visual mode). */
export type LatexParserChoice = "tree" | "stream";

/** The parser for `.tex` files: the tree unless `localStorage["libera.latexParser"]` is "stream". */
export function latexParserChoice(): LatexParserChoice {
  try {
    return globalThis.localStorage?.getItem("libera.latexParser") === "stream" ? "stream" : "tree";
  } catch {
    return "tree";
  }
}

export function latexLanguageSupport(fileName: string, choice: LatexParserChoice = latexParserChoice()): Extension {
  if (/\.bib$/i.test(fileName)) return [bibtexLanguage, syntaxHighlighting(latexHighlightStyle), indentUnit.of("  ")];
  const language = choice === "stream" ? streamLatexLanguage : latexTreeLanguage;
  return [language, syntaxHighlighting(latexHighlightStyle), foldService.of(latexFoldRange), indentUnit.of("  ")];
}
