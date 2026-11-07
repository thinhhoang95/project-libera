import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { MapMode, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import { fragmentContext, setTableHooks, type TableElement } from "./widgets";
import { renderLatexFragment } from "./render-fragment";
import { deleteColumn, deleteRow, insertColumn, insertRow, parseTabular, setCellText, type TableCell, type TableChange, type TableModel } from "./table-model";

/* Editing tables in the grid (docs/latex-visual-editor-plan.md §6.3). A cell
 * becomes its LaTeX source while it is edited, and saving rewrites only that
 * cell. Row and column commands write the fewest changes, in one transaction
 * that undoes as one step. */

/** The tabular starting at `start` in the current document, with its cell map. */
function tableAt(view: EditorView, start: number): { model: TableModel; source: string; from: number } | null {
  const tree = syntaxTree(view.state);
  for (let node = tree.resolveInner(start + 1, -1) as ReturnType<typeof tree.resolveInner> | null; node; node = node.parent) {
    if (node.name === "TabularEnvironment" && node.from === start) {
      const source = view.state.sliceDoc(node.from, node.to);
      const model = parseTabular(source, node.from);
      return model ? { model, source, from: node.from } : null;
    }
  }
  return null;
}

/** One undo step that does not merge with typing, on local and shared tabs alike. */
function dispatchAsOneStep(view: EditorView, changes: TableChange[], userEvent: string) {
  const config = view.state.facet(ySyncFacet) as unknown as { undoManager?: { stopCapturing?: () => void } } | undefined;
  config?.undoManager?.stopCapturing?.();
  view.dispatch({ changes, userEvent, annotations: isolateHistory.of("full") });
  config?.undoManager?.stopCapturing?.();
}

/** The cell element at (row, cell) of the table that now starts at `start`, after a redraw. */
function findCell(view: EditorView, start: number, row: number, cell: number) {
  for (const table of view.contentDOM.querySelectorAll<TableElement>(".cm-vis-table")) {
    if (table.liberaTableStart?.() !== start) continue;
    return table.querySelector<HTMLElement>(`.cm-vis-table-cell[data-row="${row}"][data-cell="${cell}"]`);
  }
  return null;
}

/**
 * An open cell editor or row/column menu: the table's start and the cell's
 * text range, mapped through every change (a collaborator's too), so a save
 * or a menu command finds the same table and cell, or knows they are gone.
 */
type TableSession = { view: EditorView; start: number | null; cellFrom: number | null; cellTo: number | null };
const sessions = new Set<TableSession>();

const sessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    const map = (pos: number | null, assoc: -1 | 1) => (pos === null ? null : update.changes.mapPos(pos, assoc, MapMode.TrackDel));
    session.start = map(session.start, 1);
    session.cellFrom = map(session.cellFrom, -1);
    session.cellTo = map(session.cellTo, 1);
  }
});

/** A cell's editable text range: a \multicolumn's content, or the whole cell. */
function cellRange(cell: TableCell) {
  return cell.contentFrom !== undefined && cell.contentTo !== undefined ? { from: cell.contentFrom, to: cell.contentTo } : { from: cell.from, to: cell.to };
}

/** The session's table and cell in the current document, or null when either is gone or changed shape. */
function resolveSession(view: EditorView, session: TableSession) {
  if (session.start === null || session.cellFrom === null || session.cellTo === null) return null;
  const table = tableAt(view, session.start);
  if (!table) return null;
  for (let r = 0; r < table.model.rows.length; r++) {
    const cells = table.model.rows[r].cells;
    for (let c = 0; c < cells.length; c++) {
      const range = cellRange(cells[c]);
      if (range.from === session.cellFrom && range.to === session.cellTo) return { table, cell: cells[c], row: r, cellIndex: c };
    }
  }
  return null;
}

function openSession(view: EditorView, start: number, cell: TableCell): TableSession {
  const range = cellRange(cell);
  const session: TableSession = { view, start, cellFrom: range.from, cellTo: range.to };
  sessions.add(session);
  return session;
}

