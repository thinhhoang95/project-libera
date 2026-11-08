import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { hashString } from "../../../macros/core";
import { definitionCounts } from "../../macros/definitions";
import { numberingEntryAt, type NumberingKind } from "../../macros/numbering";
import { resolveRelativeNotebookPath } from "../../project";
import { applyEquationNumbers } from "./math-render";
import { preambleOpenField, togglePreamble, visualAux, visualConfig, visualDefinitions, visualNumbering } from "./model";
import { bibLookup, citationText, stateReferenceText, labelTarget } from "./references";
import { renderLatexFragment, type FragmentContext } from "./render-fragment";
import { parseTabular } from "./table-model";

/* The widgets the Visual mode draws in place of LaTeX constructs
 * (docs/latex-visual-editor-plan.md §3). Widgets whose text depends on
 * numbering or the compiled `.aux` register a refresh, which the numbering
 * plugin calls when those change, so no decoration has to be rebuilt. */

type Refreshable = HTMLElement & { liberaVisRefresh?: (view: EditorView) => void };

/** Registers how an element updates its numbers; called once now (after mounting) and on every numbering change. */
function refreshable(dom: HTMLElement, view: EditorView, refresh: (view: EditorView) => void) {
  (dom as Refreshable).liberaVisRefresh = refresh;
  dom.setAttribute("data-vis-refresh", "");
  queueMicrotask(() => { if (dom.isConnected) refresh(view); });
}

/** Calls every visible widget's refresh. */
export function refreshVisualWidgets(view: EditorView) {
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>("[data-vis-refresh]")) (element as Refreshable).liberaVisRefresh?.(view);
}

export function fragmentContext(view: EditorView, pos?: number): FragmentContext {
  const state = view.state;
  return { defs: visualDefinitions(state), numbering: visualNumbering(state), aux: visualAux(state), bib: bibLookup(state), pos };
}

/** A fragment context at a widget's own position, so definitions written after it in the body do not apply. */
function widgetContext(view: EditorView, dom: HTMLElement, offset = 0) {
  const pos = widgetPos(view, dom);
  return fragmentContext(view, pos === null ? undefined : pos + offset);
}

/** The document position a widget's DOM stands at, or null when it is not in the view. */
function widgetPos(view: EditorView, dom: HTMLElement) {
  try {
    return dom.isConnected ? view.posAtDOM(dom) : null;
  } catch {
    return null;
  }
}

function el(tag: string, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

abstract class VisualWidget extends WidgetType {
  constructor(readonly key: string) { super(); }
  eq(other: WidgetType) { return other instanceof VisualWidget && other.constructor === this.constructor && other.key === this.key; }
}

/** A character LaTeX writes as a command (`\%`, `\ldots`, `--`). */
export class SymbolWidget extends VisualWidget {
  constructor(readonly text: string, readonly source: string, readonly className = "cm-vis-symbol") { super(`${text}\u0000${source}\u0000${className}`); }
  toDOM() {
    const span = el("span", this.className, this.text);
    span.title = this.source;
    return span;
  }
}

/** `\\`: a faint mark where the line breaks. */
export class LineBreakWidget extends VisualWidget {
  constructor() { super("br"); }
  toDOM() {
    const span = el("span", "cm-vis-linebreak", "↵");
    span.title = "\\\\ (line break)";
    return span;
  }
}

/** Selects a widget's whole range, so it can be deleted or opened with Enter. */
export function selectRange(view: EditorView, from: number, to: number) {
  view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: false });
  view.focus();
}

