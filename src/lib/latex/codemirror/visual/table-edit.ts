import { syntaxTree } from "@codemirror/language";
import { MapMode, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep as dispatchWidgetEdit } from "../../../collab/undo-boundary";
import { visualConfig } from "./model";
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

/** One undo step that does not merge with typing, on local and shared tabs alike (suggest mode's history too). */
function dispatchAsOneStep(view: EditorView, changes: TableChange[], userEvent: string) {
  dispatchWidgetEdit(view, { changes, userEvent });
}

/** Whether the view may still be edited through the grid (a viewer, a read-only tab, or a closed view may not). */
function canEdit(view: EditorView) {
  return view.dom.isConnected && !view.state.readOnly && view.state.facet(visualConfig).editable();
}

/** A cell's editable text range: a \multicolumn's content, or the cell's text. */
function cellRange(cell: TableCell) {
  return cell.contentFrom !== undefined && cell.contentTo !== undefined ? { from: cell.contentFrom, to: cell.contentTo } : { from: cell.from, to: cell.to };
}

function cellText(view: EditorView, cell: TableCell | undefined) {
  if (!cell) return null;
  const range = cellRange(cell);
  return view.state.sliceDoc(range.from, range.to);
}

/**
 * An open cell editor or row/column menu: the table's start and the cell's
 * text range, mapped through every change (a collaborator's too), so a save
 * or a menu command finds the same table and cell, or knows they are gone.
 */
type TableSession = { view: EditorView; start: number | null; cellFrom: number | null; cellTo: number | null };
/**
 * An open cell editor, kept outside the cell's DOM: a co-author's edit to the
 * table redraws its widget, and the draft carries on in the new cell.
 */
type CellSession = TableSession & { row: number; cell: number; original: string; typed: boolean; td: HTMLElement; abandon: () => void };
const sessions = new Set<TableSession>();
const cellSessions = new Set<CellSession>();

/** Maps open editors' and menus' positions through every change, remote ones included; a deleted one becomes null. */
const sessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of [...sessions, ...cellSessions]) {
    if (session.view !== update.view) continue;
    const map = (pos: number | null, assoc: -1 | 1) => (pos === null ? null : update.changes.mapPos(pos, assoc, MapMode.TrackDel));
    session.start = map(session.start, 1);
    session.cellFrom = map(session.cellFrom, -1);
    session.cellTo = map(session.cellTo, 1);
  }
});

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

/** Closes a view's cell editors and table menu without writing: the view is going away, or leaving the Visual mode. */
export function closeTableSessions(view: EditorView) {
  for (const session of [...cellSessions]) if (session.view === view) session.abandon();
  if (openMenu?.view === view) openMenu.close();
}

/** A redrawn table: an editor open in the old one continues in the same cell, with its draft. */
function adoptCellSessions(view: EditorView, table: TableElement) {
  for (const session of [...cellSessions]) {
    if (session.view !== view || session.td.isConnected || !table.liberaTableStart || table.liberaTableStart() !== session.start) continue;
    // The cell the editor's text range maps to, else the same place in the grid.
    const found = resolveSession(view, session);
    const row = found?.row ?? session.row;
    const cell = found?.cellIndex ?? session.cell;
    const td = table.querySelector<HTMLElement>(`.cm-vis-table-cell[data-row="${row}"][data-cell="${cell}"]`);
    if (!td) continue;
    const draft = session.td.textContent ?? "";
    const { original, typed } = session;
    session.abandon();
    editCell(view, td, table.liberaTableStart, row, cell, { original, draft, typed });
  }
}

/** The cell element at (row, cell) of the table that now starts at `start`, after a redraw. */
function findCell(view: EditorView, start: number, row: number, cell: number) {
  for (const table of view.contentDOM.querySelectorAll<TableElement>(".cm-vis-table")) {
    if (table.liberaTableStart?.() !== start) continue;
    return table.querySelector<HTMLElement>(`.cm-vis-table-cell[data-row="${row}"][data-cell="${cell}"]`);
  }
  return null;
}

