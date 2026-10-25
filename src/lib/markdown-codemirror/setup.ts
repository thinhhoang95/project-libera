import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { deleteCharBackwardStrict, history, historyKeymap, insertNewline, redoSelection, standardKeymap, undoSelection } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { codeHighlightStyle } from "@/lib/code-languages";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { findMatchesField } from "./find";
import { citationDecorations } from "./citations";
import { liberaSyntax } from "./libera-syntax";
import { SOURCE_EDITOR_LABEL, SOURCE_PANE_PADDING, SOURCE_SPELLCHECK, SOURCE_TAB_SIZE } from "@/lib/markdown-source";
import { sourceLineStart } from "./commands";

/* The CodeMirror Markdown Source editor's base configuration: GFM with fenced
 * code highlighted by language-data, Libera's syntax layer, history and the
 * app theme. App shortcuts (formatting,
 * headings, find, the file-link picker) are added by the component, which owns
 * the React state they open. */

/** Markdown token colours. Headings, quotes and boxes are coloured by line (see
 * libera-syntax.ts), as in the textarea overlay; this styles the marks. */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--latex-command)" },
  { tag: tags.url, textDecoration: "underline", textUnderlineOffset: "3px" },
  { tag: tags.monospace, fontFamily: "var(--font-mono, ui-monospace, monospace)", background: "color-mix(in srgb, var(--muted) 70%, transparent)", borderRadius: "3px" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: "var(--muted-foreground)" },
  { tag: tags.list, color: "var(--latex-math-delimiter)" },
  { tag: [tags.angleBracket, tags.tagName, tags.attributeName, tags.attributeValue], color: "var(--muted-foreground)" },
]);

/** Fenced code keeps the code editor's token colours; the Markdown tags that
 * style also covers (headings, links, emphasis) are left to the rules above,
 * so a heading is coloured by its line like in the textarea overlay. */
const MARKDOWN_OWNED_TAGS = new Set([tags.heading, tags.link, tags.url, tags.emphasis, tags.strong, tags.strikethrough]);
const fencedCodeHighlightStyle = HighlightStyle.define(codeHighlightStyle.specs.flatMap((spec) => {
  const tagList = (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).filter((tag) => !MARKDOWN_OWNED_TAGS.has(tag));
  return tagList.length ? [{ ...spec, tag: tagList }] : [];
}));

const sourceTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-content": { paddingInline: "0" },
  "&.cm-editor .cm-content": { paddingBlock: SOURCE_PANE_PADDING },
  // Long words and URLs wrap anywhere, as the textarea does.
  ".cm-line": { overflowWrap: "anywhere" },
});

export type MarkdownSourceSetupOptions = {
  ariaLabel?: string;
  mathMarkers?: MathMarkerSettings;
};

export function markdownSourceSetup({ ariaLabel = SOURCE_EDITOR_LABEL, mathMarkers }: MarkdownSourceSetupOptions = {}): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    // Markdown's Enter/Backspace keymap and HTML tag completion are left out:
    // the textarea editor inserts plain newlines and never completes tags.
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
    syntaxHighlighting(markdownHighlightStyle),
    syntaxHighlighting(fencedCodeHighlightStyle),
    liberaSyntax(mathMarkers),
    citationDecorations(),
    findMatchesField,
    sourceTheme,
    EditorState.tabSize.of(SOURCE_TAB_SIZE),
    keymap.of([
      { key: "Enter", run: insertNewline, shift: insertNewline },
      { key: "Backspace", run: deleteCharBackwardStrict, shift: deleteCharBackwardStrict, preventDefault: true },
      ...standardKeymap.filter(({ key }) => key !== "Enter" && key !== "Backspace").map((binding) =>
        binding.key === "Home" ? { ...binding, run: sourceLineStart(), shift: sourceLineStart(true) }
          : binding.mac === "Cmd-ArrowLeft" ? { ...binding, run: sourceLineStart(false, true), shift: sourceLineStart(true, true) }
            : binding),
      ...historyKeymap.filter(({ run }) => run !== undoSelection && run !== redoSelection),
    ]),
    // CodeMirror defaults these to off/no; a textarea inherits the browser's defaults.
    EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: String(SOURCE_SPELLCHECK), autocorrect: "on", autocapitalize: "sentences", writingsuggestions: "true", translate: "yes" }),
  ];
}
