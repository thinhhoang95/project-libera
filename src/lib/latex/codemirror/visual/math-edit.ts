import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import type { SyntaxNode } from "@lezer/common";
import { macroAt } from "../../macros/definitions";
import { registerMathOpener } from "./keys";
import { visualConfig, visualDefinitions } from "./model";
import { texDiff } from "./tex-tokens";

/* Formulas open in MathLive (docs/latex-visual-editor-plan.md §6.2). Formulas
 * MathLive would change are refused and shown as source instead. Saving
 * writes only the tokens that changed, and asks first if a co-author changed
 * the formula meanwhile. MathLive is loaded on the first edit. */

type MathLiveModule = typeof import("mathlive");
let loading: Promise<MathLiveModule> | null = null;

function loadMathLive() {
  loading ??= import("mathlive").then((module) => {
    // KaTeX's fonts are already on the page (MathLive draws with the same ones); no sounds.
    module.MathfieldElement.fontsDirectory = null;
    module.MathfieldElement.soundsDirectory = null;
    return module;
  });
  return loading;
}

const MATH_NODES = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment"]);

/** The editable inside of the formula starting at `from`: its LaTeX range. */
export function formulaContent(view: EditorView, from: number) {
  const tree = syntaxTree(view.state);
  for (let node: SyntaxNode | null = tree.resolveInner(from, 1); node; node = node.parent) {
    if (!MATH_NODES.has(node.name) || node.from !== from) continue;
    if (node.name === "EquationEnvironment" || node.name === "EquationArrayEnvironment") {
      const content = node.getChild("Content");
      return content ? { node, from: content.from, to: content.to } : null;
    }
    const display = node.getChild("DisplayMath");
    const math = display ? display.getChild("Math") : node.name === "DollarMath" ? node.getChild("InlineMath")?.getChild("Math") : node.getChild("Math");
    return math ? { node, from: math.from, to: math.to } : null;
  }
  return null;
}

/** Why MathLive cannot edit a formula without changing it, or null when it can. */
export function refusalReason(latex: string, usesOptionalMacro: boolean) {
  if (latex.trim().includes("\n")) return "spans several lines";
  if (/\\label\b/.test(latex)) return "has a \\label";
  if (latex.includes("&")) return "has alignment (&)";
  if (latex.includes("\\\\")) return "has line breaks (\\\\)";
  if (/(^|[^\\])%/.test(latex)) return "has a comment";
  if (usesOptionalMacro) return "uses a macro with an optional argument";
  return null;
}

/**
 * The document's macros as MathLive macros that are written back by name, not
 * expanded: those the formula uses and those their bodies use, transitively,
 * as the Visual preview expands them. `optional` when one of them takes an
 * optional argument or cannot be rendered, which MathLive would change.
 */
function mathLiveMacros(view: EditorView, pos: number, latex: string) {
  const defs = visualDefinitions(view.state);
  const macros: Record<string, { def: string; args: number; expand: boolean; captureSelection: boolean }> = {};
  let optional = false;
  const queue = [latex];
  for (let read = 0; read < queue.length && read < 200; read++) {
    for (const match of queue[read].matchAll(/\\([A-Za-z@]+)/g)) {
      if (macros[match[1]]) continue;
      const macro = macroAt(defs, match[1], pos);
      if (!macro) continue;
      if (macro.optional !== undefined || macro.spec || macro.unsupported) optional = true;
      macros[match[1]] = { def: macro.body, args: macro.arity, expand: false, captureSelection: true };
      queue.push(macro.body);
    }
  }
  return { macros, optional };
}

type Session = { view: EditorView; start: number; from: number; to: number; original: string; close: () => void };
const sessions = new Set<Session>();

/** Maps open editors' ranges through every change, remote ones included. */
export const mathSessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    session.start = update.changes.mapPos(session.start, 1);
    session.from = update.changes.mapPos(session.from, -1);
    session.to = update.changes.mapPos(session.to, 1);
  }
});

/** Closes a view's formula editors without saving: the view is going away, or leaving the Visual mode. */
export function closeMathSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.close();
}