function editCell(view: EditorView, td: HTMLElement, tableStart: () => number | null, row: number, cellIndex: number, resume?: { original: string; draft: string; typed: boolean }) {
  const begin = tableStart();
  if (begin === null || !canEdit(view)) return;
  const table = tableAt(view, begin);
  const cell = table?.model.rows[row]?.cells[cellIndex];
  if (!table || !cell || cell.sourceOnly) return;
  const range = cellRange(cell);
  const original = resume?.original ?? view.state.sliceDoc(range.from, range.to);
  td.setAttribute("contenteditable", "true");
  td.spellcheck = false;
  td.textContent = resume?.draft ?? original;
  td.focus();
  const selection = window.getSelection();
  const domRange = document.createRange();
  domRange.selectNodeContents(td);
  // A resumed draft keeps typing at its end.
  if (resume) domRange.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(domRange);
  let done = false;
  const session: CellSession = {
    view, start: begin, cellFrom: range.from, cellTo: range.to, row, cell: cellIndex, original, typed: resume?.typed ?? false, td, abandon: () => undefined,
  };
  cellSessions.add(session);
  const onInput = () => { session.typed = true; };
  const detach = () => {
    done = true;
    cellSessions.delete(session);
    td.removeEventListener("keydown", onKey, true);
    td.removeEventListener("blur", onBlur);
    td.removeEventListener("input", onInput);
    td.setAttribute("contenteditable", "false");
  };
  session.abandon = () => { if (!done) detach(); };
  /** The cell shows the source it has now (not what it showed when editing began). */
  const showCurrent = (text: string | null) => td.replaceChildren(renderLatexFragment(text ?? original, fragmentContext(view)));
  const finish = (save: boolean, next: -1 | 0 | 1 = 0) => {
    if (done) return;
    detach();
    // The text as typed. Editable elements turn spaces into no-break spaces; the cell had plain ones.
    let text = td.textContent ?? "";
    if (!original.includes(" ")) text = text.replace(/ /g, " ");
    // Find the cell again: edits elsewhere (a collaborator's too) may have moved it.
    const found = resolveSession(view, session);
    const now = found ? cellText(view, found.cell) : null;
    // Opening and leaving a cell without typing writes nothing.
    if (save && session.typed && text !== original) {
      if (!found || !canEdit(view)) {
        showCurrent(now);
        window.alert(`The table changed while you were editing this cell, so your text was not saved:\n\n${text}`);
      } else if (now === original || window.confirm("A co-author changed this cell while you were editing it. Replace their text with yours?")) {
        // Only the characters that changed are written.
        dispatchAsOneStep(view, [setCellText(found.cell, text, now ?? undefined)], "input.visual.table");
      } else showCurrent(now);
    } else showCurrent(now);
    const base = session.start;
    const at = found ? { row: found.row, cellIndex: found.cellIndex } : { row, cellIndex };
    if (save && next !== 0 && base !== null) {
      requestAnimationFrame(() => {
        const rows = tableAt(view, base)?.model.rows;
        const sibling = findCell(view, base, at.row, at.cellIndex + next) ?? findCell(view, base, at.row + next, next > 0 ? 0 : (rows?.[at.row + next]?.cells.length ?? 1) - 1);
        if (sibling) editCell(view, sibling, () => base, Number(sibling.dataset.row), Number(sibling.dataset.cell));
        else view.focus();
      });
    } else if (view.dom.isConnected) view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finish(true); }
    else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? -1 : 1); }
  };
  const onBlur = () => {
    // Removed from the page because the table was redrawn: the new table adopts the draft (adoptCellSessions).
    if (!td.isConnected) {
      requestAnimationFrame(() => { if (!done && !td.isConnected) session.abandon(); });
      return;
    }
    finish(true);
  };
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
  const clickedRange = cellRange(clicked);
  const session: TableSession = { view, start, cellFrom: clickedRange.from, cellTo: clickedRange.to };
  sessions.add(session);
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
  openMenu?.close();
  const menu = document.createElement("div");
  menu.className = "cm-vis-table-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Table");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 220)}px`;
  const returnFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    sessions.delete(session);
    if (openMenu?.menu === menu) openMenu = null;
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (down: MouseEvent) => { if (!menu.contains(down.target as Node)) close(); };
  const buttons: HTMLButtonElement[] = [];
  for (const [label, plan] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = label;
    const planned = planNow(plan);
    if (!planned || !planned.length) {
      button.disabled = true;
      button.title = "Not possible here (a \\multicolumn spans it, or the column specification repeats)";
    }
    // Pressing keeps the focus where it is; the click (also from Enter or Space) acts.
    button.addEventListener("mousedown", (down) => down.preventDefault());
    button.addEventListener("click", (click) => {
      click.preventDefault();
      const changes = canEdit(view) ? planNow(plan) : null;
      close();
      if (view.dom.isConnected) view.focus();
      if (changes?.length) dispatchAsOneStep(view, changes, "input.visual.table");
      else if (planned?.length && canEdit(view)) window.alert("The table changed while this menu was open; nothing was changed. Try again.");
    });
    buttons.push(button);
    menu.append(button);
  }
  // A menu from the keyboard too: arrows move, Escape closes and returns the focus.
  menu.addEventListener("keydown", (key) => {
    const enabled = buttons.filter((button) => !button.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (key.key === "Escape") { key.preventDefault(); close(); returnFocus?.focus(); }
    else if (key.key === "ArrowDown" || key.key === "ArrowUp") {
      key.preventDefault();
      enabled[(index + (key.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]?.focus();
    } else if (key.key === "Home" || key.key === "End") { key.preventDefault(); (key.key === "Home" ? enabled[0] : enabled.at(-1))?.focus(); }
    else if (key.key === "Tab") { key.preventDefault(); close(); returnFocus?.focus(); }
  });
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
  openMenu = { view, menu, close };
  buttons.find((button) => !button.disabled)?.focus();
}

let openMenu: { view: EditorView; menu: HTMLElement; close: () => void } | null = null;

/** Installs the table editor; the widgets call it through hooks. */
export function installTableEditor(): Extension {
  setTableHooks({ edit: editCell, menu: tableMenu, adopt: adoptCellSessions });
  return [sessionTracker];
}

/** Renders a cell's LaTeX (exported for tests). */
export function renderCell(view: EditorView, latex: string) {
  return renderLatexFragment(latex, fragmentContext(view));
}
