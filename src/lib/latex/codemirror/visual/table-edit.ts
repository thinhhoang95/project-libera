import { syntaxTree } from "@codemirror/language";
import { MapMode, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep as dispatchWidgetEdit } from "../../../collab/undo-boundary";
import { visualConfig, visualDefinitions } from "./model";
import { fragmentContext, setTableHooks, type TableElement } from "./widgets";import { renderLatexFragment } from "./render-fragment";
import { isTabular, rowMacroNames } from "./walk";
import {
  addRule, columnOfCell, deleteColumn, deleteRow, insertColumn, insertRow, mergeCells, moveColumn, moveRow, parseTabular, removeRules, safeCellText, setCellText, setColumnAlignment, splitCell,
  type TableCell, type TableChange, type TableModel,
} from "./table-model";

/* Editing tables in the grid (docs/latex-visual-editor-plan.md §6.3). A cell
 * becomes its LaTeX source while it is edited, and saving rewrites only that
 * cell. Row and column commands write the fewest changes, in one transaction
 * that undoes as one step. */

/** The tabular starting at `start` in the current document, with its cell map. */
function tableAt(view: EditorView, start: number): { model: TableModel; source: string; from: number } | null {
  const tree = syntaxTree(view.state);
  for (let node = tree.resolveInner(start + 1, -1) as ReturnType<typeof tree.resolveInner> | null; node; node = node.parent) {
    if (node.from === start && isTabular(node, (from, to) => view.state.sliceDoc(from, to))) {
      const source = view.state.sliceDoc(node.from, node.to);
      const model = parseTabular(source, node.from, visualDefinitions(view.state).columnTypes);
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
  // Any edit redraws or moves the grid: the selection of cells ends.
  if (cellSelection?.view === update.view) cellSelection = null;
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
  // The selection would keep a destroyed view (its state, document and detached DOM) alive until the next cell click anywhere.
  if (cellSelection?.view === view) cellSelection = null;
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
  if (!table || !cell) return;
  // The cell is where a selection of cells (Shift-click) starts.
  cellSelection = { view, start: begin, anchor: { row, column: columnOfCell(table.model.rows[row], cellIndex) }, focus: null };
  paintSelection(view);
  // A cell with a comment or a line break opens as its source over several lines (Shift+Enter starts one).
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
        // A comment typed at the end must not hide the `&` or `\\` after the cell.
        const end = cellRange(found.cell).to;
        text = safeCellText(text, view.state.sliceDoc(end, view.state.doc.lineAt(end).to));
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
    else if (event.key === "Enter" && event.shiftKey) {
      // A line break in the cell's source (after a comment, or for a long cell), as plain text.
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const domRange = selection.getRangeAt(0);
      domRange.deleteContents();
      const line = document.createTextNode("\n");
      domRange.insertNode(line);
      domRange.setStartAfter(line);
      domRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(domRange);
      session.typed = true;
    } else if (event.key === "Enter") { event.preventDefault(); finish(true); }
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
  type Plan = (model: TableModel, source: string, from: number, row: number, column: number, cellIndex: number) => TableChange[] | null;
  /** A plan that adds or removes cells in rows: not for a table with rows its macros write (their cells are in the macro). */
  const everyRow = (plan: Plan): Plan => (model, source, from, r, column, cellIndex) => (hasMacroRows(view, model, source, from) ? null : plan(model, source, from, r, column, cellIndex));
  /** The selected cells (Shift-click) when the clicked cell is among them. */
  const selected = () => {
    if (!cellSelection || cellSelection.view !== view || cellSelection.start !== session.start || !cellSelection.focus) return null;
    const { anchor, focus } = cellSelection;
    return { r1: Math.min(anchor.row, focus.row), r2: Math.max(anchor.row, focus.row), c1: Math.min(anchor.column, focus.column), c2: Math.max(anchor.column, focus.column) };
  };
  const selectedBlock = selected();
  const clickedColumn = columnOfCell(table.model.rows[row], cellIndex);
  const block = selectedBlock && row >= selectedBlock.r1 && row <= selectedBlock.r2 && clickedColumn >= selectedBlock.c1 && clickedColumn <= selectedBlock.c2 ? selectedBlock : null;
  const inBlock = !!block;
  const items: Array<[string, Plan] | "-"> = [
    ["Insert row above", (model, source, from, r) => insertRow(model, source, from, r - 1)],
    ["Insert row below", (model, source, from, r) => insertRow(model, source, from, r)],
    ["Delete row", (model, source, from, r) => deleteRow(model, source, from, r)],
    ["Move row up", (model, source, from, r) => moveRow(model, source, from, r, -1)],
    ["Move row down", (model, source, from, r) => moveRow(model, source, from, r, 1)],
    "-",
    ["Insert column left", everyRow((model, _source, _from, _r, column) => insertColumn(model, column - 1))],
    ["Insert column right", everyRow((model, _source, _from, _r, column) => insertColumn(model, column))],
    ["Delete column", everyRow((model, _source, _from, _r, column) => deleteColumn(model, column))],
    ["Move column left", everyRow((model, source, from, _r, column) => moveColumn(model, source, from, column, -1))],
    ["Move column right", everyRow((model, source, from, _r, column) => moveColumn(model, source, from, column, 1))],
    ["Align column left", (model, _source, _from, _r, column) => setColumnAlignment(model, column, "l")],
    ["Align column center", (model, _source, _from, _r, column) => setColumnAlignment(model, column, "c")],
    ["Align column right", (model, _source, _from, _r, column) => setColumnAlignment(model, column, "r")],
    "-",
    inBlock && block
      ? ["Merge selected cells", everyRow((model, source, from) => mergeCells(model, source, from, block.r1, block.r2, block.c1, block.c2))]
      : ["Merge with cell right", everyRow((model, source, from, r, column, c) => mergeCells(model, source, from, r, r, column, column + (model.rows[r]?.cells[c]?.span ?? 1)))],
    ["Merge with cell below", everyRow((model, source, from, r, column, c) => mergeCells(model, source, from, r, r + 1, column, column + (model.rows[r]?.cells[c]?.span ?? 1) - 1))],
    ["Split cell", (model, source, from, r, _column, c) => splitCell(model, source, from, r, c)],
    "-",
    ["Add rule above", (model, source, from, r) => addRule(model, source, from, r)],
    ["Add rule below", (model, source, from, r) => addRule(model, source, from, r, true)],
    ["Remove rules above", (model, source, from, r) => removeRules(model, source, from, r)],
    ["Remove rules below", (model, source, from, r) => removeRules(model, source, from, r, true)],
  ];
  const planNow = (plan: Plan) => {
    const found = resolveSession(view, session);
    if (!found) return null;
    return plan(found.table.model, found.table.source, found.table.from, found.row, columnOfCell(found.table.model.rows[found.row], found.cellIndex), found.cellIndex);
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
  for (const item of items) {
    if (item === "-") {
      const separator = document.createElement("div");
      separator.className = "cm-vis-table-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
      continue;
    }
    const [label, plan] = item;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = label;
    const planned = planNow(plan);
    if (!planned || !planned.length) {
      button.disabled = true;
      button.title = "Not possible here (a \\multicolumn or \\multirow is in the way, the column specification repeats, or rows are written through macros)";
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
  // Kept on screen whatever its height.
  const height = menu.offsetHeight;
  if (height) menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  document.addEventListener("mousedown", outside, true);
  openMenu = { view, menu, close };
  buttons.find((button) => !button.disabled)?.focus();
}

let openMenu: { view: EditorView; menu: HTMLElement; close: () => void } | null = null;

/** Whether some row of the table is written through the document's macros (`\row{a}{b}`): its cells are in the macro. */
function hasMacroRows(view: EditorView, model: TableModel, source: string, from: number) {
  const names = rowMacroNames(visualDefinitions(view.state));
  if (!names.size) return false;
  return model.rows.some((row) => [...source.slice(row.from - from, row.to - from).matchAll(/\\([A-Za-z@]+)/g)].some((use) => names.has(use[1])));
}

/** Cells selected for merging: the cell opened last (`anchor`) to the cell Shift-clicked (`focus`), by row and column. */
let cellSelection: { view: EditorView; start: number; anchor: { row: number; column: number }; focus: { row: number; column: number } | null } | null = null;

/** Marks the selected cells in the grid (and unmarks the others). */
function paintSelection(view: EditorView) {
  for (const marked of view.contentDOM.querySelectorAll(".cm-vis-table-selected")) marked.classList.remove("cm-vis-table-selected");
  const selection = cellSelection;
  if (!selection || selection.view !== view || !selection.focus) return;
  const table = tableAt(view, selection.start);
  if (!table) return;
  const r1 = Math.min(selection.anchor.row, selection.focus.row);
  const r2 = Math.max(selection.anchor.row, selection.focus.row);
  const c1 = Math.min(selection.anchor.column, selection.focus.column);
  const c2 = Math.max(selection.anchor.column, selection.focus.column);
  for (const grid of view.contentDOM.querySelectorAll<TableElement>(".cm-vis-table")) {
    if (grid.liberaTableStart?.() !== selection.start) continue;
    for (const td of grid.querySelectorAll<HTMLElement>(".cm-vis-table-cell[data-row]")) {
      const r = Number(td.dataset.row);
      const row = table.model.rows[r];
      const c = Number(td.dataset.cell);
      if (!row?.cells[c] || r < r1 || r > r2) continue;
      const column = columnOfCell(row, c);
      if (column <= c2 && column + row.cells[c].span - 1 >= c1) td.classList.add("cm-vis-table-selected");
    }
  }
}

/** Shift-click on a cell: the selection runs from the cell opened last to it (a new one starts at it). */
function selectCell(view: EditorView, _td: HTMLElement, tableStart: () => number | null, row: number, cellIndex: number) {
  const start = tableStart();
  if (start === null) return;
  const table = tableAt(view, start);
  const cells = table?.model.rows[row];
  if (!table || !cells?.cells[cellIndex]) return;
  const at = { row, column: columnOfCell(cells, cellIndex) };
  if (cellSelection?.view === view && cellSelection.start === start) cellSelection.focus = at;
  else cellSelection = { view, start, anchor: at, focus: at };
  paintSelection(view);
}

/** Installs the table editor; the widgets call it through hooks. */
export function installTableEditor(): Extension {
  setTableHooks({ edit: editCell, menu: tableMenu, adopt: adoptCellSessions, select: selectCell });
  return [sessionTracker];
}

/** Opens the table menu for a cell (exported for tests, which have no right-click). */
export function openTableMenu(view: EditorView, event: MouseEvent, tableStart: () => number | null, row: number, cellIndex: number) {
  tableMenu(view, event, tableStart, row, cellIndex);
}

/** Renders a cell's LaTeX (exported for tests). */
export function renderCell(view: EditorView, latex: string) {
  return renderLatexFragment(latex, fragmentContext(view));
}
