import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
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

/** The document's macros as MathLive macros that are written back by name, not expanded. */
function mathLiveMacros(view: EditorView, pos: number, latex: string) {
  const defs = visualDefinitions(view.state);
  const macros: Record<string, { def: string; args: number; expand: boolean; captureSelection: boolean }> = {};
  let optional = false;
  for (const match of latex.matchAll(/\\([A-Za-z@]+)/g)) {
    const macro = macroAt(defs, match[1], pos);
    if (!macro) continue;
    if (macro.optional !== undefined || macro.spec) optional = true;
    macros[match[1]] = { def: macro.body, args: macro.arity, expand: false, captureSelection: true };
  }
  return { macros, optional };
}

type Session = { view: EditorView; from: number; to: number; original: string; close: () => void };
const sessions = new Set<Session>();

/** Maps open editors' ranges through every change, remote ones included. */
export const mathSessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    session.from = update.changes.mapPos(session.from, -1);
    session.to = update.changes.mapPos(session.to, 1);
  }
});

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

  const session: Session = { view, from: content.from, to: content.to, original: latex, close: () => undefined };
  sessions.add(session);
  let closed = false;
  let field: (HTMLElement & { value: string; getValue?: (format?: string) => string; macros?: Record<string, unknown> }) | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    sessions.delete(session);
    panel.remove();
    document.removeEventListener("mousedown", outside, true);
    view.focus();
  };
  session.close = close;
  const commit = () => {
    if (closed || !field) return;
    const edited = (field.getValue?.("latex-without-placeholders") ?? field.value).trim();
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
    if (changes.length) view.dispatch({ changes, userEvent: "input.visual.math", scrollIntoView: false });
  };
  const outside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node)) commit();
  };
  cancel.addEventListener("mousedown", (event) => { event.preventDefault(); close(); });
  save.addEventListener("mousedown", (event) => { event.preventDefault(); commit(); });
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