function openEditor(view: EditorView, from: number, to: number): boolean {
  const config = view.state.facet(visualConfig);
  if (view.state.readOnly || !config.editable()) return false;
  const content = formulaContent(view, from);
  if (!content) return false;
  const latex = view.state.sliceDoc(content.from, content.to);
  const { macros, optional } = mathLiveMacros(view, from, latex);
  if (refusalReason(latex, optional)) return false;
  for (const session of [...sessions]) session.close();

  const coords = view.coordsAtPos(from) ?? view.coordsAtPos(Math.min(to, view.state.doc.length));
  const panel = document.createElement("div");
  panel.className = "cm-vis-math-editor";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Edit formula");
  const top = Math.min(window.innerHeight - 140, (coords?.bottom ?? 120) + 6);
  panel.style.top = `${Math.max(8, top)}px`;
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, coords?.left ?? 40))}px`;
  const actions = document.createElement("div");
  actions.className = "cm-vis-math-editor-actions";
  const hint = document.createElement("span");
  hint.className = "cm-vis-math-editor-hint";
  hint.textContent = "Enter saves · Esc cancels · Alt+click a formula for its source";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "cm-vis-primary";
  save.textContent = "Save";
  actions.append(hint, cancel, save);
  panel.append(actions);
  document.body.append(panel);

  const session: Session = { view, start: from, from: content.from, to: content.to, original: latex, close: () => undefined };
  sessions.add(session);
  let closed = false;
  let field: (HTMLElement & { value: string; getValue?: (format?: string) => string; macros?: Record<string, unknown> }) | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    sessions.delete(session);
    panel.remove();
    document.removeEventListener("mousedown", outside, true);
    // A destroyed view (its tab closed) has nothing to focus.
    if (view.dom.isConnected) view.focus();
  };
  session.close = close;
  const commit = () => {
    if (closed || !field) return;
    const edited = (field.getValue?.("latex-without-placeholders") ?? field.value).trim();
    // The permission may have changed while editing (a viewer now, or the tab went read-only).
    if (view.state.readOnly || !view.state.facet(visualConfig).editable()) { close(); return; }
    // The formula must still be there: a co-author may have deleted it, leaving an empty range that is not a formula.
    const still = formulaContent(view, session.start);
    if (!still || still.from !== session.from || still.to !== session.to) {
      close();
      if (edited !== latex.trim() && window.confirm("A co-author deleted this formula while you were editing it, so it was not saved. Copy your version to the clipboard?")) {
        void navigator.clipboard?.writeText(edited).catch(() => undefined);
      }
      return;
    }
    const current = view.state.sliceDoc(session.from, session.to);
    if (current !== session.original && !window.confirm("A co-author changed this formula while you were editing it. Replace their version with yours?")) {
      close();
      return;
    }
    // Keep the spaces the formula had around it in the source.
    const lead = /^\s*/.exec(current)![0];
    const trail = /\s*$/.exec(current)![0];
    const core = current.slice(lead.length, current.length - trail.length);
    const changes = texDiff(core, edited, session.from + lead.length);
    close();
    if (changes.length) dispatchAsOneStep(view, { changes, userEvent: "input.visual.math", scrollIntoView: false });
  };
  const outside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node)) commit();
  };
  // Pressing keeps the field's focus; the click (from the keyboard too) acts.
  for (const button of [cancel, save]) button.addEventListener("mousedown", (event) => event.preventDefault());
  cancel.addEventListener("click", (event) => { event.preventDefault(); close(); });
  save.addEventListener("click", (event) => { event.preventDefault(); commit(); });
  // A dialog: Escape cancels from anywhere in it, and Tab stays inside it.
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const stops = [field, cancel, save].filter((item): item is NonNullable<typeof item> => !!item);
    const index = stops.findIndex((item) => item === document.activeElement || item.contains(document.activeElement));
    event.preventDefault();
    stops[(index + (event.shiftKey ? stops.length - 1 : 1)) % stops.length]?.focus();
  });
  document.addEventListener("mousedown", outside, true);

  void loadMathLive().then((module) => {
    if (closed) return;
    const element = new module.MathfieldElement() as unknown as NonNullable<typeof field>;
    field = element;
    // A math field must be in the page before its macros can be read or set.
    panel.insertBefore(element, actions);
    element.macros = { ...(element.macros ?? {}), ...macros };
    element.value = latex.trim();
    element.addEventListener("keydown", (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (key === "Enter" && !(event as KeyboardEvent).shiftKey) { event.preventDefault(); event.stopPropagation(); commit(); }
    }, { capture: true });
    element.focus();
  }).catch((error: unknown) => {
    console.error("MathLive could not start; showing the formula's source instead.", error);
    close();
    // MathLive could not load: show the source instead.
    view.dispatch({ selection: { anchor: Math.min(to - 1, from + 1) } });
  });
  return true;
}

registerMathOpener(openEditor);

/** Whether a formula opens in MathLive (for tests and the toolbar). */
export function canEditInMathLive(view: EditorView, from: number) {
  const content = formulaContent(view, from);
  if (!content) return false;
  const latex = view.state.sliceDoc(content.from, content.to);
  return !refusalReason(latex, mathLiveMacros(view, from, latex).optional);
}
