import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { hashString } from "../../../macros/core";
import { definitionCounts } from "../../macros/definitions";
import { expandLatexMacroUse } from "../../macros/expand";
import { numberingEntryAt, type NumberingKind } from "../../macros/numbering";
import { resolveRelativeNotebookPath } from "../../project";
import { applyEquationNumbers, renderKatex } from "./math-render";
import { preambleOpenField, togglePreamble, visualAux, visualConfig, visualDefinitions, visualNumbering } from "./model";
import { latexProjectField } from "../editing";
import { bibLookup, citationText, plainTexText, stateReferenceText, labelTarget, withReferenceNumbers } from "./references";
import { renderLatexFragment, renderLatexInto, type FragmentContext } from "./render-fragment";
import { cssColor } from "./symbols";
import { parseTabular } from "./table-model";
import type { AlgorithmSpec } from "./algorithm";

/* The widgets the Visual mode draws in place of LaTeX constructs
 * (docs/latex-visual-editor-plan.md §3). Widgets whose text depends on
 * numbering or the compiled `.aux` register a refresh, which the numbering
 * plugin calls when those change, so no decoration has to be rebuilt. */

/** An element that shows numbers: how it updates them, and where it was when it last did. */
type Refreshable = HTMLElement & { liberaVisRefresh?: (view: EditorView) => void; liberaVisAt?: number | null };

/** Registers how an element updates its numbers; called once now (after mounting) and on every numbering change. */
function refreshable(dom: HTMLElement, view: EditorView, refresh: (view: EditorView) => void) {
  (dom as Refreshable).liberaVisRefresh = refresh;
  dom.setAttribute("data-vis-refresh", "");
  queueMicrotask(() => { if (dom.isConnected) { (dom as Refreshable).liberaVisAt = widgetPos(view, dom); refresh(view); } });
}

/**
 * Calls every visible widget's refresh. With `moved`, only those now somewhere else than when they last
 * refreshed: the editor reuses an equal widget's DOM for another place (every `\section` number is equal).
 */
export function refreshVisualWidgets(view: EditorView, moved = false) {
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>("[data-vis-refresh]")) {
    const widget = element as Refreshable;
    const at = widgetPos(view, element);
    if (moved && at === widget.liberaVisAt) continue;
    widget.liberaVisAt = at;
    widget.liberaVisRefresh?.(view);
  }
}