/** Puts the cursor before a chip's closing brace, inside it: its source shows, ready to edit the keys. */
function editKeysAt(view: EditorView, pos: number) {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

/** Puts the cursor strictly inside a construct, which shows its source. */
export function revealSourceAt(view: EditorView, from: number, to: number) {
  const inside = Math.min(to - 1, from + 1);
  view.dispatch({ selection: { anchor: Math.max(from, inside) }, scrollIntoView: true });
  view.focus();
}

export type MathOpener = (view: EditorView, from: number, to: number) => boolean;
let openMathEditor: MathOpener | null = null;
/** Set by math-edit.ts once MathLive editing is installed. */
export function setMathOpener(opener: MathOpener | null) { openMathEditor = opener; }

/** Short keys for KaTeX output, which is long: the same cached string gets the same key without hashing it again. */
const htmlKeys = new Map<string, string>();
function htmlKey(html: string) {
  let key = htmlKeys.get(html);
  if (key === undefined) {
    key = hashString(html);
    htmlKeys.set(html, key);
    if (htmlKeys.size > 3000) htmlKeys.delete(htmlKeys.keys().next().value!);
  }
  return key;
}

/** A formula drawn by KaTeX. `numberOffset` is where its environment starts relative to the widget, for its equation numbers. */
export class MathWidget extends VisualWidget {
  constructor(readonly html: string, readonly display: boolean, readonly block: boolean, readonly source: string, readonly numbered: boolean, readonly numberOffset: number, readonly length: number) {
    super(`${display ? 1 : 0}${block ? 1 : 0}${numbered ? 1 : 0}${numberOffset}:${length}\u0000${htmlKey(html)}\u0000${source}`);
  }
  toDOM(view: EditorView) {
    const dom = el(this.block ? "div" : "span", `cm-vis-math ${this.display ? "cm-vis-math-display" : "cm-vis-math-inline"}`);
    dom.innerHTML = this.html;
    dom.setAttribute("aria-label", this.source);
    dom.setAttribute("role", "img");
    if (this.numbered) {
      refreshable(dom, view, (target) => {
        const pos = widgetPos(target, dom);
        if (pos === null) return;
        const entry = numberingEntryAt(visualNumbering(target.state), pos + this.numberOffset, "equation");
        applyEquationNumbers(dom, entry?.rows ?? [], entry?.tagged);
      });
    }
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const from = widgetPos(view, dom);
      if (from === null) return;
      event.preventDefault();
      const to = from + this.length;
      if (event.altKey || !openMathEditor || !openMathEditor(view, from + this.numberOffset, to)) revealSourceAt(view, from + this.numberOffset, to);
    });
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.block ? 48 : -1; }
}

/** A citation, reference or label chip. */
export class ChipWidget extends VisualWidget {
  constructor(readonly kind: "cite" | "ref" | "label", readonly command: string, readonly keys: string[], readonly notes: { pre?: string; post?: string }, readonly length: number) {
    super(`${kind}\u0000${command}\u0000${keys.join(",")}\u0000${notes.pre ?? ""}\u0000${notes.post ?? ""}\u0000${length}`);
  }
  private text(view: EditorView) {
    if (this.kind === "label") return this.keys[0];
    if (this.kind === "cite") return citationText({ command: this.command, keys: this.keys, ...this.notes }, visualAux(view.state), bibLookup(view.state));
    return stateReferenceText(view.state, this.command, this.keys);
  }
  toDOM(view: EditorView) {
    const dom = el("span", `cm-vis-chip cm-vis-${this.kind}`);
    // Only a reference goes somewhere: click it (or select it and press Enter) to follow it, Alt-click to edit it.
    // Citations and labels open their source on a click, with the cursor after their keys.
    if (this.kind === "ref") {
      dom.setAttribute("role", "link");
      dom.setAttribute("aria-keyshortcuts", "Enter");
    }
    const update = (target: EditorView) => {
      dom.textContent = this.text(target);
      if (this.kind === "ref") {
        const missing = this.keys.some((key) => !labelTarget(key, visualNumbering(target.state), visualAux(target.state)));
        dom.classList.toggle("cm-vis-missing", missing);
        dom.title = `${this.command}{${this.keys.join(",")}}${missing ? " (label not found)" : ""}`;
        dom.setAttribute("aria-label", `Reference to ${dom.textContent}`);
      } else if (this.kind === "cite") {
        const bib = bibLookup(target.state);
        dom.title = this.keys.map((key) => { const entry = bib(key); return entry?.title ? `${key}: ${entry.title}` : key; }).join("\n");
        dom.setAttribute("aria-label", `Citation ${dom.textContent}`);
      } else {
        dom.title = `\\label{${this.keys[0]}}`;
      }
    };
    update(view);
    refreshable(dom, view, update);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from === null) return;
      if (this.kind !== "ref") { editKeysAt(view, from + this.length - 1); return; }
      if (event.altKey) { revealSourceAt(view, from, from + this.length); return; }
      if (followReference(view, this.keys[0])) return;
      selectRange(view, from, from + this.length);
    });
    return dom;
  }
  ignoreEvent() { return true; }
}

