import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import type { SyntaxNode } from "@lezer/common";
import { macroAt } from "../../macros/definitions";
import { expandLatexMacros } from "../../macros/expand";
import { registerMathOpener } from "./keys";
import { formulaLayout, formulaMacros, pieceForMathLive, pieceFromMathLive, pieceIndexAt, sameFormula, sourceChanges, writablePiece, type FormulaLayout } from "./math-pieces";
import { visualConfig, visualDefinitions } from "./model";
import { texDiff, type TexChange } from "./tex-tokens";

/* Formulas open in MathLive (docs/latex-visual-editor-plan.md §6.2), one piece at a time: a formula is split
 * at its top-level `&` and `\\` (math-pieces.ts), so a row or cell of an `align`, `cases` or matrix is edited
 * alone and the alignment, row breaks, `\label`s, `\tag`s and comments around it are never rewritten. A piece
 * MathLive would change opens as source in the same panel; the other pieces still open in MathLive. Saving
 * writes only the tokens that changed, and asks first if a co-author changed the piece meanwhile. MathLive
 * is loaded on the first edit.
 *
 * Which piece a click opens: KaTeX draws an alignment as an `.mtable` of `.col-align-*` columns, each a vlist
 * with one entry per row. The click's column is the column it falls in; its row is the entry of the first
 * column at the click's height (later columns can have fewer entries). Source row n is drawn row n (KaTeX
 * drops a final empty row, as the split does). */

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

/** The editable inside of the formula starting at `from`: its LaTeX range, and its environment's name. */
export function formulaContent(view: EditorView, from: number) {
  const tree = syntaxTree(view.state);
  for (let node: SyntaxNode | null = tree.resolveInner(from, 1); node; node = node.parent) {
    if (!MATH_NODES.has(node.name) || node.from !== from) continue;
    if (node.name === "EquationEnvironment" || node.name === "EquationArrayEnvironment") {
      const content = node.getChild("Content");
      const group = node.getChild("BeginEnv")?.getChild("EnvNameGroup");
      const env = group ? view.state.sliceDoc(group.from, group.to).replace(/[{}\s]/g, "") : null;
      return content ? { node, from: content.from, to: content.to, env } : null;
    }
    const display = node.getChild("DisplayMath");
    const math = display ? display.getChild("Math") : node.name === "DollarMath" ? node.getChild("InlineMath")?.getChild("Math") : node.getChild("Math");
    return math ? { node, from: math.from, to: math.to, env: null } : null;
  }
  return null;
}

/** The formula at `from` split into pieces, with the macros MathLive gets for it. */
export function formulaTarget(view: EditorView, from: number) {
  const content = formulaContent(view, from);
  if (!content) return null;
  const text = view.state.sliceDoc(content.from, content.to);
  const defs = visualDefinitions(view.state);
  const macros = formulaMacros(text, (name) => macroAt(defs, name, from));
  const layout: FormulaLayout = formulaLayout(text, content.env, macros.opaque.map((use) => [use.from, use.to] as const));
  for (const piece of layout.pieces) {
    if (!piece.reason && macros.incomplete.some((at) => at >= piece.from && at < piece.to)) piece.reason = "uses a macro without all its arguments";
  }
  /** How MathLive draws an opaque use: its expansion, or its name and the rest as written. */
  const render = (source: string) => {
    const expanded = expandLatexMacros(source, defs, { mode: "math", pos: from });
    if (expanded.ok && !/\\physics@|\\(?:IfBooleanTF|IfNoValueTF|IfValueTF)/.test(expanded.text) && !expanded.text.includes("\u0000")) return expanded.text;
    const name = /^\\([A-Za-z@]+)/.exec(source)?.[1] ?? "";
    const rest = expandLatexMacros(source.slice(name.length + 1), defs, { mode: "math", pos: from });
    return `\\mathtt{\\backslash ${name.replace(/@/g, "")}}${rest.ok && !/\\physics@/.test(rest.text) ? rest.text : ""}`;
  };
  return { from: content.from, to: content.to, text, layout, macros, render };
}