function editCell(view: EditorView, td: HTMLElement, tableStart: () => number | null, row: number, cellIndex: number) {
  const start = tableStart();
  if (start === null) return;
  const table = tableAt(view, start);
  const cell = table?.model.rows[row]?.cells[cellIndex];
  if (!table || !cell || cell.sourceOnly) return;
  const session = openSession(view, start, cell);
  const original = view.state.sliceDoc(session.cellFrom!, session.cellTo!);
  const rendered = Array.from(td.childNodes);
  td.contentEditable = "true";
  td.spellcheck = false;
  td.textContent = original;
  td.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(td);
  selection?.removeAllRanges();
  selection?.addRange(range);
  let done = false;
  let typed = false;
  const onInput = () => { typed = true; };
  const finish = (save: boolean, next: -1 | 0 | 1 = 0) => {
    if (done) return;
    done = true;
    sessions.delete(session);
    td.removeEventListener("keydown", onKey, true);
    td.removeEventListener("blur", onBlur);
    td.removeEventListener("input", onInput);
    td.contentEditable = "false";
    // The text as typed. Editable elements turn spaces into no-break spaces; the cell had plain ones.
    let text = td.textContent ?? "";
    if (!original.includes(" ")) text = text.replace(/ /g, " ");
    // Opening and leaving a cell without typing writes nothing.
    const changed = typed && text !== original;
    const found = changed && save ? resolveSession(view, session) : null;
    let saved = false;
    if (changed && save) {
      if (!found || view.state.readOnly) {
        window.alert(`The table changed while you were editing this cell, so your text was not saved:\n\n${text}`);
      } else {
        const range = cellRange(found.cell);
        const now = view.state.sliceDoc(range.from, range.to);
        if (now === original || window.confirm("A co-author changed this cell while you were editing it. Replace their text with yours?")) {
          dispatchAsOneStep(view, [setCellText(found.cell, text)], "input.visual.table");
          saved = true;
        }
      }
    }
    if (!saved) td.replaceChildren(...rendered);
    const at = found ?? (session.start !== null ? { table: tableAt(view, session.start), row, cellIndex } : null);
    const base = session.start;
    if (next !== 0 && base !== null && at) {
      requestAnimationFrame(() => {
        const rows = tableAt(view, base)?.model.rows;
        const sibling = findCell(view, base, at.row, at.cellIndex + next) ?? findCell(view, base, at.row + next, next > 0 ? 0 : (rows?.[at.row + next]?.cells.length ?? 1) - 1);
        if (sibling) editCell(view, sibling, () => base, Number(sibling.dataset.row), Number(sibling.dataset.cell));
        else view.focus();
      });
    } else view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finish(true); }
    else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? -1 : 1); }
  };
  const onBlur = () => finish(true);
  td.addEventListener("keydown", onKey, true);
  td.addEventListener("blur", onBlur);
  td.addEventListener("input", onInput);
}

function tableMenu(view: EditorView, event: MouseEvent, tableStart: () => number | null, row: number, cellIndex: number) {
  const start = tableStart();
  if (start === null) return;
  const table = tableAt(view, start);
  const clicked = table?.model.rows[row]?.cells[cellIndex];
  if (!table || !clicked) return;
  // The changes are planned again when an item is chosen, against the table as it is then:
  // a collaborator's edit while the menu is open moves the offsets.
  const session = openSession(view, start, clicked);
  type Plan = (model: TableModel, source: string, from: number, row: number, column: number) => TableChange[] | null;
  const items: Array<[string, Plan]> = [
    ["Insert row above", (model, source, from, r) => insertRow(model, source, from, r - 1)],
    ["Insert row below", (model, source, from, r) => insertRow(model, source, from, r)],
    ["Delete row", (model, source, from, r) => deleteRow(model, source, from, r)],
    ["Insert column left", (model, _source, _from, _r, column) => insertColumn(model, column - 1)],
    ["Insert column right", (model, _source, _from, _r, column) => insertColumn(model, column)],
    ["Delete column", (model, _source, _from, _r, column) => deleteColumn(model, column)],
  ];
  const columnOf = (model: TableModel, r: number, c: number) => {
    let column = 0;
    for (let i = 0; i < c; i++) column += model.rows[r]?.cells[i]?.span ?? 1;
    return column;
  };
  const planNow = (plan: Plan) => {
    const found = resolveSession(view, session);
    if (!found) return null;
    return plan(found.table.model, found.table.source, found.table.from, found.row, columnOf(found.table.model, found.row, found.cellIndex));
  };
  document.querySelector(".cm-vis-table-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "cm-vis-table-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 220)}px`;
  const close = () => { sessions.delete(session); menu.remove(); document.removeEventListener("mousedown", outside, true); };
  const outside = (down: MouseEvent) => { if (!menu.contains(down.target as Node)) close(); };
  for (const [label, plan] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    const planned = planNow(plan);
    if (!planned || !planned.length) {
      button.disabled = true;
      button.title = "Not possible here (a \\multicolumn spans it, or the column specification repeats)";
    }
    button.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const changes = view.state.readOnly ? null : planNow(plan);
      close();
      if (changes?.length) dispatchAsOneStep(view, changes, "input.visual.table");
      else if (planned?.length) window.alert("The table changed while this menu was open; nothing was changed. Try again.");
    });
    menu.append(button);
  }
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
}

/** Installs the table editor; the widgets call it through hooks. */
export function installTableEditor(): Extension {
  setTableHooks({ edit: editCell, menu: tableMenu });
  return sessionTracker;
}

/** Exported for tests: open a cell session and resolve it later. */
export const tableSessionsForTests = { openSession, resolveSession, sessionTracker };

/** Renders a cell's LaTeX (exported for tests). */
export function renderCell(view: EditorView, latex: string) {
  return renderLatexFragment(latex, fragmentContext(view));
}