/** Moves the cursor to where a label is defined in this file; false when it is elsewhere or unknown. */
export function followReference(view: EditorView, key: string) {
  const target = labelTarget(key, visualNumbering(view.state), visualAux(view.state));
  if (!target || target.pos < 0) return false;
  view.dispatch({ selection: { anchor: target.pos }, effects: EditorView.scrollIntoView(target.pos, { y: "center" }) });
  view.focus();
  return true;
}

/** `\item`: a bullet, a number or a description label. */
export class ItemMarkerWidget extends VisualWidget {
  constructor(readonly label: string, readonly variant: "bullet" | "number" | "description", readonly depth: number) {
    super(`${variant}\u0000${depth}\u0000${label}`);
  }
  toDOM() {
    const dom = el("span", `cm-vis-item cm-vis-item-${this.variant}`, this.label);
    dom.style.setProperty("--vis-depth", String(this.depth));
    return dom;
  }
}

/** The hidden `\section{` of a heading, drawn as its number. */
export class HeadingNumberWidget extends VisualWidget {
  constructor(readonly level: string, readonly markup: string) { super(`${level}\u0000${markup}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-heading-number");
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "section");
      dom.textContent = entry?.number ? `${entry.number} ` : "";
    });
    return dom;
  }
}

/** A footnote's hidden `\footnote{`, drawn as its superscript number. */
export class FootnoteMarkWidget extends VisualWidget {
  constructor() { super("footnote"); }
  toDOM(view: EditorView) {
    const dom = el("sup", "cm-vis-footnote-mark");
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "footnote");
      dom.textContent = entry?.number ?? "*";
    });
    return dom;
  }
}

/** A use of one of the document's macros, drawn as its expansion. */
export class MacroWidget extends VisualWidget {
  constructor(readonly name: string, readonly expansion: string, readonly length: number, readonly fingerprint: string) {
    super(`${name}\u0000${expansion}\u0000${length}\u0000${fingerprint}`);
  }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-macro");
    dom.title = `\\${this.name}: Alt-click or Alt+Enter to edit`;
    const render = (target: EditorView) => {
      dom.replaceChildren(renderLatexFragment(this.expansion, widgetContext(target, dom)));
    };
    render(view);
    // Chips inside an expansion follow numbering changes too.
    refreshable(dom, view, render);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) revealSourceAt(view, from, from + this.length);
    });
    return dom;
  }
  ignoreEvent() { return true; }
}

/** A fixed part of a macro whose arguments stay editable ("[[" and "]]" of `\todo{…}`). */
export class MacroPieceWidget extends VisualWidget {
  constructor(readonly html: string, readonly name: string) { super(`${name}\u0000${html}`); }
  toDOM() {
    const dom = el("span", "cm-vis-macro-piece");
    dom.innerHTML = this.html;
    dom.title = `\\${this.name}`;
    return dom;
  }
}

/** `\ensuremath`-style macros and `\(…\)` with macros inside: covered by MathWidget. Images outside figures: */
export class ImageWidget extends VisualWidget {
  constructor(readonly path: string, readonly length: number, readonly base = "") { super(`${path}\u0000${length}\u0000${base}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-image-inline");
    renderImage(dom, view, this.path);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) (event.altKey ? revealSourceAt : selectRange)(view, from, from + this.length);
    });
    return dom;
  }
  ignoreEvent() { return true; }
}

/** The notebook path of a graphics file named in the document, from the compile root's directory, as TeX finds it. */
export function resolveGraphicsPath(view: EditorView, name: string) {
  return graphicsCandidates(view, name)[0] ?? null;
}

