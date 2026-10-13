import katex from "katex";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { findMathRegion, readPreviewMacros, type MathRegion } from "./math";

/* While the cursor is inside math, a rendered preview of that formula floats
 * below it. Escape hides it until the cursor leaves the formula. */

const dismissPreview = StateEffect.define<number>();
const MAX_PREVIEW_CHARACTERS = 4000;

type PreviewState = { region: MathRegion; source: string } | null;
const dismissedAt = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(dismissPreview)) return effect.value;
    if (value === null) return null;
    const pos = tr.state.selection.main.head;
    const region = findMathRegion(tr.state, pos);
    return region && tr.changes.mapPos(value) >= region.from && tr.changes.mapPos(value) <= region.to ? tr.changes.mapPos(value) : null;
  },
});

const macroCache = new WeakMap<EditorState["doc"], Record<string, string>>();

function previewMacros(state: EditorState) {
  let macros = macroCache.get(state.doc);
  if (!macros) {
    macros = readPreviewMacros(state.doc.sliceString(0, Math.min(state.doc.length, 40_000)));
    macroCache.set(state.doc, macros);
  }
  return macros;
}

function texForRegion(region: MathRegion, source: string) {
  const body = source.replace(/\\label\s*\{[^}]*\}|\\(?:nonumber|notag)\b/g, "").trim();
  const kind = region.kind.replace(/\*$/, "");
  if (kind === "align" || kind === "eqnarray" || kind === "flalign" || kind === "alignat") return `\\begin{aligned}${body}\\end{aligned}`;
  if (kind === "gather" || kind === "multline") return `\\begin{gathered}${body}\\end{gathered}`;
  return body;
}

function computePreview(state: EditorState): PreviewState {
  const selection = state.selection.main;
  if (!selection.empty || state.selection.ranges.length > 1) return null;
  const region = findMathRegion(state, selection.head);
  if (!region) return null;
  const source = state.sliceDoc(region.from, Math.min(region.to, region.from + MAX_PREVIEW_CHARACTERS));
  if (!source.trim()) return null;
  return { region, source };
}

const previewField = StateField.define<PreviewState>({
  create: computePreview,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const next = computePreview(tr.state);
    return next && value && next.source === value.source && next.region.from === value.region.from && next.region.kind === value.region.kind ? value : next;
  },
});

function tooltipFor(state: EditorState): Tooltip | null {
  const preview = state.field(previewField);
  if (!preview || state.field(dismissedAt) !== null) return null;
  // Anchor below the end of the formula, or below the cursor in long formulas.
  const head = state.selection.main.head;
  const anchor = state.doc.lineAt(preview.region.to).number - state.doc.lineAt(head).number > 6 ? head : preview.region.to;
  return {
    pos: anchor,
    above: false,
    strictSide: false,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-latex-math-preview";
      dom.setAttribute("aria-label", "Formula preview");
      try {
        katex.render(texForRegion(preview.region, preview.source), dom, {
          displayMode: preview.region.display,
          throwOnError: false,
          strict: "ignore",
          trust: false,
          macros: { ...previewMacros(state) },
          maxExpand: 500,
          output: "html",
        });
      } catch {
        dom.textContent = "Preview unavailable";
        dom.classList.add("cm-latex-math-preview-error");
      }
      return { dom };
    },
  };
}

const previewTooltip = StateField.define<Tooltip | null>({
  create: tooltipFor,
  update(value, tr) {
    const changed = tr.startState.field(previewField) !== tr.state.field(previewField) || tr.startState.field(dismissedAt) !== tr.state.field(dismissedAt);
    if (!changed) return value && tr.docChanged ? { ...value, pos: tr.changes.mapPos(value.pos) } : value;
    return tooltipFor(tr.state);
  },
  provide: (field) => showTooltip.from(field),
});

export function latexMathPreview(): Extension {
  return [
    previewField,
    dismissedAt,
    previewTooltip,
    keymap.of([{
      key: "Escape",
      run: (view: EditorView) => {
        if (!view.state.field(previewTooltip)) return false;
        view.dispatch({ effects: dismissPreview.of(view.state.selection.main.head) });
        return true;
      },
    }]),
  ];
}