/** Whether some piece of a formula opens in MathLive (for tests and the toolbar). */
export function canEditInMathLive(view: EditorView, from: number) {
  const target = formulaTarget(view, from);
  return !!target && target.layout.pieces.some((piece) => !piece.reason);
}

/** The row and column of a drawn formula (KaTeX's output) under a click, or null when it has no rows. */
function cellAt(dom: HTMLElement, event: MouseEvent): { row: number; column: number } | null {
  const columnsOf = (table: Element) => [...table.children].filter((child) => /\bcol-align-/.test(child.className));
  const rowsOf = (table: Element) => [...(columnsOf(table)[0]?.querySelector(".vlist")?.children ?? [])];
  // A 1×1 table is KaTeX's wrapper of an `equation`, not rows.
  const real = (table: Element) => columnsOf(table).length > 1 || rowsOf(table).length > 1;
  let table: Element | null = null;
  for (let node = event.target as Element | null; node && node !== dom; node = node.parentElement) if (node.classList?.contains("mtable") && real(node)) table = node;
  table ??= [...dom.querySelectorAll(".mtable")].find(real) ?? null;
  if (!table) return null;
  const nearest = (boxes: DOMRect[], value: number, start: "top" | "left", end: "bottom" | "right") => {
    let best = 0;
    let distance = Infinity;
    boxes.forEach((box, index) => {
      const d = value < box[start] ? box[start] - value : value > box[end] ? value - box[end] : 0;
      if (d < distance) { distance = d; best = index; }
    });
    return best;
  };
  const columns = columnsOf(table);
  const inside = columns.findIndex((column) => column.contains(event.target as Node));
  const column = inside >= 0 ? inside : nearest(columns.map((item) => item.getBoundingClientRect()), event.clientX, "left", "right");
  const row = nearest(rowsOf(table).map((item) => item.getBoundingClientRect()), event.clientY, "top", "bottom");
  return { row, column };
}

type Session = { view: EditorView; start: number; contentFrom: number; contentTo: number; from: number; to: number; original: string; close: () => void };
const sessions = new Set<Session>();

/** Maps open editors' ranges through every change, remote ones included. */
export const mathSessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    session.start = update.changes.mapPos(session.start, 1);
    session.contentFrom = update.changes.mapPos(session.contentFrom, -1);
    session.contentTo = update.changes.mapPos(session.contentTo, 1);
    session.from = update.changes.mapPos(session.from, -1);
    session.to = update.changes.mapPos(session.to, 1);
  }
});

/** Closes a view's formula editors without saving: the view is going away, or leaving the Visual mode. */
export function closeMathSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.close();
}

type Field = HTMLElement & { value: string; getValue?: (format?: string) => string; macros?: Record<string, unknown> };

function button(label: string, primary = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (primary) element.className = "cm-vis-primary";
  return element;
}

