import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import katex from "katex";
import type { MathMarkerSettings } from "./math-markers";
import {
  emptyMacroDefinitions, expandMacroLatex, expandMacroText, isMacroBlockLanguage, parseMacroDefinitions,
  type MarkdownMacroDefinitions,
} from "./markdown-macros";

// Markdown macros in the Visual editor (docs/features/markdown-macros.md). The
// document keeps macros as written: an invocation shows its expansion until
// the caret reaches it, then its source, and math nodes render with the
// macros expanded. Counters number in document order, as in the preview.

/** Where a macro (or counter) is used in a paragraph, and the Markdown it expands to. */
export type MacroInvocation = { from: number; to: number; markdown: string };
type MacroState = {
  definitions: MarkdownMacroDefinitions;
  invocations: MacroInvocation[];
  /** Expanded LaTeX of math nodes that use macros or counters, by position. */
  math: Map<number, string>;
};

const EMPTY: MacroState = { definitions: emptyMacroDefinitions(), invocations: [], math: new Map() };
export const tiptapMacrosKey = new PluginKey<MacroState>("liberaMarkdownMacros");
const OBJECT = "￼";

type Piece = { start: number; end: number; pos: number; size: number; atom: boolean };

/** A paragraph's text as Markdown-ish source (inline math written with its markers), with a map back to positions. */
function textblockSource(node: ProseMirrorNode, pos: number) {
  let text = "";
  const pieces: Piece[] = [];
  const atoms: Array<{ start: number; end: number; pos: number }> = [];
  node.forEach((child, offset) => {
    const childPos = pos + 1 + offset;
    const start = text.length;
    if (child.isText) {
      // Inline code is never expanded.
      text += child.marks.some((mark) => mark.type.spec.code) ? OBJECT.repeat(child.text!.length) : child.text!;
      pieces.push({ start, end: text.length, pos: childPos, size: child.nodeSize, atom: false });
      return;
    }
    if (child.type.name === "inlineMath") {
      const open = String(child.attrs.mathOpen ?? "$");
      const close = String(child.attrs.mathClose ?? open);
      atoms.push({ start: start + open.length, end: start + open.length + String(child.attrs.latex ?? "").length, pos: childPos });
      text += `${open}${child.attrs.latex ?? ""}${close}`;
    } else text += child.type.name === "hardBreak" ? "\n" : OBJECT;
    pieces.push({ start, end: text.length, pos: childPos, size: child.nodeSize, atom: true });
  });
  const position = (offset: number, bias: "start" | "end") => {
    const piece = pieces.find((candidate) => bias === "start"
      ? offset >= candidate.start && offset < candidate.end
      : offset > candidate.start && offset <= candidate.end);
    if (!piece) return offset <= 0 ? pos + 1 : pos + 1 + node.content.size;
    if (!piece.atom) return piece.pos + offset - piece.start;
    return bias === "start" ? piece.pos : piece.pos + piece.size;
  };
  return { text, atoms, position };
}

function hasCounters(doc: ProseMirrorNode) {
  return doc.textBetween(0, doc.content.size, "\n", (leaf) => String(leaf.attrs.latex ?? "")).includes("\\counter-");
}

export function computeMacroState(doc: ProseMirrorNode, mathMarkers?: MathMarkerSettings): MacroState {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (node.type.spec.code && isMacroBlockLanguage(node.attrs.language)) blocks.push(node.textContent);
    return !node.isTextblock;
  });
  if (!blocks.length && !hasCounters(doc)) return EMPTY;
  const definitions = emptyMacroDefinitions();
  for (const block of blocks) parseMacroDefinitions(block, definitions);
  const counters = new Map<string, number>();
  const invocations: MacroInvocation[] = [];
  const math = new Map<number, string>();
  doc.descendants((node, pos) => {
    if (node.type.name === "blockMath") {
      const latex = String(node.attrs.latex ?? "");
      const expanded = expandMacroLatex(latex, definitions, counters);
      if (expanded !== latex) math.set(pos, expanded);
      return false;
    }
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    const source = textblockSource(node, pos);
    if (!source.text.includes("\\")) return false;
    for (const replacement of expandMacroText(source.text, definitions, counters, mathMarkers).replacements) {
      if (replacement.kind === "math") {
        const atom = source.atoms.find((candidate) => candidate.start === replacement.start);
        if (atom) math.set(atom.pos, replacement.text);
      } else if (replacement.kind !== "block") {
        invocations.push({ from: source.position(replacement.start, "start"), to: source.position(replacement.end, "end"), markdown: replacement.text });
      }
    }
    return false;
  });
  return { definitions, invocations, math };
}