/** Where TeX looks for a graphics file: the compile root's directory, then each `\graphicspath` directory. */
export function graphicsCandidates(view: EditorView, name: string) {
  const config = view.state.facet(visualConfig);
  const base = config.rootPath || config.documentPath;
  const directories = ["", ...visualDefinitions(view.state).graphicsPaths];
  const found: string[] = [];
  for (const directory of directories) {
    const resolved = resolveRelativeNotebookPath(base, `${directory}${name.trim()}`);
    if (resolved && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

/** What image widgets resolve against, part of their keys so they redraw when it changes. */
export function graphicsBase(state: EditorView["state"]) {
  const config = state.facet(visualConfig);
  return `${config.rootPath || config.documentPath}`;
}

const pdfThumbnails = new Map<string, Promise<string | null>>();

async function pdfThumbnail(url: string): Promise<string | null> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ url }).promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 900 / Math.max(1, viewport.width));
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    void pdf.destroy();
  }
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "pdf", "svg", "gif", "webp", "eps"];

/** Draws a graphics file into `container`: an image, a PDF's first page, or a labelled placeholder. */
function renderImage(container: HTMLElement, view: EditorView, name: string, className = "cm-vis-image") {
  const config = view.state.facet(visualConfig);
  const resolvedPaths = graphicsCandidates(view, name);
  const placeholder = (message: string) => {
    container.replaceChildren(el("span", "cm-vis-image-placeholder", message));
  };
  if (!resolvedPaths.length) { placeholder(`${name} (outside the notebook)`); return; }
  const candidates = resolvedPaths.flatMap((resolved) => (/\.([a-z0-9]+)$/i.test(resolved) ? [resolved] : IMAGE_EXTENSIONS.map((ext) => `${resolved}.${ext}`)));
  const tryNext = (index: number) => {
    const path = candidates[index];
    if (!path) { placeholder(`${name} (not found)`); return; }
    const url = config.fileUrl(path);
    if (!url) { placeholder(name); return; }
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
    if (ext === "eps") { placeholder(`${name} (EPS: shown in the PDF only)`); return; }
    if (ext === "pdf") {
      let thumbnail = pdfThumbnails.get(url);
      if (!thumbnail) {
        thumbnail = pdfThumbnail(url).catch(() => null);
        pdfThumbnails.set(url, thumbnail);
        if (pdfThumbnails.size > 60) pdfThumbnails.delete(pdfThumbnails.keys().next().value!);
      }
      container.replaceChildren(el("span", "cm-vis-image-loading", name));
      void thumbnail.then((data) => {
        if (!data) { pdfThumbnails.delete(url); tryNext(index + 1); return; }
        const image = el("img", className) as HTMLImageElement;
        image.src = data;
        image.alt = name;
        container.replaceChildren(image);
      });
      return;
    }
    const image = el("img", className) as HTMLImageElement;
    image.alt = name;
    image.decoding = "async";
    image.loading = "lazy";
    image.onerror = () => tryNext(index + 1);
    image.src = url;
    container.replaceChildren(image);
  };
  tryNext(0);
}

export type FigureSpec = {
  env: string;
  images: Array<{ path: string; width?: string }>;
  caption: string | null;
  captionPos: number;
  /** Where the environment started when the widget was built (captionPos is relative to it). */
  start: number;
  /** The document's path when the widget was built: images resolve against it, so a moved file redraws. */
  base?: string;
  kind: "figure" | "table";
  /** Where the environment starts relative to the widget (indentation before it is replaced too). */
  numberOffset: number;
  length: number;
  /** For tables: the tabular sources inside, with their offsets relative to the widget. */
  tabulars?: Array<{ source: string; offset: number }>;
  captionAbove?: boolean;
};

function captionElement(view: EditorView, spec: FigureSpec) {
  const caption = el("div", "cm-vis-caption");
  const label = el("span", "cm-vis-caption-label");
  const text = el("span", "cm-vis-caption-text");
  caption.append(label, text);
  if (spec.caption !== null) text.append(renderLatexFragment(spec.caption, fragmentContext(view, spec.captionPos)));
  return { caption, label, text };
}

