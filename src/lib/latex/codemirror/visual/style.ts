import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { environmentName, wrappedTheorem } from "../../macros/numbering";
import { definitionsField, visualDefinitions } from "./model";
import { structuralField } from "./structural";
import { boxEnvironments, walkConstructs } from "./walk";

/* The style layer (docs/latex-visual-editor-plan.md §4): marks and line
 * classes for what is on screen, recomputed from the tree as the viewport
 * moves. Reveal does not affect it: bold text stays bold while its markup
 * shows. */

const MARGIN = 2_000;
/** Constructs whose styles reach past their start, so a walk must begin at them. */
const STYLE_CONTAINERS = new Set([
  "ListEnvironment", "TextBoldCommand", "TextItalicCommand", "EmphasisCommand", "UnderlineCommand", "TextTeletypeCommand",
  "TextSmallCapsCommand", "TextSansSerifCommand", "TextMediumCommand", "StrikeOutCommand", "TextSuperscriptCommand",
  "TextSubscriptCommand", "TextColorCommand", "ColorBoxCommand", "HrefCommand", "UrlCommand", "FootnoteCommand", "EndnoteCommand",
  "SectioningCommand", "VerbatimEnvironment",
]);

function visibleRanges(view: EditorView) {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const range of view.visibleRanges) {
    const from = Math.max(0, range.from - MARGIN);
    const to = Math.min(view.state.doc.length, range.to + MARGIN);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  return ranges;
}

function build(view: EditorView): DecorationSet {
  const state = view.state;
  const tree = syntaxTree(state);
  const defs = visualDefinitions(state);
  const structural = state.field(structuralField, false);
  const ranges: Array<Range<Decoration>> = [];
  const seenLines = new Set<string>();
  for (const visible of visibleRanges(view)) {
    let from = visible.from;
    // Start at the outermost styled construct around the top of the range.
    for (let node: SyntaxNode | null = tree.resolveInner(from, 1); node; node = node.parent) {
      if (STYLE_CONTAINERS.has(node.name)) from = Math.min(from, node.from);
      else if (node.name === "Environment") {
        const name = environmentName(node, (start, end) => state.doc.sliceString(start, end));
        const user = name ? defs.environments.get(name) : undefined;
        if (name && (defs.theorems.has(name) || (user && wrappedTheorem(user.begin, user.end, defs)) || name === "proof" || name === "abstract" || /^(?:quote|quotation|verse|center|flushleft|flushright)$/.test(name) || boxEnvironments(state.doc, defs).has(name))) from = Math.min(from, node.from);
      }
    }
    walkConstructs({
      state, tree, defs, preambleEnd: structural?.preambleEnd ?? -1, preambleOpen: structural?.preambleOpen ?? false, preambleSummary: "", layer: "style",
    }, from, visible.to, (construct) => {
      for (const mark of construct.marks ?? []) {
        if (mark.to > mark.from) ranges.push(Decoration.mark({ class: mark.class, attributes: mark.attributes }).range(mark.from, mark.to));
      }
      for (const line of construct.lines ?? []) {
        for (let pos = state.doc.lineAt(line.from).from; pos <= line.to;) {
          const current = state.doc.lineAt(pos);
          if (current.from > visible.to + MARGIN) break;
          const key = `${current.from}:${line.class}`;
          if (!seenLines.has(key)) {
            seenLines.add(key);
            ranges.push(Decoration.line({ class: line.class }).range(current.from));
          }
          if (current.to >= state.doc.length) break;
          pos = current.to + 1;
        }
      }
    });
  }
  return Decoration.set(ranges, true);
}

export const visualStylePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
      || update.startState.field(definitionsField, false) !== update.state.field(definitionsField, false)
      || update.startState.field(structuralField, false)?.preambleOpen !== update.state.field(structuralField, false)?.preambleOpen) {
      this.decorations = build(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