export function fragmentContext(view: EditorView, pos?: number): FragmentContext {
  const state = view.state;
  return {
    defs: visualDefinitions(state), numbering: visualNumbering(state), aux: visualAux(state), bib: bibLookup(state), pos,
    // Images in table cells and captions, found as the figure's are.
    image: (path, width) => {
      const frame = el("span", "cm-vis-figure-image cm-vis-inline-image");
      if (width) frame.style.setProperty("--vis-image-width", width);
      renderImage(frame, view, path);
      return frame;
    },
    // A tabular nested in a cell: a small read-only grid (clicks go to the cell around it).
    tabular: (source) => {
      const grid = renderTableGrid(view, source, () => null, 0);
      grid.classList.add("cm-vis-table-nested");
      return grid;
    },
  };
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

/**
 * A formula drawn by KaTeX. `numberOffset` is where its environment starts relative to the widget, for its equation numbers.
 * `referenced`: the formula's LaTeX when it has `\ref`s, drawn again with their numbers when numbering changes.
 */
export class MathWidget extends VisualWidget {
  constructor(readonly html: string, readonly display: boolean, readonly block: boolean, readonly source: string, readonly numbered: boolean, readonly numberOffset: number, readonly length: number, readonly referenced: string | null = null) {
    super(`${display ? 1 : 0}${block ? 1 : 0}${numbered ? 1 : 0}${referenced === null ? 0 : 1}${numberOffset}:${length}\u0000${htmlKey(html)}\u0000${source}`);
  }
  toDOM(view: EditorView) {
    const dom = el(this.block ? "div" : "span", `cm-vis-math ${this.display ? "cm-vis-math-display" : "cm-vis-math-inline"}`);
    dom.innerHTML = this.html;
    dom.setAttribute("aria-label", this.source);
    dom.setAttribute("role", "img");
    if (this.numbered || this.referenced !== null) {
      let shown = this.html;
      refreshable(dom, view, (target) => {
        if (this.referenced !== null) {
          const html = renderKatex(withReferenceNumbers(this.referenced, target.state), this.display);
          if (html !== null && html !== shown) { dom.innerHTML = html; shown = html; }
        }
        if (!this.numbered) return;
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
  /** `index`: an `\index{…}` or `\glossary{…}` entry, which the PDF does not show where it is: a small grey tag, as a label. */
  constructor(readonly kind: "cite" | "ref" | "label" | "index", readonly command: string, readonly keys: string[], readonly notes: { pre?: string; post?: string }, readonly length: number) {
    super(`${kind}\u0000${command}\u0000${keys.join(",")}\u0000${notes.pre ?? ""}\u0000${notes.post ?? ""}\u0000${length}`);
  }
  private text(view: EditorView) {
    if (this.kind === "label") return this.keys[0];
    // makeidx's `sort@shown!sub` entries: what each level shows.
    if (this.kind === "index") return this.keys[0].split("!").map((level) => level.slice(level.lastIndexOf("@") + 1).replace(/\|.*$/, "")).join(" › ");
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
        dom.title = `${this.command}{${this.keys[0]}}`;
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

/** A heading written by one of the document's macros (`\mysec{Title}` for `\section{Title}`): its number and title. */
export class MacroHeadingWidget extends VisualWidget {
  constructor(readonly title: string, readonly length: number) { super(`${title}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-macro-heading");
    const number = el("span", "cm-vis-heading-number");
    const title = el("span");
    dom.append(number, title);
    const render = (target: EditorView) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "section");
      number.textContent = entry?.number ? `${entry.number} ` : "";
      title.replaceChildren(renderLatexFragment(this.title, widgetContext(target, dom)));
    };
    render(view);
    refreshable(dom, view, render);
    revealOnClick(view, dom, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
}

/** A footnote written by one of the document's macros (`\fn{text}`): its number and its text. */
export class MacroFootnoteWidget extends VisualWidget {
  constructor(readonly text: string, readonly length: number) { super(`${text}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-macro-footnote");
    const mark = el("sup", "cm-vis-footnote-mark");
    const text = el("span", "cm-vis-footnote");
    dom.append(mark, text);
    const render = (target: EditorView) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "footnote");
      mark.textContent = entry?.number ?? "*";
      text.replaceChildren(renderLatexFragment(this.text, widgetContext(target, dom)));
    };
    render(view);
    refreshable(dom, view, render);
    revealOnClick(view, dom, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
}

/** What an environment written through the document's macros shows (see `ExpandedEnvironmentWidget`). */
export type ExpandedEnvironmentSpec = {
  /** A header as the environment's own: a theorem's "Theorem 2", "Proof", or a user environment's begin code. */
  header: { variant: "theorem" | "proof" | "abstract" | "user"; title: string; note: string | null; numbered: boolean } | null;
  /** The body's LaTeX, or a list's items. */
  body: string;
  items: { ordered: boolean; items: string[] } | null;
  /** The body's style class (a theorem style, a quote). */
  className: string | null;
  length: number;
};

/**
 * An environment written through the document's macros (`\thm{…}` for
 * `\begin{theorem}…\end{theorem}`, or `\bl … \el` around a list), drawn
 * from its expansion. It is not edited in place: a click shows its source.
 */
export class ExpandedEnvironmentWidget extends VisualWidget {
  constructor(readonly spec: ExpandedEnvironmentSpec) { super(JSON.stringify(spec)); }
  toDOM(view: EditorView) {
    const spec = this.spec;
    const dom = el("div", "cm-vis-macro-env");
    const render = (target: EditorView) => {
      const context = widgetContext(target, dom);
      dom.replaceChildren();
      const body = el("div", `cm-vis-macro-env-body${spec.className ? ` ${spec.className}` : ""}`);
      if (spec.header) {
        // As EnvironmentHeaderWidget draws it, numbered from this widget's position.
        const { variant, title, note, numbered } = spec.header;
        const header = el("span", `cm-vis-env-header cm-vis-env-header-${variant}`);
        if (variant === "user") header.append(renderLatexFragment(title, context));
        else {
          const pos = numbered ? widgetPos(target, dom) : null;
          const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "theorem");
          const head = el("span", "cm-vis-env-title");
          head.append(renderLatexFragment(title, context), document.createTextNode(entry?.number ? ` ${entry.number}` : ""));
          header.append(head);
          if (note !== null) {
            const noteElement = el("span", "cm-vis-env-note");
            noteElement.append(document.createTextNode(" ("), renderLatexFragment(note, context), document.createTextNode(")"));
            header.append(noteElement);
          }
          if (variant !== "abstract") header.append(document.createTextNode(". "));
        }
        body.append(header);
      }
      if (spec.items) {
        const list = el(spec.items.ordered ? "ol" : "ul", "cm-vis-macro-env-list");
        for (const item of spec.items.items) {
          const li = el("li");
          li.append(renderLatexFragment(item, context));
          list.append(li);
        }
        body.append(list);
      } else body.append(renderLatexFragment(spec.body, context));
      dom.append(body);
    };
    render(view);
    refreshable(dom, view, render);
    revealOnClick(view, dom, spec.length);
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 60; }
}

/** A click on a widget drawn from a macro's expansion shows the macro's source. */
function revealOnClick(view: EditorView, dom: HTMLElement, length: number) {
  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = widgetPos(view, dom);
    if (from !== null) revealSourceAt(view, from, from + length);
  });
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

/** What one float, or one panel of it (a minipage beside another), shows. */
export type FigureContent = {
  images: Array<{ path: string; width?: string }>;
  /** For tables: the tabular sources inside, with their offsets relative to the widget.
   * `readOnly`: drawn from a reading of the source (a longtable's rows), not cell by cell from it. */
  tabulars?: Array<{ source: string; offset: number; readOnly?: boolean }>;
  /** Drawings the editor does not draw (TikZ, `\input` files): their file name, or "" for an inline picture. */
  drawings?: string[];
  /** An `algorithmic` body, as numbered lines. */
  algorithm?: AlgorithmSpec;
  caption: string | null;
  /** Where the caption's text is in the document when the widget was built. */
  captionPos: number;
  captionAbove?: boolean;
  /** What the caption numbers: a figure, table or algorithm. */
  kind: "figure" | "table" | "algorithm";
  /** A sub-figure (subcaption): its caption is lettered, "(a) …". */
  sub?: boolean;
  /** `\caption*{…}`: the caption's text, without a label or number. */
  unnumbered?: boolean;
  /** Unnumbered notes under the caption (subcaption's `\subcaption*{Notes: …}`). */
  notes?: string[];
  /** Framed text (a `tcolorbox` of prompts in a `table*`): its title and its LaTeX, `\tcblower` dividing it. */
  boxes?: Array<{ title: string | null; body: string }>;
  /** Labels put over the images (a `picture` of `\put`s, overpic's), drawn in the PDF only. */
  overlay?: boolean;
  /** An algorithm float's prose before its lines, drawn above them. */
  intro?: string;
  /** Where the number is recorded relative to the widget: the environment's start, or its panel's. */
  numberOffset: number;
};

export type FigureSpec = FigureContent & {
  env: string;
  /** Where the environment started when the widget was built (caption positions are relative to it). */
  start: number;
  /** The document's path when the widget was built: images resolve against it, so a moved file redraws. */
  base?: string;
  length: number;
  /** Side-by-side minipages, each with its own content and caption (the float's own caption is the spec's). */
  panels?: FigureContent[];
  /** The panels are one above the other: a float holding two captioned tables without minipages. */
  stacked?: boolean;
};

const FLOAT_LABELS = { figure: "Figure", table: "Table", algorithm: "Algorithm" };

/** The lines of an algorithm, numbered and indented as the algorithmic package sets them. */
function renderAlgorithm(spec: AlgorithmSpec, context: FragmentContext) {
  const list = el("div", "cm-vis-algorithm");
  let count = 0;
  for (const line of spec.lines) {
    const row = el("div", "cm-vis-algorithm-line");
    row.style.setProperty("--vis-algorithm-depth", String(line.depth));
    const number = el("span", "cm-vis-algorithm-number");
    if (line.numbered) { count++; if (spec.numberEvery && count % spec.numberEvery === 0) number.textContent = `${count}:`; }
    const body = el("span", "cm-vis-algorithm-body");
    if (line.lead) body.append(el("strong", "cm-vis-algorithm-keyword", line.lead), " ");
    body.append(renderLatexFragment(line.text, context));
    if (line.trail) body.append(" ", el("strong", "cm-vis-algorithm-keyword", line.trail));
    if (line.comment !== undefined) {
      const comment = el("span", "cm-vis-algorithm-comment");
      comment.append("▷ ", renderLatexFragment(line.comment, context));
      body.append(comment);
    }
    row.append(number, body);
    list.append(row);
  }
  return list;
}

/** A figure, table or algorithm environment: images, drawings, grids or lines, and numbered captions (one per panel). */
export class FigureWidget extends VisualWidget {
  constructor(readonly spec: FigureSpec) { super(JSON.stringify(spec)); }
  toDOM(view: EditorView) {
    const spec = this.spec;
    const dom = el("div", `cm-vis-figure cm-vis-figure-${spec.kind}`);
    const start = () => widgetPos(view, dom);
    /** Each caption with how to redraw its number and text. */
    const captions: Array<{ content: FigureContent; label: HTMLElement; text: HTMLElement }> = [];
    const draw = (content: FigureContent, into: HTMLElement) => {
      const body = el("div", "cm-vis-figure-body");
      for (const image of content.images) {
        const frame = el("span", "cm-vis-figure-image");
        if (image.width) frame.style.setProperty("--vis-image-width", image.width);
        renderImage(frame, view, image.path);
        body.append(frame);
      }
      for (const drawing of content.drawings ?? []) {
        // TikZ and other drawings are typeset only in the PDF: a placeholder names where the drawing is, or the
        // package that draws it ("diagram:tikz-cd").
        const placeholder = el("span", "cm-vis-figure-drawing");
        const diagram = /^diagram:(.*)$/.exec(drawing)?.[1];
        placeholder.append(el("span", "cm-vis-figure-drawing-name", diagram ? `Diagram (${diagram})` : drawing ? (/\.[A-Za-z]+$/.test(drawing) ? drawing : `${drawing}.tex`) : "TikZ picture"));
        placeholder.append(el("span", "cm-vis-figure-drawing-note", "Drawn in the PDF"));
        body.append(placeholder);
      }
      for (const box of content.boxes ?? []) {
        // A framed box's text, its parts divided where `\tcblower` is.
        const frame = el("div", "cm-vis-figure-box");
        if (box.title) frame.append(renderLatexInto("div", "cm-vis-figure-box-title", box.title, fragmentContext(view, content.captionPos)));
        for (const part of box.body.split(/\\tcblower(?![A-Za-z@])/)) frame.append(renderLatexInto("div", "cm-vis-figure-box-part", part.trim(), fragmentContext(view, content.captionPos)));
        body.append(frame);
      }
      if (content.overlay) body.append(el("div", "cm-vis-figure-overlay", "+ overlay (labels drawn in the PDF)"));
      for (const tabular of content.tabulars ?? []) body.append(renderTableGrid(view, tabular.source, () => {
        const pos = start();
        return pos === null ? null : pos + tabular.offset;
      }, tabular.readOnly ? spec.length - tabular.offset : undefined));
      if (content.algorithm) {
        const lines = renderAlgorithm(content.algorithm, fragmentContext(view, content.captionPos));
        if (content.intro) {
          // The prose and the lines, one above the other (the body lays its items out in a row).
          const block = el("div", "cm-vis-algorithm-block");
          block.append(renderLatexInto("div", "cm-vis-figure-intro", content.intro, fragmentContext(view, content.captionPos)), lines);
          body.append(block);
        } else body.append(lines);
      }
      const notes = content.notes?.length ? content.notes.map((note) => renderLatexInto("div", "cm-vis-figure-note", note, fragmentContext(view, content.captionPos))) : [];
      // `\caption*{}` shows nothing.
      if (content.caption === null || (content.unnumbered && !content.caption.trim())) { into.append(body, ...notes); return; }
      const caption = el("div", `cm-vis-caption cm-vis-caption-${content.kind}`);
      const label = el("span", "cm-vis-caption-label");
      const text = el("span", "cm-vis-caption-text");
      text.append(renderLatexFragment(content.caption, fragmentContext(view, content.captionPos)));
      caption.append(label, text);
      captions.push({ content, label, text });
      if (content.captionAbove) into.append(caption, body, ...notes); else into.append(body, caption, ...notes);
    };
    if (spec.panels?.length) {
      const row = el("div", `cm-vis-figure-panels${spec.stacked ? " cm-vis-figure-panels-stacked" : ""}`);
      for (const panel of spec.panels) {
        const element = el("div", "cm-vis-figure-panel");
        draw(panel, element);
        row.append(element);
      }
      // The float's own caption, if it has one besides the panels'.
      // Its notes are under the panels, whether its caption is above or below them (the cannabis paper's figures).
      const notesBelow = spec.caption === null || spec.captionAbove;
      const own: FigureContent = { ...spec, images: [], tabulars: undefined, drawings: undefined, algorithm: undefined, notes: notesBelow ? undefined : spec.notes };
      if (spec.caption !== null && spec.captionAbove) draw(own, dom);
      dom.append(row);
      if (spec.caption !== null && !spec.captionAbove) draw(own, dom);
      else if (spec.notes?.length) dom.append(...spec.notes.map((note) => renderLatexInto("div", "cm-vis-figure-note", note, fragmentContext(view, spec.captionPos))));
    } else draw(spec, dom);
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      for (const { content, label, text } of captions) {
        const entry = pos === null || content.unnumbered ? null : numberingEntryAt(visualNumbering(target.state), pos + content.numberOffset, content.kind);
        label.textContent = content.unnumbered ? ""
          : content.sub ? (entry?.number ? `(${entry.number}) ` : "")
          : `${FLOAT_LABELS[content.kind]}${entry?.number ? ` ${entry.number}` : ""}${content.kind === "algorithm" ? " " : ": "}`;
        // References and citations in the caption follow numbering and the .aux too.
        if (content.caption !== null && content.caption.includes("\\")) {
          const captionPos = pos === null ? content.captionPos : pos + spec.numberOffset + (content.captionPos - spec.start);
          text.replaceChildren(renderLatexFragment(content.caption, fragmentContext(target, captionPos)));
        }
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
/**
 * The grid of a tabular. With `readOnlyLength`, the source is a reading of the
 * document rather than a slice of it (a longtable's rows): cells are not
 * edited, and a click shows the source of the `readOnlyLength` characters
 * from `start`.
 */
export function renderTableGrid(view: EditorView, source: string, start: () => number | null, readOnlyLength?: number) {
  const types = visualDefinitions(view.state).columnTypes;
  const model = parseTabular(source, 0, types);
  const table = el("table", "cm-vis-table") as TableElement;
  const readOnly = readOnlyLength !== undefined;
  if (readOnly) table.dataset.readonly = "true";
  else table.liberaTableStart = start;
  if (!model) { table.append(el("caption", "cm-vis-raw", source)); return table; }
  const context = fragmentContext(view);
  /** Cells whose LaTeX can show numbers, citations or macros, redrawn when those change. */
  const dynamic: Array<{ td: HTMLElement; text: string; from: number }> = [];
  // `\newcolumntype` letters align as their definition does.
  // tabulary's `C` and `R` align as `c` and `r` (unless the document defines them).
  const aligns = model.columns.map((column) => types.get(column)?.align ?? (column === "c" || column === "C" ? "center" : column === "r" || column === "R" || column === "D" ? "right" : "left"));
  // dcolumn's `D{.}{.}{3.2}` cells (and `>{$}c<{$}`) are formulas: `1.41^{***}` has its stars raised.
  const formulas = model.columns.map((column) => column === "D" || !!types.get(column)?.math);
  // As in TeX, only paragraph columns (`p{…}`, `m{…}`, `b{…}`, tabularx's `X`, tabulary's `L C R J`) wrap; the
  // others are one line, so a wide table scrolls instead of breaking "2.46" into "2." and "46" (Carlini & Wagner).
  const wraps = model.columns.map((column) => (types.has(column) ? !!types.get(column)!.paragraph : /^[pmbXLCRJ]$/.test(column)));
  /** Columns a `\multirow` above still covers, and for how many more rows. */
  const rowsCovered = new Map<number, number>();
  /** The rules of rows not drawn, drawn above the next row; whether the last such row closes the table. */
  let carried: string[] = [];
  let closing = false;
  model.rows.forEach((row, rowIndex) => {
    const rulesBefore = [...carried, ...row.rulesBefore];
    carried = [];
    // stargazer's `\\[-1.8ex]\hline` and `\hline \\[-1.8ex]`: empty rows a negative space pulls up to nothing in the
    // PDF (the Grammarly paper's tables); their rules go to the next row.
    if (row.breakAt !== null && row.cells.every((cell) => !cell.text.trim()) && /^\\\\\*?\s*\[\s*-/.test(source.slice(row.breakAt, row.to)) && ![...rowsCovered.values()].some((count) => count > 0)) {
      if (rowIndex + 1 < model.rows.length) { carried = rulesBefore; return; }
      if (rulesBefore.length) { closing = true; return; }
    }
    const tr = el("tr", "cm-vis-table-row");
    // `\addlinespace` is space, not a line; `\noalign{…}` sets up the line after it (a thicker one: Mask R-CNN's `\shline`).
    const lines = rulesBefore.filter((rule) => !/^\\(?:addlinespace|noalign)/.test(rule));
    const thick = rulesBefore.some((rule) => /^\\noalign\s*\{[^}]*\\arrayrulewidth\s*[\d.]+\s*pt/.test(rule));
    if (lines.length) tr.classList.add(thick || lines.some((rule) => /toprule|bottomrule/.test(rule)) ? "cm-vis-rule-heavy" : "cm-vis-rule");
    if (rulesBefore.some((rule) => /^\\addlinespace/.test(rule))) tr.classList.add("cm-vis-row-spaced");
    // Rows read from another file (`\input{./tables/summary_stats_post.tex} \\`, the Grammarly paper): a placeholder row.
    const input = row.cells.length === 1 ? /^\\(?:input|include)\s*\{([^{}]+)\}$/.exec(row.cells[0].text.trim()) : null;
    if (input) {
      const name = input[1].trim().replace(/^\.\//, "");
      // Not a cell of the grid: the cell editor and keys leave it alone.
      const td = el("td", "cm-vis-table-input", `Rows from ${/\.[A-Za-z]+$/.test(name) ? name : `${name}.tex`}`) as HTMLTableCellElement;
      td.colSpan = Math.max(1, model.columns.length);
      const cell = row.cells[0];
      td.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const base = start();
        if (base !== null) revealSourceAt(view, readOnly ? base : base + cell.from, readOnly ? base + readOnlyLength! : base + cell.to);
      });
      tr.append(td);
      table.append(tr);
      return;
    }
    let column = 0;
    row.cells.forEach((cell, cellIndex) => {
      // An empty cell under a `\multirow` above is part of it.
      const covered = rowsCovered.get(column) ?? 0;
      if (covered > 0) {
        rowsCovered.set(column, covered - 1);
        if (!cell.text.trim()) { column += cell.span; return; }
      }
      const td = el("td", "cm-vis-table-cell") as HTMLTableCellElement;
      if (cell.span > 1) td.colSpan = cell.span;
      td.style.textAlign = cell.span > 1 ? "center" : aligns[column] ?? "left";
      if (cell.span === 1 && wraps[column] === false) td.classList.add("cm-vis-table-line");
      let text = cell.contentFrom !== undefined ? source.slice(cell.contentFrom, cell.contentTo) : cell.text;
      // colortbl: `\rowcolor{Gray}` at a row's start fills the row, `\cellcolor{…}` its cell (faintly, under the text).
      const fill = /^\s*\\(rowcolor|cellcolor)\s*(?:\[([^\]]*)\]\s*)?\{([^{}]*)\}/.exec(text);
      if (fill) {
        const css = cssColor(fill[2] ?? null, fill[3], context.defs.colors);
        const filled = fill[1] === "rowcolor" ? tr : td;
        if (css) { filled.style.setProperty("--vis-fill", css); filled.dataset.fill = ""; }
        text = text.slice(fill[0].length);
      }
      // `\multirow{3}{*}{…}`: the cell spans the rows below it; so does a macro that writes one (`\blocka{64}{3}`).
      const lead = text.trimStart();
      const written = /^\\(?!multirow\b)[A-Za-z@]/.test(lead) && context.defs.macros.size ? expandLatexMacroUse(lead, context.defs, { mode: "text", pos: context.pos })?.text.trimStart() : undefined;
      const multirow = /^\\multirow\s*(?:\[[^\]]*\]\s*)?\{\s*(\d+)\s*\}/.exec(written ?? lead);
      if (multirow && Number(multirow[1]) > 1) {
        td.rowSpan = Number(multirow[1]);
        td.style.verticalAlign = "middle";
        for (let at = column; at < column + cell.span; at++) rowsCovered.set(at, Number(multirow[1]) - 1);
      }
      const formula = cell.span === 1 && formulas[column] && text.trim() && !text.includes("$") && !/^\s*\\multi(?:column|row)/.test(text);
      td.append(renderLatexFragment(formula ? `$${text.trim()}$` : text, context));
      if (text.includes("\\")) dynamic.push({ td, text, from: cell.contentFrom ?? cell.from });
      td.dataset.row = String(rowIndex);
      td.dataset.cell = String(cellIndex);
      if (cell.sourceOnly) td.classList.add("cm-vis-table-source-only");
      td.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || isEditingCell(td)) return;
        event.preventDefault();
        event.stopPropagation();
        if (readOnly) {
          const base = start();
          if (base !== null) revealSourceAt(view, base, base + readOnlyLength);
          return;
        }
        if (tableHooks && !cell.sourceOnly && !event.altKey && view.state.facet(visualConfig).editable() && !view.state.readOnly) { tableHooks.edit(view, td, start, rowIndex, cellIndex); return; }
        const base = start();
        if (base !== null) revealSourceAt(view, base + cell.from, base + cell.to + 1);
      });
      td.addEventListener("contextmenu", (event) => {
        if (readOnly || !tableHooks || view.state.readOnly || !view.state.facet(visualConfig).editable()) return;
        event.preventDefault();
        event.stopPropagation();
        tableHooks.menu(view, event, start, rowIndex, cellIndex);
      });
      tr.append(td);
      column += cell.span;
    });
    table.append(tr);
  });
  if (model.rulesAfter.length || closing) table.classList.add("cm-vis-table-closed");
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
  if (!readOnly) queueMicrotask(() => { if (table.isConnected) tableHooks?.adopt?.(view, table); });
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
  /** `readOnly`: the source is a reading of the document (rows written through its macros), not a slice of it. */
  constructor(readonly source: string, readonly offset: number, readonly length: number, readonly readOnly = false) {
    super(`${offset}\u0000${readOnly ? 1 : 0}\u0000${source}`);
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-tabular");
    dom.append(renderTableGrid(view, this.source, () => {
      const pos = widgetPos(view, dom);
      return pos === null ? null : pos + this.offset;
    }, this.readOnly ? this.length - this.offset : undefined));
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
  /** `abstract`: an abstract the class prints with the title (acmart's, written before `\begin{document}`). */
  constructor(readonly title: string | null, readonly author: string | null, readonly date: string | null, readonly length: number, readonly abstract: string | null = null) {
    super(JSON.stringify([title, author, date, length, abstract]));
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
      if (this.abstract) {
        const abstract = el("div", "cm-vis-title-abstract");
        const heading = el("div", "cm-vis-title-abstract-heading");
        heading.textContent = "Abstract";
        const body = el("div", "cm-vis-title-abstract-body");
        body.append(renderLatexFragment(this.abstract, context));
        abstract.append(heading, body);
        dom.append(abstract);
      }
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

/**
 * `\bibliography{refs}` and `\printbibliography`: a References heading and the list a compiled bibliography gives
 * (the main file's `.bbl`), in its order; without one, a note that the PDF has the list.
 */
export class BibliographyListWidget extends VisualWidget {
  constructor(readonly heading: string, readonly files: string, readonly length: number) { super(`${heading}\u0000${files}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-references");
    const render = (target: EditorView) => {
      dom.replaceChildren(el("div", "cm-vis-references-heading", this.heading));
      const entries = (target.state.field(latexProjectField, false)?.bibEntries ?? []).filter((entry) => entry.label !== undefined || entry.citeAuthor !== undefined);
      if (!entries.length) {
        dom.append(el("div", "cm-vis-references-note", `Listed in the PDF${this.files ? ` (from ${this.files})` : ""}`));
        return;
      }
      const numeric = entries.every((entry) => entry.label && /^\d+$/.test(entry.label));
      const sorted = numeric ? [...entries].sort((a, b) => Number(a.label) - Number(b.label)) : entries;
      for (const entry of sorted) {
        const line = el("div", "cm-vis-references-item");
        const who = entry.author ? plainTexText(entry.author.split(/\s+and\s+/).join(", ")) : entry.citeAuthor ? plainTexText(entry.citeAuthor) : "";
        line.append(el("span", "cm-vis-references-label", entry.label ? `[${entry.label}]` : ""), document.createTextNode([who, entry.title ? plainTexText(entry.title) : "", entry.year ?? ""].filter(Boolean).join(". ") + "."));
        dom.append(line);
      }
    };
    render(view);
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