/** A figure or table environment: images or grids, and the numbered caption. */
export class FigureWidget extends VisualWidget {
  constructor(readonly spec: FigureSpec) { super(JSON.stringify(spec)); }
  toDOM(view: EditorView) {
    const spec = this.spec;
    const dom = el("div", `cm-vis-figure cm-vis-figure-${spec.kind}`);
    const { caption, label, text } = captionElement(view, spec);
    const body = el("div", "cm-vis-figure-body");
    for (const image of spec.images) {
      const frame = el("span", "cm-vis-figure-image");
      if (image.width) frame.style.setProperty("--vis-image-width", image.width);
      renderImage(frame, view, image.path);
      body.append(frame);
    }
    for (const tabular of spec.tabulars ?? []) body.append(renderTableGrid(view, tabular.source, () => {
      const pos = widgetPos(view, dom);
      return pos === null ? null : pos + tabular.offset;
    }));
    if (spec.caption !== null && spec.captionAbove) dom.append(caption, body); else dom.append(body);
    if (spec.caption !== null && !spec.captionAbove) dom.append(caption);
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos + spec.numberOffset, spec.kind);
      label.textContent = `${spec.kind === "figure" ? "Figure" : "Table"}${entry?.number ? ` ${entry.number}` : ""}: `;
      // References and citations in the caption follow numbering and the .aux too.
      if (spec.caption !== null && spec.caption.includes("\\")) {
        const captionPos = pos === null ? spec.captionPos : pos + spec.numberOffset + (spec.captionPos - spec.start);
        text.replaceChildren(renderLatexFragment(spec.caption, fragmentContext(target, captionPos)));
      }
    });
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".cm-vis-table-cell[contenteditable=true]")) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from === null) return;
      if (event.altKey || event.detail >= 2) revealSourceAt(view, from + spec.numberOffset, from + spec.length);
      else selectRange(view, from, from + spec.length);
    });
    return dom;
  }
  // The editor never handles events in here: clicks open editors, and an edited cell takes its own keys.
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.spec.kind === "figure" ? 260 : 160; }
}

export type TableHooks = {
  /** Makes a cell editable as its LaTeX source. */
  edit: (view: EditorView, cell: HTMLElement, tableStart: () => number | null, row: number, cell_: number) => void;
  /** Row and column commands for a cell (right-click). */
  menu: (view: EditorView, event: MouseEvent, tableStart: () => number | null, row: number, cell: number) => void;
  /** A redrawn table: continues a cell edit that was open in the table it replaces. */
  adopt?: (view: EditorView, table: TableElement) => void;
};
let tableHooks: TableHooks | null = null;
/** Set by table-edit.ts. */
export function setTableHooks(hooks: TableHooks | null) { tableHooks = hooks; }

/** A rendered table's start in the document, for finding it again after it is redrawn. */
export type TableElement = HTMLTableElement & { liberaTableStart?: () => number | null };

/** Whether a cell is open in the cell editor (table-edit.ts sets the attribute). */
export function isEditingCell(td: HTMLElement) {
  return td.getAttribute("contenteditable") === "true";
}