function openEditor(view: EditorView, from: number, to: number, event?: MouseEvent, dom?: HTMLElement): boolean {
  const config = view.state.facet(visualConfig);
  if (view.state.readOnly || !config.editable()) return false;
  const target = formulaTarget(view, from);
  if (!target) return false;
  const pieces = target.layout.pieces;
  let index = 0;
  if (event && dom && pieces.length > 1) {
    const cell = cellAt(dom, event);
    if (cell) index = pieceIndexAt(target.layout, cell.row, cell.column);
  }
  // A formula of one piece that MathLive cannot edit shows its source in place, as before.
  if (pieces.length === 1 && pieces[0].reason) return false;
  for (const session of [...sessions]) session.close();

  const coords = view.coordsAtPos(from) ?? view.coordsAtPos(Math.min(to, view.state.doc.length));
  const panel = document.createElement("div");
  panel.className = "cm-vis-math-editor";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Edit formula");
  const anchor = event ? event.clientY + 14 : (coords?.bottom ?? 120) + 6;
  panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 160, anchor))}px`;
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, coords?.left ?? 40))}px`;
  const status = document.createElement("div");
  status.className = "cm-vis-math-editor-status";
  status.setAttribute("aria-live", "polite");
  const body = document.createElement("div");
  body.className = "cm-vis-math-editor-body";
  const actions = document.createElement("div");
  actions.className = "cm-vis-math-editor-actions";
  const hint = document.createElement("span");
  hint.className = "cm-vis-math-editor-hint";
  const several = pieces.length > 1;
  hint.textContent = several ? "Enter saves · Tab next cell · Shift+Tab previous · Esc cancels" : "Enter saves · Esc cancels · Alt+click a formula for its source";
  const previous = button("‹");
  previous.setAttribute("aria-label", "Previous cell");
  const next = button("›");
  next.setAttribute("aria-label", "Next cell");
  const cancel = button("Cancel");
  const save = button("Save", true);
  actions.append(hint, ...(several ? [previous, next] : []), cancel, save);
  panel.append(status, body, actions);
  document.body.append(panel);

  const session: Session = { view, start: from, contentFrom: target.from, contentTo: target.to, from: target.from, to: target.from, original: "", close: () => undefined };
  sessions.add(session);
  let closed = false;
  let current = index;
  let count = pieces.length;
  /** The open piece's editor: its element, how it is written (`math`: as a token diff), and its text. */
  let editor: { element: HTMLElement; mode: "math" | "source"; read: () => string } | null = null;
  let generation = 0;
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

  /** Saves the open piece. False when it was not saved and the panel stays (text that would break the formula). */
  const commit = (): boolean => {
    if (closed || !editor) return true;
    const edited = editor.read().trim();
    // The permission may have changed while editing (a viewer now, or the tab went read-only).
    if (view.state.readOnly || !view.state.facet(visualConfig).editable()) { close(); return false; }
    // The formula must still be there: a co-author may have deleted it, leaving an empty range that is not a formula.
    const still = formulaContent(view, session.start);
    if (!still || still.from !== session.contentFrom || still.to !== session.contentTo) {
      close();
      if (edited !== session.original.trim() && window.confirm("A co-author deleted this formula while you were editing it, so it was not saved. Copy your version to the clipboard?")) {
        void navigator.clipboard?.writeText(edited).catch(() => undefined);
      }
      return false;
    }
    const now = view.state.sliceDoc(session.from, session.to);
    if (now !== session.original && !window.confirm("A co-author changed this part of the formula while you were editing it. Replace their version with yours?")) return true;
    if (!writablePiece(edited)) {
      status.textContent = "Not saved: this would leave a brace, \\left or environment open, or end the formula.";
      return false;
    }
    // Keep the spaces the piece had around it in the source.
    const lead = /^\s*/.exec(now)![0];
    const trail = /\s*$/.exec(now)![0];
    const core = now.slice(lead.length, now.length - trail.length);
    const changes: TexChange[] = editor.mode === "math" ? texDiff(core, edited, session.from + lead.length) : sourceChanges(core, edited, session.from + lead.length);
    if (changes.length) dispatchAsOneStep(view, { changes, userEvent: "input.visual.math", scrollIntoView: false });
    return true;
  };

  const keys = (element: HTMLElement, multiline: boolean) => {
    element.addEventListener("keydown", (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (key.key === "Enter" && !key.shiftKey && !(multiline && key.altKey)) { event.preventDefault(); event.stopPropagation(); if (commit()) close(); }
      else if (key.key === "Tab" && count > 1) { event.preventDefault(); event.stopPropagation(); move(key.shiftKey ? -1 : 1); }
    }, { capture: true });
  };

  const showSource = (why: string | null) => {
    const area = document.createElement("textarea");
    area.className = "cm-vis-math-source";
    area.value = session.original;
    area.rows = Math.min(6, session.original.split("\n").length + 1);
    area.spellcheck = false;
    area.setAttribute("aria-label", "Formula source");
    keys(area, true);
    body.replaceChildren(area);
    editor = { element: area, mode: "source", read: () => area.value };
    if (why) status.textContent += ` · source: ${why}`;
    area.focus();
  };

  const show = (wanted: number) => {
    const fresh = formulaTarget(view, session.start);
    if (!fresh || !fresh.layout.pieces.length) { close(); return; }
    const list = fresh.layout.pieces;
    count = list.length;
    current = Math.max(0, Math.min(list.length - 1, wanted));
    const piece = list[current];
    session.contentFrom = fresh.from;
    session.contentTo = fresh.to;
    session.from = fresh.from + piece.from;
    session.to = fresh.from + piece.to;
    session.original = view.state.sliceDoc(session.from, session.to);
    const rows = Math.max(...list.map((item) => item.row)) + 1;
    const cells = list.some((item) => item.cell > 0);
    status.textContent = list.length > 1 ? `Row ${piece.row + 1} of ${rows}${cells ? `, cell ${piece.cell + 1}` : ""}` : "";
    previous.disabled = current === 0;
    next.disabled = current === list.length - 1;
    editor = null;
    body.replaceChildren();
    const mine = ++generation;
    if (piece.reason) { showSource(piece.reason); return; }
    const prepared = pieceForMathLive(fresh.text, piece, fresh.macros.opaque, fresh.render);
    if (!prepared) { showSource("a macro crosses its edge"); return; }
    const original = session.original;
    void loadMathLive().then((module) => {
      if (closed || mine !== generation) return;
      const field = new module.MathfieldElement() as unknown as Field;
      // A math field must be in the page before its macros can be read or set.
      body.replaceChildren(field);
      const macros: Record<string, { def: string; args: number; expand: boolean; captureSelection: boolean }> = {};
      for (const [name, macro] of fresh.macros.plain) macros[name] = { def: macro.body, args: macro.arity, expand: false, captureSelection: true };
      for (const [name, atom] of Object.entries(prepared.atoms)) macros[name] = { def: atom.def, args: 0, expand: false, captureSelection: true };
      field.macros = { ...(field.macros ?? {}), ...macros };
      field.value = prepared.value;
      const read = () => pieceFromMathLive(field.getValue?.("latex-without-placeholders") ?? field.value, prepared.atoms, original);
      // MathLive must read the piece as it typesets; otherwise it would change it, and the piece is edited as source.
      if (!sameFormula(read(), original)) { showSource("MathLive would change it"); return; }
      editor = { element: field, mode: "math", read };
      keys(field, false);
      field.focus();
    }).catch((error: unknown) => {
      console.error("MathLive could not start; showing the formula's source instead.", error);
      if (closed || mine !== generation) return;
      showSource(null);
    });
  };

  /** Saves the open piece and opens the one `delta` away; past the last (or first), closes. */
  const move = (delta: number) => {
    if (!commit() || closed) return;
    const wanted = current + delta;
    if (wanted < 0 || wanted >= count) { close(); return; }
    show(wanted);
  };

  const outside = (event: MouseEvent) => {
    // Text that would break the formula keeps the panel open, with the reason shown.
    if (!panel.contains(event.target as Node) && commit()) close();
  };
  // Pressing keeps the field's focus; the click (from the keyboard too) acts.
  for (const item of [previous, next, cancel, save]) item.addEventListener("mousedown", (event) => event.preventDefault());
  cancel.addEventListener("click", (event) => { event.preventDefault(); close(); });
  save.addEventListener("click", (event) => { event.preventDefault(); if (commit()) close(); });
  previous.addEventListener("click", (event) => { event.preventDefault(); move(-1); });
  next.addEventListener("click", (event) => { event.preventDefault(); move(1); });
  // A dialog: Escape cancels from anywhere in it, and Tab stays inside it.
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const stops = [editor?.element, ...(several ? [previous, next] : []), cancel, save].filter((item): item is HTMLElement => !!item && !(item as HTMLButtonElement).disabled);
    const at = stops.findIndex((item) => item === document.activeElement || item.contains(document.activeElement));
    event.preventDefault();
    stops[(at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length]?.focus();
  });
  document.addEventListener("mousedown", outside, true);
  show(index);
  return true;
}

registerMathOpener(openEditor);
