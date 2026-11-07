import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep as dispatchWidgetEdit } from "../../../collab/undo-boundary";
import { visualConfig } from "./model";
import { fragmentContext, setTableHooks, type TableElement } from "./widgets";
import { renderLatexFragment } from "./render-fragment";
import { deleteColumn, deleteRow, insertColumn, insertRow, parseTabular, setCellText, type TableChange, type TableModel } from "./table-model";

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

/**
 * An open cell editor, kept outside the cell's DOM: a co-author's edit to the
 * table redraws its widget, and the draft carries on in the new cell.
 */
type CellSession = { view: EditorView; start: number; row: number; cell: number; original: string; td: HTMLElement; abandon: () => void };
const cellSessions = new Set<CellSession>();

/** Maps open cell editors' table positions through every change, remote ones included. */
const cellSessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of cellSessions) if (session.view === update.view) session.start = update.changes.mapPos(session.start, 1);
});

/** Closes a view's cell editors and table menu without writing: the view is going away, or leaving the Visual mode. */
export function closeTableSessions(view: EditorView) {
  for (const session of [...cellSessions]) if (session.view === view) session.abandon();
  if (openMenu?.view === view) openMenu.close();
}

/** A redrawn table: an editor open in the old one continues in the matching cell, with its draft. */
function adoptCellSessions(view: EditorView, table: TableElement) {
  for (const session of [...cellSessions]) {
    if (session.view !== view || session.td.isConnected || table.liberaTableStart?.() !== session.start || !table.liberaTableStart) continue;
    const current = tableAt(view, session.start);
    // The cell with the text the editor started from (rows may have moved), else the same place.
    let row = session.row;
    let cell = session.cell;
    current?.model.rows.forEach((candidateRow, r) => candidateRow.cells.forEach((candidate, c) => {
      if (cellText(view, candidate) === session.original && (r !== session.row || c !== session.cell) && cellText(view, current.model.rows[session.row]?.cells[session.cell]) !== session.original) { row = r; cell = c; }
    }));
    const td = table.querySelector<HTMLElement>(`.cm-vis-table-cell[data-row="${row}"][data-cell="${cell}"]`);
    if (!td) continue;
    const draft = session.td.textContent ?? "";
    session.abandon();
    editCell(view, td, table.liberaTableStart, row, cell, { original: session.original, draft });
  }
}

function cellText(view: EditorView, cell: TableModel["rows"][number]["cells"][number] | undefined) {
  if (!cell) return null;
  return cell.contentFrom !== undefined ? view.state.sliceDoc(cell.contentFrom, cell.contentTo) : cell.text;
}

/** The cell element at (row, cell) of the table that now starts at `start`, after a redraw. */
function findCell(view: EditorView, start: number, row: number, cell: number) {
  for (const table of view.contentDOM.querySelectorAll<TableElement>(".cm-vis-table")) {
    if (table.liberaTableStart?.() !== start) continue;
    return table.querySelector<HTMLElement>(`.cm-vis-table-cell[data-row="${row}"][data-cell="${cell}"]`);
  }
  return null;
}

function editCell(view: EditorView, td: HTMLElement, tableStart: () => number | null, row: number, cellIndex: number, resume?: { original: string; draft: string }) {
  const begin = tableStart();
  if (begin === null || !canEdit(view)) return;
  const table = tableAt(view, begin);
  const cell = table?.model.rows[row]?.cells[cellIndex];
  if (!table || !cell || cell.sourceOnly) return;
  const original = resume?.original ?? cellText(view, cell)!;
  td.setAttribute("contenteditable", "true");
  td.spellcheck = false;
  td.textContent = resume?.draft ?? original;
  td.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(td);
  // A resumed draft keeps typing at its end.
  if (resume) range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  let done = false;
  const session: CellSession = { view, start: begin, row, cell: cellIndex, original, td, abandon: () => undefined };
  cellSessions.add(session);
  const detach = () => {
    done = true;
    cellSessions.delete(session);
    td.removeEventListener("keydown", onKey, true);
    td.removeEventListener("blur", onBlur);
    td.setAttribute("contenteditable", "false");
  };
  session.abandon = () => { if (!done) detach(); };
  /** The cell shows the source it has now (not what it showed when editing began). */
  const showCurrent = (text: string | null) => td.replaceChildren(renderLatexFragment(text ?? original, fragmentContext(view)));
  const finish = (save: boolean, next: -1 | 0 | 1 = 0) => {
    if (done) return;
    detach();
    const start = session.start;
    const text = (td.textContent ?? "").replace(/\s*\n\s*/g, " ").trim();
    // Find the cell again: edits elsewhere (a collaborator's too) may have moved it.
    const current = tableAt(view, start);
    const target = current?.model.rows[row]?.cells[cellIndex];
    const now = cellText(view, target);
    if (!save || text === original || !target || !canEdit(view) || (now !== original && !window.confirm("A co-author changed this cell while you were editing it. Replace their text with yours?"))) {
      showCurrent(now);
      if (!save || !target) { if (view.dom.isConnected) view.focus(); return; }
    } else {
      // Only the characters that changed are written.
      dispatchAsOneStep(view, [setCellText(target, text, now ?? undefined)], "input.visual.table");
    }
    if (next !== 0) {
      requestAnimationFrame(() => {
        const sibling = findCell(view, start, row, cellIndex + next) ?? findCell(view, start, row + next, next > 0 ? 0 : (current?.model.rows[row + next]?.cells.length ?? 1) - 1);
        if (sibling) editCell(view, sibling, () => start, Number(sibling.dataset.row), Number(sibling.dataset.cell));
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
}

function tableMenu(view: EditorView, event: MouseEvent, tableStart: () => number | null, row: number, cellIndex: number) {
  const start = tableStart();
  if (start === null) return;
  const table = tableAt(view, start);
  if (!table) return;
  const { model, source, from } = table;
  let column = 0;
  for (let i = 0; i < cellIndex; i++) column += model.rows[row]?.cells[i]?.span ?? 1;
  const items: Array<[string, () => TableChange[] | null]> = [
    ["Insert row above", () => insertRow(model, source, from, row - 1)],
    ["Insert row below", () => insertRow(model, source, from, row)],
    ["Delete row", () => deleteRow(model, source, from, row)],
    ["Insert column left", () => insertColumn(model, column - 1)],
    ["Insert column right", () => insertColumn(model, column)],
    ["Delete column", () => deleteColumn(model, column)],
  ];
  openMenu?.close();
  const menu = document.createElement("div");
  menu.className = "cm-vis-table-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Table");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 220)}px`;
  const returnFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    if (openMenu?.menu === menu) openMenu = null;
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (down: MouseEvent) => { if (!menu.contains(down.target as Node)) close(); };
  const buttons: HTMLButtonElement[] = [];
  for (const [label, changes] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = label;
    const planned = changes();
    if (!planned || !planned.length) {
      button.disabled = true;
      button.title = "Not possible here (a \\multicolumn spans it, or the column specification repeats)";
    }
    // Pressing keeps the focus where it is; the click (also from Enter or Space) acts.
    button.addEventListener("mousedown", (down) => down.preventDefault());
    button.addEventListener("click", (click) => {
      click.preventDefault();
      close();
      if (view.dom.isConnected) view.focus();
      if (planned?.length && canEdit(view)) dispatchAsOneStep(view, planned, "input.visual.table");
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
  return [cellSessionTracker];
}

/** Renders a cell's LaTeX (exported for tests). */
export function renderCell(view: EditorView, latex: string) {
  return renderLatexFragment(latex, fragmentContext(view));
}