/** A tabular as a grid; cells render their LaTeX, and become editable through table-edit.ts. */
export function renderTableGrid(view: EditorView, source: string, start: () => number | null) {
  const model = parseTabular(source, 0);
  const table = el("table", "cm-vis-table") as TableElement;
  table.liberaTableStart = start;
  if (!model) { table.append(el("caption", "cm-vis-raw", source)); return table; }
  const context = fragmentContext(view);
  /** Cells whose LaTeX can show numbers, citations or macros, redrawn when those change. */
  const dynamic: Array<{ td: HTMLElement; text: string; from: number }> = [];
  const aligns = model.columns.map((column) => (column === "c" ? "center" : column === "r" ? "right" : "left"));
  model.rows.forEach((row, rowIndex) => {
    const tr = el("tr", "cm-vis-table-row");
    if (row.rulesBefore.length) tr.classList.add(row.rulesBefore.some((rule) => /toprule|bottomrule/.test(rule)) ? "cm-vis-rule-heavy" : "cm-vis-rule");
    let column = 0;
    row.cells.forEach((cell, cellIndex) => {
      const td = el("td", "cm-vis-table-cell") as HTMLTableCellElement;
      if (cell.span > 1) td.colSpan = cell.span;
      td.style.textAlign = cell.span > 1 ? "center" : aligns[column] ?? "left";
      const text = cell.contentFrom !== undefined ? source.slice(cell.contentFrom, cell.contentTo) : cell.text;
      td.append(renderLatexFragment(text, context));
      if (text.includes("\\")) dynamic.push({ td, text, from: cell.contentFrom ?? cell.from });
      td.dataset.row = String(rowIndex);
      td.dataset.cell = String(cellIndex);
      if (cell.sourceOnly) td.classList.add("cm-vis-table-source-only");
      td.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || isEditingCell(td)) return;
        event.preventDefault();
        event.stopPropagation();
        if (tableHooks && !cell.sourceOnly && !event.altKey && view.state.facet(visualConfig).editable() && !view.state.readOnly) { tableHooks.edit(view, td, start, rowIndex, cellIndex); return; }
        const base = start();
        if (base !== null) revealSourceAt(view, base + cell.from, base + cell.to + 1);
      });
      td.addEventListener("contextmenu", (event) => {
        if (!tableHooks || view.state.readOnly || !view.state.facet(visualConfig).editable()) return;
        event.preventDefault();
        event.stopPropagation();
        tableHooks.menu(view, event, start, rowIndex, cellIndex);
      });
      tr.append(td);
      column += cell.span;
    });
    table.append(tr);
  });
  if (model.rulesAfter.length) table.classList.add("cm-vis-table-closed");
  if (dynamic.length) {
    refreshable(table, view, (target) => {
      const base = start();
      for (const cell of dynamic) {
        // A cell being edited shows its source; it is redrawn when editing ends.
        if (isEditingCell(cell.td)) continue;
        cell.td.replaceChildren(renderLatexFragment(cell.text, fragmentContext(target, base === null ? undefined : base + cell.from)));
      }
    });
  }
  // A cell that was being edited when the table was redrawn (a co-author's edit) carries on in the new one.
  queueMicrotask(() => { if (table.isConnected) tableHooks?.adopt?.(view, table); });
  return table;
}

/** Opens the first editable cell of a table drawn in [from, to] (keyboard entry to the grid); false when there is none. */
export function editFirstCell(view: EditorView, from: number, to: number) {
  if (!tableHooks || view.state.readOnly || !view.state.facet(visualConfig).editable()) return false;
  for (const table of view.contentDOM.querySelectorAll<TableElement>(".cm-vis-table")) {
    const start = table.liberaTableStart?.();
    if (start === null || start === undefined || start < from || start >= to) continue;
    const cell = table.querySelector<HTMLElement>(".cm-vis-table-cell:not(.cm-vis-table-source-only)");
    if (!cell || !table.liberaTableStart) return false;
    tableHooks.edit(view, cell, table.liberaTableStart, Number(cell.dataset.row), Number(cell.dataset.cell));
    return true;
  }
  return false;
}

/** A tabular outside a table environment. */
export class TableWidget extends VisualWidget {
  constructor(readonly source: string, readonly offset: number, readonly length: number) { super(`${offset}\u0000${source}`); }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-tabular");
    dom.append(renderTableGrid(view, this.source, () => {
      const pos = widgetPos(view, dom);
      return pos === null ? null : pos + this.offset;
    }));
    dom.addEventListener("mousedown", (event) => {
      // A click in the cell being edited moves its caret.
      if (event.button !== 0 || (event.target as HTMLElement).closest(".cm-vis-table-cell[contenteditable=true]")) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) (event.altKey ? revealSourceAt : selectRange)(view, from, from + this.length);
    });
    return dom;
  }
  // The editor never handles events in here: clicks open editors, and an edited cell takes its own keys.
  ignoreEvent() { return true; }
  get estimatedHeight() { return 140; }
}

/** The preamble, folded into a summary; its header toggles the source. */
export class PreambleWidget extends VisualWidget {
  constructor(readonly open: boolean, readonly summary: string) { super(`${open ? 1 : 0}\u0000${summary}`); }
  toDOM(view: EditorView) {
    const dom = el("div", `cm-vis-preamble${this.open ? " cm-vis-preamble-open" : ""}`);
    const button = el("button", "cm-vis-preamble-toggle") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("aria-expanded", String(this.open));
    button.textContent = `${this.open ? "▾" : "▸"} Preamble`;
    const summary = el("span", "cm-vis-preamble-summary", this.summary);
    // Pressing keeps the editor's focus; the click (also from Enter or Space on the button) toggles.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      view.dispatch({ effects: togglePreamble.of(!view.state.field(preambleOpenField, false)) });
    });
    dom.append(button, summary);
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 34; }
}