/** The LaTeX a math node at `pos` renders: its own, with macros and counters expanded. */
export function macroLatexAt(state: EditorState, pos: number) {
  return tiptapMacrosKey.getState(state)?.math.get(pos);
}

const listeners = new WeakMap<EditorView, Set<() => void>>();
/** Calls `refresh` whenever the document's macros (or counter values) change; math node views re-render. */
export function onMacrosChange(view: EditorView, refresh: () => void) {
  let set = listeners.get(view);
  if (!set) listeners.set(view, set = new Set());
  set.add(refresh);
  return () => { set.delete(refresh); };
}

const expansions = new Map<string, { fragment: DocumentFragment; inline: boolean }>();

/** Renders expanded Markdown with the editor's own schema, math typeset by KaTeX. */
function renderExpansion(editor: Editor, markdown: string) {
  let cached = expansions.get(markdown);
  if (!cached) {
    const container = document.createElement("div");
    let inline = true;
    try {
      const doc = editor.schema.nodeFromJSON(editor.markdown!.parse(markdown));
      const single = doc.childCount === 1 && doc.firstChild!.type.name === "paragraph";
      inline = single || doc.childCount === 0;
      container.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(single ? doc.firstChild!.content : doc.content));
      for (const element of container.querySelectorAll<HTMLElement>("[data-type=inline-math], [data-type=block-math]")) {
        katex.render(element.dataset.latex ?? "", element, { displayMode: element.dataset.type === "block-math", throwOnError: false, trust: false });
      }
    } catch {
      container.textContent = markdown;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(...container.childNodes);
    cached = { fragment, inline };
    expansions.set(markdown, cached);
    if (expansions.size > 500) expansions.delete(expansions.keys().next().value!);
  }
  return { fragment: cached.fragment.cloneNode(true) as DocumentFragment, inline: cached.inline };
}

function invocationDecorations(editor: Editor, state: EditorState) {
  const macros = tiptapMacrosKey.getState(state);
  if (!macros?.invocations.length) return DecorationSet.empty;
  const { from, to } = state.selection;
  const decorations: Decoration[] = [];
  for (const invocation of macros.invocations) {
    // The caret at or in a macro shows its source, to edit.
    if (from <= invocation.to && to >= invocation.from) {
      decorations.push(Decoration.inline(invocation.from, invocation.to, { class: "libera-macro-source" }));
      continue;
    }
    const length = invocation.to - invocation.from;
    decorations.push(Decoration.inline(invocation.from, invocation.to, { class: "libera-macro-hidden" }));
    decorations.push(Decoration.widget(invocation.from, (view, getPos) => {
      const { fragment, inline } = renderExpansion(editor, invocation.markdown);
      const element = document.createElement(inline ? "span" : "div");
      element.className = inline ? "libera-macro-expansion" : "libera-macro-expansion libera-macro-expansion-block";
      element.contentEditable = "false";
      element.title = "Macro: click to edit";
      element.append(fragment);
      element.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const start = getPos();
        if (start === undefined) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(start + length, view.state.doc.content.size))));
        view.focus();
      });
      return element;
    }, { side: -1, ignoreSelection: true, key: `macro:${length}:${invocation.markdown}` }));
  }
  return DecorationSet.create(state.doc, decorations);
}

export const TiptapMarkdownMacros = Extension.create<{ mathMarkers?: MathMarkerSettings }>({
  name: "liberaMarkdownMacros",
  addOptions: () => ({ mathMarkers: undefined }),
  addProseMirrorPlugins() {
    const { editor } = this;
    const { mathMarkers } = this.options;
    return [new Plugin<MacroState>({
      key: tiptapMacrosKey,
      state: {
        init: (_, state) => computeMacroState(state.doc, mathMarkers),
        apply: (tr, value, _old, state) => tr.docChanged ? computeMacroState(state.doc, mathMarkers) : value,
      },
      props: { decorations: (state) => invocationDecorations(editor, state) },
      view: () => ({
        update(view, previous) {
          const current = tiptapMacrosKey.getState(view.state);
          const before = tiptapMacrosKey.getState(previous);
          if (current === before || (current === EMPTY && before === EMPTY)) return;
          listeners.get(view)?.forEach((refresh) => refresh());
        },
      }),
    })];
  },
});
