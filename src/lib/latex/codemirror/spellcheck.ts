import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/* The browser's spellcheck in the LaTeX editor. It is on only in the Visual
 * mode, where the markup is mostly hidden and the text reads as prose; Source
 * mode would flag every command name, key and column spec, so it never checks
 * there. Even in the Visual mode, what is not prose is kept out of it: command
 * names, formulas, comments, verbatim, labels, references, citation keys, file
 * names and environment names showing as source get `spellcheck="false"`.
 * Widgets are not editable text, so the browser never checks them. */

/** Syntax nodes whose whole text is never spellchecked. */
const NOT_PROSE = new Set([
  "CtrlSeq", "DollarMath", "BracketMath", "ParenMath", "InlineMath", "Math", "EquationEnvironment", "EquationArrayEnvironment",
  "Comment", "VerbatimEnvironment", "VerbatimContent", "LstInlineContent", "VerbContent", "Label", "Ref", "Cite", "References",
  "BeginEnv", "EndEnv", "EnvNameGroup", "OptionalArgument", "IncludeGraphics", "Input", "Include", "UrlCommand", "FilePathArgument",
]);

const noSpellcheck = Decoration.mark({ attributes: { spellcheck: "false" } });

function notProseRanges(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    let last = from;
    tree.iterate({
      from, to,
      enter: (node) => {
        if (!NOT_PROSE.has(node.name)) return undefined;
        const start = Math.max(node.from, last, from);
        const end = Math.min(node.to, to);
        if (end > start) { builder.add(start, end, noSpellcheck); last = end; }
        return false;
      },
    });
  }
  return builder.finish();
}

const notProsePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = notProseRanges(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = notProseRanges(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });

/** Whether the editor spellchecks: the user's setting, in the Visual mode of a .tex file only. */
export function latexSpellcheckActive(setting: boolean, visual: boolean) {
  return setting && visual;
}

/** The spellcheck attribute and, when on, the marks that keep markup out of it. */
export function latexSpellcheck(active: boolean): Extension {
  return active
    ? [EditorView.contentAttributes.of({ spellcheck: "true" }), notProsePlugin]
    : EditorView.contentAttributes.of({ spellcheck: "false" });
}