/** The summary line of the preamble block: class, packages, macros, theorem types and problems. */
export function preambleSummary(view: EditorView | null, defs = view ? visualDefinitions(view.state) : null) {
  if (!defs) return "";
  const counts = definitionCounts(defs);
  const parts = [defs.documentClass ?? "no class", `${counts.packages} package${counts.packages === 1 ? "" : "s"}`, `${counts.macros} macro${counts.macros === 1 ? "" : "s"}`];
  if (counts.environments) parts.push(`${counts.environments} environment${counts.environments === 1 ? "" : "s"}`);
  if (counts.theorems) parts.push(`${counts.theorems} theorem type${counts.theorems === 1 ? "" : "s"}`);
  if (defs.problems.length) parts.push(`${defs.problems.length} problem${defs.problems.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** `\maketitle`: the title, authors and date from the preamble. */
export class TitleWidget extends VisualWidget {
  constructor(readonly title: string | null, readonly author: string | null, readonly date: string | null, readonly length: number) {
    super(JSON.stringify([title, author, date, length]));
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-title-block");
    const render = (target: EditorView) => {
      const context = widgetContext(target, dom);
      dom.replaceChildren();
      if (this.title !== null) { const title = el("div", "cm-vis-title"); title.append(renderLatexFragment(this.title, context)); dom.append(title); }
      if (this.author !== null) {
        const authors = el("div", "cm-vis-authors");
        for (const part of this.author.split(/\\(?:and|And|AND)(?![A-Za-z])/)) {
          if (!part.trim()) continue;
          const author = el("div", "cm-vis-author");
          author.append(renderLatexFragment(part.trim(), context));
          authors.append(author);
        }
        dom.append(authors);
      }
      if (this.date !== null) { const date = el("div", "cm-vis-date"); date.append(renderLatexFragment(this.date, context)); dom.append(date); }
    };
    render(view);
    refreshable(dom, view, render);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) (event.altKey ? revealSourceAt : selectRange)(view, from, from + this.length);
    });
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 120; }
}

/** The opening of a theorem, proof, abstract or user environment, drawn as its heading. */
export class EnvironmentHeaderWidget extends VisualWidget {
  constructor(readonly variant: "theorem" | "proof" | "abstract" | "user", readonly title: string, readonly note: string | null, readonly kind: NumberingKind | null, readonly numberOffset: number) {
    super(JSON.stringify([variant, title, note, kind, numberOffset]));
  }
  toDOM(view: EditorView) {
    const dom = el("span", `cm-vis-env-header cm-vis-env-header-${this.variant}`);
    const render = (target: EditorView) => {
      dom.replaceChildren();
      const context = widgetContext(target, dom);
      if (this.variant === "user") { dom.append(renderLatexFragment(this.title, context)); return; }
      const head = el("span", "cm-vis-env-title");
      let number = "";
      if (this.kind) {
        const pos = widgetPos(target, dom);
        const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos + this.numberOffset, this.kind);
        number = entry?.number ? ` ${entry.number}` : "";
      }
      head.append(renderLatexFragment(this.title, context), document.createTextNode(number));
      dom.append(head);
      if (this.note !== null) {
        const note = el("span", "cm-vis-env-note");
        note.append(document.createTextNode(" ("), renderLatexFragment(this.note, context), document.createTextNode(")"));
        dom.append(note);
      }
      if (this.variant !== "abstract") dom.append(document.createTextNode(". "));
    };
    render(view);
    refreshable(dom, view, render);
    return dom;
  }
}

/** The end of a proof (∎) or of a user environment (its end code). */
export class EnvironmentFooterWidget extends VisualWidget {
  constructor(readonly latex: string | null) { super(latex ?? "qed"); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-env-footer");
    if (this.latex === null) { dom.textContent = "∎"; return dom; }
    const latex = this.latex;
    const render = (target: EditorView) => dom.replaceChildren(renderLatexFragment(latex, widgetContext(target, dom)));
    render(view);
    refreshable(dom, view, render);
    return dom;
  }
}
