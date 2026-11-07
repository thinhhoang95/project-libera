import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
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

function editCell(view: EditorView, td: HTMLElement, tableStart: () => number | null, row: number, cellIndex: number) {
  const start = tableStart();
  if (start === null) return;
  const table = tableAt(view, start);
  const cell = table?.model.rows[row]?.cells[cellIndex];
  if (!table || !cell || cell.sourceOnly) return;
  const original = cell.contentFrom !== undefined ? view.state.sliceDoc(cell.contentFrom, cell.contentTo) : cell.text;
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
  const finish = (save: boolean, next: -1 | 0 | 1 = 0) => {
    if (done) return;
    done = true;
    td.removeEventListener("keydown", onKey, true);
    td.removeEventListener("blur", onBlur);
    td.contentEditable = "false";
    const text = (td.textContent ?? "").replace(/\s*\n\s*/g, " ").trim();
    // Find the cell again: edits elsewhere (a collaborator's too) may have moved it.
    const current = tableAt(view, start);
    const target = current?.model.rows[row]?.cells[cellIndex];
    const now = target ? (target.contentFrom !== undefined ? view.state.sliceDoc(target.contentFrom, target.contentTo) : target.text) : null;
    if (!save || text === original || !target || (now !== original && !window.confirm("A co-author changed this cell while you were editing it. Replace their text with yours?"))) {
      td.replaceChildren(...rendered);
      if (!save || !target) { view.focus(); return; }
    } else {
      dispatchAsOneStep(view, [setCellText(target, text)], "input.visual.table");
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
  const onBlur = () => finish(true);
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
  document.querySelector(".cm-vis-table-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "cm-vis-table-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 220)}px`;
  const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); };
  const outside = (down: MouseEvent) => { if (!menu.contains(down.target as Node)) close(); };
  for (const [label, changes] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    const planned = changes();
    if (!planned || !planned.length) {
      button.disabled = true;
      button.title = "Not possible here (a \\multicolumn spans it, or the column specification repeats)";
    }
    button.addEventListener("mousedown", (down) => {
      down.preventDefault();
      close();
      if (planned?.length) dispatchAsOneStep(view, planned, "input.visual.table");
    });
    menu.append(button);
  }
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
}

/** Installs the table editor; the widgets call it through hooks. */
export function installTableEditor(): Extension {
  setTableHooks({ edit: editCell, menu: tableMenu });
  return [];
}

/** Renders a cell's LaTeX (exported for tests). */
export function renderCell(view: EditorView, latex: string) {
  return renderLatexFragment(latex, fragmentContext(view));
}
