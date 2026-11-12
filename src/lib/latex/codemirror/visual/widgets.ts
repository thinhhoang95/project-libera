import { EditorSelection, type Text } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { hashString } from "../../../macros/core";
import { definitionCounts } from "../../macros/definitions";
import { expandLatexMacroUse } from "../../macros/expand";
import { numberingEntryAt, type NumberingKind } from "../../macros/numbering";
import { resolveRelativeNotebookPath } from "../../project";
import { applyEquationNumbers, renderKatex } from "./math-render";
import { preambleOpenField, togglePreamble, visualAux, visualConfig, visualDefinitions, visualNumbering } from "./model";
import { latexProjectField } from "../editing";
import { bibLookup, citationStyleFor, citationText, missingCitationKeys, multiCitationText, plainTexText, stateReferenceText, labelTarget, withReferenceNumbers } from "./references";
import { renderLatexFragment, renderLatexInto, type FragmentContext } from "./render-fragment";
import { cssColor } from "./symbols";
import { editableLines, type FrontDetailsView, type FrontLineView } from "./front-matter";
import { columnSpans, parseTabular, type TableModel, type TableRow, type TableSettings } from "./table-model";
import { algorithmLineNumbers, type AlgorithmSpec } from "./algorithm";
import { attachDrawingPreview } from "./drawing-preview";
import { readCodeBlock, renderCodeBlock } from "./text-commands";

/* The widgets the Visual mode draws in place of LaTeX constructs
 * (docs/latex-visual-editor-plan.md §3). Widgets whose text depends on
 * numbering or the compiled `.aux` register a refresh, which the numbering
 * plugin calls when those change, so no decoration has to be rebuilt. */

/** An element that shows numbers: how it updates them, and where it was when it last did. */
type Refreshable = HTMLElement & { liberaVisRefresh?: (view: EditorView) => void; liberaVisAt?: number | null };

/** Registers how an element updates its numbers; called once now (after mounting) and on every numbering change. */
export function refreshable(dom: HTMLElement, view: EditorView, refresh: (view: EditorView) => void) {
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
export function widgetContext(view: EditorView, dom: HTMLElement, offset = 0) {
  const pos = widgetPos(view, dom);
  return fragmentContext(view, pos === null ? undefined : pos + offset);
}

/** The document position a widget's DOM stands at, or null when it is not in the view. */
export function widgetPos(view: EditorView, dom: HTMLElement) {
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

/** IEEEtran's `\begin{IEEEbiographynophoto}{Name}`: the name in bold italics; a click (or Alt-click) shows the opening's source. */
export class BiographyHeaderWidget extends VisualWidget {
  constructor(readonly name: string, readonly length: number) { super(`${name}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-bio-name", this.name);
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

/** `\detokenize{{instruction}}`: its argument as the characters it holds, in the typewriter face; a click shows the command. */
export class LiteralTextWidget extends VisualWidget {
  constructor(readonly literal: string, readonly source: string) { super(`${literal}\u0000${source}`); }
  toDOM(view: EditorView) {
    const span = el("span", "cm-vis-symbol cm-vis-tt cm-vis-literal", this.literal);
    span.title = this.source;
    revealOnClick(view, span, this.source.length);
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

/** `event` and `dom`: the click on the drawn formula, which picks the row or cell to open. */
export type MathOpener = (view: EditorView, from: number, to: number, event?: MouseEvent, dom?: HTMLElement) => boolean;
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
      if (event.altKey || !openMathEditor || !openMathEditor(view, from + this.numberOffset, to, event, dom)) revealSourceAt(view, from + this.numberOffset, to);
    });
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.block ? 48 : -1; }
}

/** A citation, reference or label chip. */
export class ChipWidget extends VisualWidget {
  /** `index`: an `\index{…}` or `\glossary{…}` entry, which the PDF does not show where it is: a small grey tag, as a label. */
  /** `more`: a multicite's other groups (`\parencites[12]{a}[34]{b}`), each with its keys and notes. */
  constructor(readonly kind: "cite" | "ref" | "label" | "index", readonly command: string, readonly keys: string[], readonly notes: { pre?: string; post?: string }, readonly length: number, readonly more: ReadonlyArray<{ keys: string[]; notes: { pre?: string; post?: string } }> = []) {
    super(`${kind}\u0000${command}\u0000${keys.join(",")}\u0000${notes.pre ?? ""}\u0000${notes.post ?? ""}\u0000${length}${more.length ? `\u0000${JSON.stringify(more)}` : ""}`);
  }
  private text(view: EditorView) {
    if (this.kind === "label") return this.keys[0];
    // makeidx's `sort@shown!sub` entries: what each level shows.
    if (this.kind === "index") return this.keys[0].split("!").map((level) => level.slice(level.lastIndexOf("@") + 1).replace(/\|.*$/, "")).join(" › ");
    if (this.kind === "cite" && this.more.length) return multiCitationText(this.command, [{ keys: this.keys, notes: this.notes }, ...this.more], visualAux(view.state), bibLookup(view.state), citationStyleFor(view.state));
    if (this.kind === "cite") return citationText({ command: this.command, keys: this.keys, ...this.notes }, visualAux(view.state), bibLookup(view.state), citationStyleFor(view.state));
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
      const text = this.text(target);
      dom.textContent = text;
      // A reference to a `\tag{$\mathcal{I}$}` (Econometrica's): its math drawn, not its source.
      if (this.kind === "ref" && /\$[^$]+\$/.test(text)) {
        dom.replaceChildren(...text.split(/(\$[^$]+\$)/).filter(Boolean).map((part) => {
          const html = /^\$[^$]+\$$/.test(part) ? renderKatex(part.slice(1, -1), false) : null;
          if (!html) return document.createTextNode(part);
          const math = el("span", "cm-vis-chip-math");
          math.innerHTML = html;
          return math;
        }));
      }
      if (this.kind === "ref") {
        const missing = this.keys.some((key) => !labelTarget(key, visualNumbering(target.state), visualAux(target.state)));
        dom.classList.toggle("cm-vis-missing", missing);
        dom.title = `${this.command}{${this.keys.join(",")}}${missing ? " (label not found)" : ""}`;
        dom.setAttribute("aria-label", `Reference to ${text.replace(/\$/g, "")}`);
      } else if (this.kind === "cite") {
        const bib = bibLookup(target.state);
        const keys = [...this.keys, ...this.more.flatMap((group) => group.keys)];
        // A key no bibliography data knows (only once some is loaded): a warning, as a reference to an unknown label.
        const missing = missingCitationKeys(target.state, keys);
        dom.classList.toggle("cm-vis-missing", missing.length > 0);
        // biblatex's `\supercite`: a superscript number.
        dom.classList.toggle("cm-vis-cite-super", /^\\supercites?\*?$/.test(this.command) && /^[\d,\s–-]+$/.test(dom.textContent ?? ""));
        dom.title = keys.map((key) => { const entry = bib(key); return entry?.title ? `${key}: ${entry.title}` : missing.includes(key) ? `${key} (citation not found)` : key; }).join("\n");
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
  /**
   * `latex`: a label written with formulas or styles (`\item[$(i)$]`, `\item[\textbf{Step 1}]`), drawn as LaTeX;
   * `inline`: an item of a list run into its paragraph (paralist's `inparaenum`).
   */
  /**
   * `numberedAt`: for an item of a list continued from another (enumitem's `resume`), where its `\item` is from the
   * widget's start: its number comes from the numbering pass, which counts the lists before it.
   */
  constructor(readonly label: string, readonly variant: "bullet" | "number" | "description", readonly depth: number, readonly flags: { latex?: boolean; inline?: boolean } = {}, readonly numberedAt: number | null = null, readonly length: number | null = null) {
    super(`${variant}\u0000${depth}\u0000${label}\u0000${flags.latex ? "l" : ""}${flags.inline ? "i" : ""}\u0000${numberedAt ?? ""}\u0000${length ?? ""}`);
  }
  toDOM(view: EditorView) {
    const dom = el("span", `cm-vis-item cm-vis-item-${this.variant}${this.flags.inline ? " cm-vis-item-inline" : ""}`, this.flags.latex ? undefined : this.label);
    dom.style.setProperty("--vis-depth", String(this.depth));
    if (this.numberedAt !== null && !this.flags.latex) {
      refreshable(dom, view, (target) => {
        const pos = widgetPos(target, dom);
        const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos + this.numberedAt!, "item");
        dom.textContent = entry?.number ?? this.label;
      });
    }
    if (this.flags.latex) {
      const render = (target: EditorView) => dom.replaceChildren(renderLatexFragment(this.label, widgetContext(target, dom)));
      render(view);
      refreshable(dom, view, render);
    }
    // A click opens the marker's source (`\item[$(\star)$]`, `\bibitem[…]{key}`), Alt-click too.
    const length = this.length;
    if (length !== null) {
      dom.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const from = widgetPos(view, dom);
        if (from !== null) revealSourceAt(view, from, from + length);
      });
    }
    return dom;
  }
}

/** linguex's `\ex.` (an example: "(1)") and `\a.`, `\b.` (its parts: "a."), numbered by the numbering pass. */
export class ExampleMarkerWidget extends VisualWidget {
  constructor(readonly part: boolean) { super(part ? "part" : "example"); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-item cm-vis-item-number cm-vis-item-inline cm-vis-example");
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      const number = (pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "item"))?.number ?? "";
      dom.textContent = this.part ? `${/[a-z]+$/.exec(number)?.[0] ?? "?"}.` : `(${number || "?"})`;
    });
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

/** A PDF page drawn as an image, with the page's size in TeX points (what `trim` and `scale` are measured against). */
type PdfThumbnail = { data: string; width: number; height: number };
const pdfThumbnails = new Map<string, Promise<PdfThumbnail | null>>();

async function pdfThumbnail(url: string, pageNumber = 1): Promise<PdfThumbnail | null> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ url }).promise;
  try {
    // `page=` past the end: the first page, as a missing page is an error in TeX (the placeholder would hide the figure).
    const page = await pdf.getPage(pageNumber <= pdf.numPages ? pageNumber : 1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 900 / Math.max(1, viewport.width));
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    return { data: canvas.toDataURL("image/png"), width: viewport.width, height: viewport.height };
  } finally {
    void pdf.destroy();
  }
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "pdf", "svg", "gif", "webp", "eps", "ps"];

/**
 * The extensions tried for a graphics file named without one: the document's `\DeclareGraphicsExtensions{.pdf,.png}`
 * order first (per document version), then the usual ones.
 */
const extensionCache = new WeakMap<EditorView["state"]["doc"], string[]>();
function graphicsExtensions(doc: EditorView["state"]["doc"]) {
  let extensions = extensionCache.get(doc);
  if (extensions) return extensions;
  extensions = IMAGE_EXTENSIONS;
  const head = doc.sliceString(0, Math.min(doc.length, 200_000));
  if (head.includes("\\DeclareGraphicsExtensions")) {
    const declared = /^[^%\n]*?\\DeclareGraphicsExtensions\s*\{([^{}]*)\}/m.exec(head)?.[1];
    const listed = declared?.split(",").map((ext) => ext.trim().replace(/^\./, "").toLowerCase()).filter((ext) => /^[a-z0-9]+$/.test(ext)) ?? [];
    if (listed.length) extensions = [...new Set([...listed, ...IMAGE_EXTENSIONS])];
  }
  extensionCache.set(doc, extensions);
  return extensions;
}

/** Draws a graphics file into `container`: an image, a PDF's page (the first, or `page=`), or a labelled placeholder. */
function renderImage(container: HTMLElement, view: EditorView, name: string, className = "cm-vis-image", style: GraphicsStyle | null = null) {
  const config = view.state.facet(visualConfig);
  const resolvedPaths = graphicsCandidates(view, name);
  const placeholder = (message: string) => {
    container.replaceChildren(el("span", "cm-vis-image-placeholder", message));
  };
  if (!resolvedPaths.length) { placeholder(`${name} (outside the notebook)`); return; }
  const extensions = graphicsExtensions(view.state.doc);
  const candidates = resolvedPaths.flatMap((resolved) => (/\.([a-z0-9]+)$/i.test(resolved) ? [resolved] : extensions.map((ext) => `${resolved}.${ext}`)));
  const tryNext = (index: number) => {
    const path = candidates[index];
    if (!path) { placeholder(`${name} (not found)`); return; }
    const url = config.fileUrl(path);
    if (!url) { placeholder(name); return; }
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
    if (ext === "eps" || ext === "ps") { placeholder(`${name} (${ext.toUpperCase()}: shown in the PDF only)`); return; }
    if (ext === "pdf") {
      const key = style?.page ? `${url}#page=${style.page}` : url;
      let thumbnail = pdfThumbnails.get(key);
      if (!thumbnail) {
        thumbnail = pdfThumbnail(url, style?.page).catch(() => null);
        pdfThumbnails.set(key, thumbnail);
        if (pdfThumbnails.size > 60) pdfThumbnails.delete(pdfThumbnails.keys().next().value!);
      }
      container.replaceChildren(el("span", "cm-vis-image-loading", name));
      void thumbnail.then((drawn) => {
        if (!drawn) { pdfThumbnails.delete(key); tryNext(index + 1); return; }
        const image = el("img", className) as HTMLImageElement;
        image.src = drawn.data;
        image.alt = name;
        container.replaceChildren(image);
        if (style) applyGraphicsStyle(container, image, style, drawn);
      });
      return;
    }
    const image = el("img", className) as HTMLImageElement;
    image.alt = name;
    image.decoding = "async";
    image.loading = "lazy";
    image.onerror = () => tryNext(index + 1);
    if (style) image.onload = () => applyGraphicsStyle(container, image, style, { width: image.naturalWidth, height: image.naturalHeight });
    image.src = url;
    container.replaceChildren(image);
  };
  tryNext(0);
}

/** What one float, or one panel of it (a minipage beside another), shows. */
export type FigureContent = {
  /** `options`: the `\includegraphics` options drawn besides the width (height, scale, angle, trim and clip, page). */
  images: Array<{ path: string; width?: string; options?: string }>;
  /** For tables: the tabular sources inside, with their offsets relative to the widget.
   * `readOnly`: drawn from a reading of the source (a longtable's rows), not cell by cell from it.
   * `ruled`: inside revtex's `ruledtabular`, which rules the grid with double lines above and below.
   * `extras`: what the float sets for the grid (`\rowcolors`, `\arraystretch`), and rows written through macros. */
  tabulars?: Array<{ source: string; offset: number; readOnly?: boolean; ruled?: boolean; extras?: TableExtras }>;
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
  /**
   * Parts the widget does not draw (an unknown command, a code listing, a forest tree), shown as their source, or as a
   * placeholder naming them, in their place: offsets relative to the widget; `before` the drawn content or after it.
   */
  sources?: Array<{ offset: number; length: number; text: string; name?: string; before?: boolean }>;
  /** Where the caption's text is relative to the widget, when it is written out there: clicked, it is edited in place. */
  captionOffset?: number;
  /** A panel's width (a minipage's `0.48\linewidth`, a `\subcaptionbox`'s width) as CSS. */
  width?: string;
  /**
   * A float a macro writes (macro-provenance.ts): where the caption's text is, relative to the widget, when it is the
   * call's argument. A click on the caption puts the cursor there, to edit just that argument.
   */
  captionSource?: { from: number; to: number };
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

/**
 * The names the open file gives its floats, per document version: caption's `\captionsetup[figure]{name={Fig.}}`
 * (the cannabis paper's "Fig. 1") and `\renewcommand{\figurename}{Fig.}`. A name holding a command is not read.
 */
const floatNameCache = new WeakMap<EditorView["state"]["doc"], Partial<Record<FigureContent["kind"], string>>>();
function floatNames(doc: EditorView["state"]["doc"]) {
  let names = floatNameCache.get(doc);
  if (names) return names;
  names = {};
  const text = doc.toString();
  if (/\\(?:captionsetup|renewcommand)/.test(text)) {
    const plain = text.replace(/(^|[^\\])%[^\n]*/g, "$1");
    for (const match of plain.matchAll(/\\captionsetup\s*\[\s*(figure|table|algorithm)\s*\]\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      const name = /(?:^|,)\s*name\s*=\s*(?:\{([^{}]*)\}|([^,]*))/.exec(match[2]);
      const value = (name?.[1] ?? name?.[2])?.trim();
      if (value && !value.includes("\\")) names[match[1] as FigureContent["kind"]] = value;
    }
    for (const match of plain.matchAll(/\\renewcommand\s*\{?\s*\\(figure|table|algorithm)name\s*\}?\s*\{([^{}\\]*)\}/g)) names[match[1] as FigureContent["kind"]] = match[2].trim();
  }
  floatNameCache.set(doc, names);
  return names;
}

/** An algorithm's lines as drawn: the spec they are read from, and where its body starts in the document now. */
export type AlgorithmElement = HTMLElement & { liberaAlgorithm?: { spec: AlgorithmSpec; base: () => number | null } };

export type AlgorithmHooks = {
  /** Opens line `line`'s LaTeX in an editor over it; false when it cannot be edited. */
  edit: (view: EditorView, list: AlgorithmElement, line: number) => boolean;
  /** Insert and delete commands for a line (right-click). */
  menu: (view: EditorView, event: MouseEvent, list: AlgorithmElement, line: number) => void;
  /** Opens an algorithm's caption (`caption` is its LaTeX, in the float at `range`) in an editor over `text`. */
  caption: (view: EditorView, text: HTMLElement, caption: string, range: () => { from: number; to: number } | null) => boolean;
  /** A redrawn algorithm: continues an edit that was open in the one it replaces. */
  adopt?: (view: EditorView, list: AlgorithmElement) => void;
};
let algorithmHooks: AlgorithmHooks | null = null;
/** Set by algorithm-edit.ts. */
export function setAlgorithmHooks(hooks: AlgorithmHooks | null) { algorithmHooks = hooks; }

const algorithmEditable = (view: EditorView) => !!algorithmHooks && !view.state.readOnly && view.state.facet(visualConfig).editable();

/**
 * A click on an algorithm's line or caption: edits the line's (or caption's) LaTeX in place, or with Alt shows the
 * line's source. False when the click is not one of these (the float is then selected as a whole).
 */
function algorithmClick(view: EditorView, event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest(".cm-vis-title-editor, .cm-vis-algorithm-editor")) return true;
  const row = target.closest<HTMLElement>("[data-algorithm-line]");
  const list = row?.closest<AlgorithmElement>(".cm-vis-algorithm");
  const algorithm = list?.liberaAlgorithm;
  if (row && list && algorithm) {
    const index = Number(row.dataset.algorithmLine);
    const source = algorithm.spec.lines[index]?.source;
    if (!source) return false;
    event.preventDefault();
    if (!event.altKey && source.exact && algorithmEditable(view) && algorithmHooks!.edit(view, list, index)) return true;
    const base = algorithm.base();
    if (base !== null) revealSourceAt(view, base + source.from, base + source.to);
    return true;
  }
  const caption = target.closest<HTMLElement & { liberaCaption?: { caption: string; range: () => { from: number; to: number } | null } }>("[data-algorithm-caption]");
  if (caption?.liberaCaption && !event.altKey && algorithmEditable(view)) {
    event.preventDefault();
    return algorithmHooks!.caption(view, caption, caption.liberaCaption.caption, caption.liberaCaption.range);
  }
  return false;
}

/** The lines of an algorithm, numbered and indented as the algorithmic package sets them; `base` is where its body starts. */
function renderAlgorithm(spec: AlgorithmSpec, context: FragmentContext, view?: EditorView, base?: () => number | null) {
  const list = el("div", "cm-vis-algorithm") as AlgorithmElement;
  if (view && base && spec.offset !== undefined) {
    list.liberaAlgorithm = { spec, base };
    list.addEventListener("contextmenu", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-algorithm-line]");
      if (!row || !algorithmEditable(view)) return;
      event.preventDefault();
      event.stopPropagation();
      algorithmHooks!.menu(view, event, list, Number(row.dataset.algorithmLine));
    });
    queueMicrotask(() => { if (list.isConnected) algorithmHooks?.adopt?.(view, list); });
  }
  const numbers = algorithmLineNumbers(spec);
  spec.lines.forEach((line, index) => {
    // `\\\hrulefill` between statements (GaLore's): a rule across the lines.
    if (line.rule) { list.append(el("div", `cm-vis-algorithm-rule${line.rule === "dotted" ? " cm-vis-algorithm-rule-dotted" : ""}`)); return; }
    const row = el("div", "cm-vis-algorithm-line");
    row.dataset.algorithmLine = String(index);
    if (line.source) row.classList.add(line.source.exact ? "cm-vis-algorithm-editable" : "cm-vis-algorithm-sourced");
    row.style.setProperty("--vis-algorithm-depth", String(line.depth));
    const number = el("span", "cm-vis-algorithm-number");
    const count = numbers[index];
    if (count !== null && spec.numberEvery && count % spec.numberEvery === 0) number.textContent = `${count}:`;
    const body = el("span", "cm-vis-algorithm-body");
    // A statement the reader does not know: its LaTeX, in the algorithm.
    if (line.raw) {
      body.append(el("code", "cm-vis-raw cm-vis-algorithm-raw", line.text));
      row.append(number, body);
      list.append(row);
      return;
    }
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
  });
  return list;
}

export type FloatHooks = {
  /**
   * Opens `target` as an editor of the LaTeX written at [from, from + original.length) (a caption's text, a part shown
   * as source); false when it cannot (the text there changed, a read-only view).
   */
  edit: (view: EditorView, target: HTMLElement, from: number, original: string, label: string) => boolean;
  /** A redrawn float or block: continues an editor that was open in the one it replaces. */
  adopt?: (view: EditorView, dom: HTMLElement) => void;
};
let floatHooks: FloatHooks | null = null;
/** Set by float-edit.ts. */
export function setFloatHooks(hooks: FloatHooks | null) { floatHooks = hooks; }

/** The document position of a widget's editable part (`data-float-offset` from the widget's start), for float-edit.ts. */
export function floatPartPos(view: EditorView, dom: HTMLElement, part: HTMLElement) {
  const from = widgetPos(view, dom);
  return from === null || part.dataset.floatOffset === undefined ? null : from + Number(part.dataset.floatOffset);
}

/**
 * A part of a float the widget does not draw: its source in monospace, or a placeholder naming what it is (a code
 * listing, a forest tree). Clicked, its source opens in an editor of its own; the rest of the float stays drawn.
 */
function sourcePartElement(view: EditorView, dom: HTMLElement, part: NonNullable<FigureContent["sources"]>[number]) {
  let element: HTMLElement;
  // A code listing written in the float: its code, drawn as code blocks are in the text (a placeholder would hide it).
  const code = part.name ? readCodeBlock(part.text) : null;
  if (code) {
    element = el("div", "cm-vis-figure-source cm-vis-figure-source-code");
    element.append(renderCodeBlock(code, (latex) => renderLatexFragment(latex, widgetContext(view, dom, part.offset)), null));
    element.title = "Click to edit its source";
  } else if (part.name) {
    element = el("span", "cm-vis-figure-drawing cm-vis-figure-source cm-vis-figure-source-named");
    element.append(el("span", "cm-vis-figure-drawing-name", part.name), el("span", "cm-vis-figure-drawing-note", "Click to edit its source"));
  } else {
    element = el("code", "cm-vis-raw cm-vis-figure-source", part.text);
    element.title = "Not drawn here: click to edit its source";
  }
  if (part.before) element.classList.add("cm-vis-figure-source-before");
  element.dataset.floatOffset = String(part.offset);
  element.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".cm-vis-float-editor")) return;
    event.preventDefault();
    event.stopPropagation();
    const from = widgetPos(view, dom);
    if (from === null) return;
    const at = from + part.offset;
    if (event.altKey || !floatHooks?.edit(view, element, at, part.text, part.name ?? "Source")) revealSourceAt(view, at, at + part.length);
  });
  return element;
}

/** CSS for `\includegraphics` options beyond the width: `height`, `scale`, `angle`, `trim` with `clip`, `keepaspectratio`, `page`. */
export type GraphicsStyle = { height?: string; scale?: number; angle?: number; trim?: [number, number, number, number]; keepAspect?: boolean; page?: number };

/** A TeX length in an option as CSS (`3cm`, `0.3\textheight` as a share of a page's height); undefined when not one of those. */
function graphicsLength(value: string | undefined) {
  if (!value) return undefined;
  const length = /^([\d.]+)\s*(cm|mm|in|pt|em|ex|bp)$/.exec(value.trim());
  if (length) return length[2] === "bp" ? `${Number(length[1]) * 96 / 72}px` : `${length[1]}${length[2]}`;
  // A share of the page's height (`0.3\textheight`): of a page about 9in tall.
  const share = /^([\d.]*)\s*\\textheight$/.exec(value.trim());
  return share ? `${Number(share[1] || 1) * 9}in` : undefined;
}

/** The style an `\includegraphics[…]` option list asks for (its width is read with the image). */
export function graphicsStyle(options: string): GraphicsStyle | null {
  const values = new Map<string, string>();
  for (const pair of options.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (key.trim()) values.set(key.trim(), rest.join("=").trim());
  }
  const style: GraphicsStyle = {};
  const height = graphicsLength(values.get("height") ?? values.get("totalheight"));
  if (height) style.height = height;
  const scale = Number(values.get("scale"));
  if (values.has("scale") && Number.isFinite(scale) && scale > 0) style.scale = scale;
  const angle = Number(values.get("angle"));
  if (values.has("angle") && Number.isFinite(angle) && angle % 360 !== 0) style.angle = angle;
  // `trim=l b r t` (bp) crops only with `clip` (else the image spills over its box, as TeX draws it: shown whole).
  const clip = values.has("clip") && values.get("clip") !== "false";
  const trim = (values.get("trim") ?? values.get("viewport"))?.split(/\s+/).map((part) => parseFloat(part));
  if (clip && trim?.length === 4 && trim.every((part) => Number.isFinite(part) && part >= 0) && values.has("trim")) style.trim = trim as GraphicsStyle["trim"];
  if (values.has("keepaspectratio") && values.get("keepaspectratio") !== "false") style.keepAspect = true;
  const page = Number(values.get("page"));
  if (Number.isInteger(page) && page > 1) style.page = page;
  return Object.keys(style).length ? style : null;
}

/** Applies a graphics style to a drawn image once its natural size is known: `scale` and `trim` need it. */
function applyGraphicsStyle(container: HTMLElement, image: HTMLImageElement | HTMLCanvasElement, style: GraphicsStyle, natural: { width: number; height: number }) {
  if (style.height) {
    image.style.height = style.height;
    image.style.width = container.style.getPropertyValue("--vis-image-width") ? "100%" : "auto";
    image.style.objectFit = style.keepAspect ? "contain" : "fill";
  }
  // A PNG's pixels are TeX's points (72 to the inch), as pdfTeX reads an image without a resolution.
  if (style.scale && natural.width > 0 && !container.style.getPropertyValue("--vis-image-width") && !style.height) image.style.width = `${natural.width * style.scale * 96 / 72}px`;
  if (style.trim && natural.width > 0 && natural.height > 0) {
    // Cropped by a window over the image: its share of the image, shifted by what is trimmed at the left and top.
    const [left, bottom, right, top] = style.trim;
    const visibleWidth = natural.width - left - right;
    const visibleHeight = natural.height - top - bottom;
    if (visibleWidth > 0 && visibleHeight > 0) {
      const crop = el("span", "cm-vis-image-crop");
      crop.style.aspectRatio = `${visibleWidth} / ${visibleHeight}`;
      image.style.width = `${(natural.width / visibleWidth) * 100}%`;
      image.style.maxWidth = "none";
      image.style.marginLeft = `${-(left / visibleWidth) * 100}%`;
      image.style.marginTop = `${-(top / visibleWidth) * 100}%`;
      image.replaceWith(crop);
      crop.append(image);
    }
  }
  if (style.angle) {
    // TeX turns counterclockwise.
    const target = image.parentElement?.classList.contains("cm-vis-image-crop") ? image.parentElement : image;
    target.style.transform = `rotate(${-style.angle}deg)`;
    target.classList.add("cm-vis-image-rotated");
  }
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
        const style = image.options ? graphicsStyle(image.options) : null;
        renderImage(frame, view, image.path, "cm-vis-image", style);
        body.append(frame);
      }
      // What it does not draw: its source in its place (before or after the drawn content), editable on its own.
      for (const part of content.sources ?? []) body.append(sourcePartElement(view, dom, part));
      for (const drawing of content.drawings ?? []) {
        // TikZ and other drawings are typeset only in the PDF: a placeholder names where the drawing is, or the
        // package that draws it ("diagram:tikz-cd").
        const placeholder = el("span", "cm-vis-figure-drawing");
        const diagram = /^diagram:(.*)$/.exec(drawing)?.[1];
        placeholder.append(el("span", "cm-vis-figure-drawing-name", diagram ? `Diagram (${diagram})` : drawing ? (/\.[A-Za-z]+$/.test(drawing) ? drawing : `${drawing}.tex`) : "TikZ picture"));
        placeholder.append(el("span", "cm-vis-figure-drawing-note", "Drawn in the PDF"));
        attachDrawingPreview(view, placeholder, drawing, () => { const pos = start(); return pos === null ? null : view.state.sliceDoc(pos, pos + spec.length); });
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
      for (const tabular of content.tabulars ?? []) {
        const grid = renderTableGrid(view, tabular.source, () => {
          const pos = start();
          return pos === null ? null : pos + tabular.offset;
        }, tabular.readOnly ? spec.length - tabular.offset : undefined, tabular.extras);
        if (tabular.ruled) grid.classList.add("cm-vis-table-ruled");
        body.append(grid);
      }
      if (content.algorithm) {
        const offset = content.algorithm.offset;
        const lines = renderAlgorithm(content.algorithm, fragmentContext(view, content.captionPos), view, () => {
          const pos = start();
          return pos === null || offset === undefined ? null : pos + offset;
        });
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
      // An algorithm's own caption is edited by algorithm-edit.ts (below), not by the float's caption editor.
      if (content.captionOffset !== undefined && !(content.kind === "algorithm" && !content.sub)) {
        // Clicked, the caption's LaTeX is edited in place (its label and short title stay as written).
        const offset = content.captionOffset;
        const original = content.caption;
        text.classList.add("cm-vis-editable-part");
        text.dataset.floatOffset = String(offset);
        text.title = "Click to edit the caption";
        text.addEventListener("mousedown", (event) => {
          if (event.button !== 0 || event.altKey || event.detail >= 2 || (event.target as HTMLElement).closest(".cm-vis-float-editor")) return;
          const from = widgetPos(view, dom);
          if (from === null || !floatHooks?.edit(view, text, from + offset, original, "Caption")) return;
          event.preventDefault();
          event.stopPropagation();
        });
      }
      // An algorithm's caption is edited in place (algorithm-edit.ts).
      if (content.kind === "algorithm" && !content.sub) {
        text.dataset.algorithmCaption = "true";
        Object.assign(text, { liberaCaption: { caption: content.caption, range: () => { const pos = start(); return pos === null ? null : { from: pos, to: pos + spec.length }; } } });
      }
      const source = content.captionSource;
      if (source && content.captionOffset === undefined) {
        text.classList.add("cm-vis-caption-argument");
        text.addEventListener("mousedown", (event) => {
          if (event.button !== 0 || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          const at = widgetPos(view, dom);
          if (at !== null) editKeysAt(view, at + source.from);
        });
      }
      caption.append(label, text);
      captions.push({ content, label, text });
      if (content.captionAbove) into.append(caption, body, ...notes); else into.append(body, caption, ...notes);
    };
    if (spec.panels?.length) {
      const row = el("div", `cm-vis-figure-panels${spec.stacked ? " cm-vis-figure-panels-stacked" : ""}`);
      for (const panel of spec.panels) {
        const element = el("div", "cm-vis-figure-panel");
        if (panel.width) element.style.setProperty("--vis-panel-width", panel.width);
        draw(panel, element);
        row.append(element);
      }
      // The float's own parts shown as source (between or around the panels).
      for (const part of spec.sources ?? []) {
        const element = sourcePartElement(view, dom, part);
        if (part.before) row.prepend(element); else row.append(element);
      }
      // The float's own caption, if it has one besides the panels'.
      // Its notes are under the panels, whether its caption is above or below them (the cannabis paper's figures).
      const notesBelow = spec.caption === null || spec.captionAbove;
      const own: FigureContent = { ...spec, images: [], tabulars: undefined, drawings: undefined, algorithm: undefined, sources: undefined, notes: notesBelow ? undefined : spec.notes };
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
          : `${floatNames(target.state.doc)[content.kind] || FLOAT_LABELS[content.kind]}${entry?.number ? ` ${entry.number}` : ""}${content.kind === "algorithm" ? " " : ": "}`;
        // References and citations in the caption follow numbering and the .aux too.
        if (content.caption !== null && content.caption.includes("\\")) {
          const captionPos = pos === null ? content.captionPos : pos + spec.numberOffset + (content.captionPos - spec.start);
          text.replaceChildren(renderLatexFragment(content.caption, fragmentContext(target, captionPos)));
        }
      }
    });
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".cm-vis-table-cell[contenteditable=true], .cm-vis-float-editor")) return;
      if (event.detail < 2 && algorithmClick(view, event)) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from === null) return;
      if (event.altKey || event.detail >= 2) revealSourceAt(view, from + spec.numberOffset, from + spec.length);
      else selectRange(view, from, from + spec.length);
    });
    // An editor open in the widget this one replaces (a co-author's edit redrew it) continues here.
    queueMicrotask(() => { if (dom.isConnected) floatHooks?.adopt?.(view, dom); });
    return dom;
  }
  // The editor never handles events in here: clicks open editors, and an edited cell takes its own keys.
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.spec.kind === "figure" ? 260 : 160; }
}

/** A column of side-by-side minipages or parboxes: its content's LaTeX, where it is relative to the widget, and its width. */
export type ColumnSpec = { offset: number; length: number; body: string; width?: string };

/** A list body's items, split at `\item` outside groups and nested environments; null when text comes before the first. */
function listItems(body: string): string[] | null {
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) depth++;
      else if (body.startsWith("\\end", i)) depth--;
      else if (depth === 0 && /^\\item(?![A-Za-z@])/.test(body.slice(i, i + 6))) {
        if (start < 0) { if (body.slice(0, i).trim()) return null; } else items.push(body.slice(start, i).trim());
        start = i + 5;
        i = start - 1;
        continue;
      }
      i++;
    }
  }
  if (start < 0) return null;
  items.push(body.slice(start).trim());
  return items;
}

/**
 * A column's content as blocks: its lists (as lists), its tabulars (as grids, cells edited as a table's), and its text
 * paragraphs (with formulas and images drawn, anything else shown as source, as captions are).
 */
function renderColumnBody(view: EditorView, dom: HTMLElement, column: HTMLElement, spec: ColumnSpec) {
  const body = spec.body;
  const blocks = /\\begin\s*\{(itemize|enumerate|description|tabular\*?|tabularx)\}/g;
  let at = 0;
  const text = (from: number, to: number) => {
    for (const paragraph of body.slice(from, to).split(/\n[ \t]*\n/)) {
      if (!paragraph.replace(/%[^\n]*/g, "").trim()) continue;
      column.append(renderLatexInto("div", "cm-vis-column-block", paragraph.trim(), widgetContext(view, dom, spec.offset)));
    }
  };
  for (let match = blocks.exec(body); match; match = blocks.exec(body)) {
    // The matching `\end`, counting the same environment nested inside.
    const name = match[1].replace("*", "\\*");
    const pattern = new RegExp(String.raw`\\(begin|end)\s*\{${name}\}`, "g");
    pattern.lastIndex = match.index + match[0].length;
    let depth = 1;
    let end = -1;
    for (let next = pattern.exec(body); next; next = pattern.exec(body)) {
      depth += next[1] === "begin" ? 1 : -1;
      if (!depth) { end = next.index + next[0].length; break; }
    }
    if (end < 0) break;
    text(at, match.index);
    const source = body.slice(match.index, end);
    if (/^tabular/.test(match[1])) {
      const offset = spec.offset + match.index;
      const grid = renderTableGrid(view, source, () => { const pos = widgetPos(view, dom); return pos === null ? null : pos + offset; });
      const block = el("div", "cm-vis-column-block");
      block.append(grid);
      column.append(block);
    } else {
      const inner = source.replace(/^\\begin\s*\{[^}]*\}/, "").replace(/\\end\s*\{[^}]*\}$/, "");
      const items = listItems(inner);
      if (!items) column.append(renderLatexInto("div", "cm-vis-column-block", source, widgetContext(view, dom, spec.offset)));
      else {
        const list = el(match[1] === "enumerate" ? "ol" : "ul", "cm-vis-column-block");
        for (const item of items) list.append(renderLatexInto("li", "", item.replace(/^\[[^\]]*\]\s*/, ""), widgetContext(view, dom, spec.offset)));
        column.append(list);
      }
    }
    at = end;
    blocks.lastIndex = end;
  }
  text(at, body.length);
}

/** Side-by-side minipages or parboxes outside floats: columns at their widths; clicked, a column's LaTeX is edited in place. */
export class ColumnsWidget extends VisualWidget {
  constructor(readonly columns: ColumnSpec[], readonly length: number, readonly base: string) { super(JSON.stringify([columns, length, base])); }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-columns");
    for (const spec of this.columns) {
      const column = el("div", "cm-vis-column");
      if (spec.width) column.style.setProperty("--vis-column-width", spec.width);
      column.dataset.floatOffset = String(spec.offset);
      renderColumnBody(view, dom, column, spec);
      column.addEventListener("mousedown", (event) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || target.closest(".cm-vis-float-editor, .cm-vis-table-cell")) return;
        event.preventDefault();
        event.stopPropagation();
        const from = widgetPos(view, dom);
        if (from === null) return;
        if (event.altKey || !floatHooks?.edit(view, column, from + spec.offset, spec.body, "Column")) revealSourceAt(view, from + spec.offset, from + spec.offset + spec.length);
      });
      dom.append(column);
    }
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".cm-vis-column")) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) selectRange(view, from, from + this.length);
    });
    queueMicrotask(() => { if (dom.isConnected) floatHooks?.adopt?.(view, dom); });
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 120; }
}

export type TableHooks = {
  /** Makes a cell editable as its LaTeX source. */
  edit: (view: EditorView, cell: HTMLElement, tableStart: () => number | null, row: number, cell_: number) => void;
  /** Row and column commands for a cell (right-click). */
  menu: (view: EditorView, event: MouseEvent, tableStart: () => number | null, row: number, cell: number) => void;
  /** A redrawn table: continues a cell edit that was open in the table it replaces. */
  adopt?: (view: EditorView, table: TableElement) => void;
  /** Shift-click: extends the selection of cells (for merging) to this cell. */
  select?: (view: EditorView, cell: HTMLElement, tableStart: () => number | null, row: number, cell_: number) => void;
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

/** What a grid's surroundings set for it (`\rowcolors`, `\arraystretch`), and the rows the document's macros write (table-model.ts). */
export type TableExtras = { settings?: TableSettings; macroRows?: Record<number, string | null> };

/** A table fill: none for white, the page's own colour. */
function tableFill(model: string | null, name: string, colors: FragmentContext["defs"]["colors"]) {
  return !name.trim() || /^white$/i.test(name.trim()) ? null : cssColor(model, name, colors);
}

/** A partial rule (`\cline{2-3}`, `\cmidrule(lr){2-3}`, `\cdashline{1-2}`): the columns it rules. */
const PARTIAL_RULE = /^\\(?:cline|cmidrule|cdashline)\s*(?:\([^)]*\)\s*)?(?:\[[^\]]*\]\s*)?\{\s*(\d+)\s*-\s*(\d+)\s*\}/;
/** A number as siunitx's `S` column reads it in the simple case: a sign, digits, a decimal point, digits. */
const DECIMAL = /^([+\-−]?)(\d*)(?:([.,])(\d*))?$/;
/** diagbox's `\diagbox{below}{above}` (and `\backslashbox`), the whole cell. */
const DIAGBOX = /^\\(?:diagbox|backslashbox)\s*(?:\[[^\]]*\]\s*)?\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}$/;
/** A header turned a quarter: `\rotatebox{90}{…}`, the whole cell. */
const ROTATED = /^\\rotatebox\s*(?:\[[^\]]*\]\s*)?\{\s*(-?\d+)\s*\}\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}$/;
const FIGURE_SPACE = " ";
const PUNCTUATION_SPACE = " ";

/** For siunitx's `S` columns: the widest integer part (with its sign) and fraction of the numbers written in them. */
function decimalColumns(model: TableModel, types: ReadonlyMap<string, unknown>) {
  const layouts = new Map<number, { int: number; frac: number }>();
  model.columns.forEach((column, index) => {
    if (column !== "S" || types.has(column)) return;
    let int = 0;
    let frac = 0;
    let numbers = 0;
    for (const row of model.rows) {
      let at = 0;
      for (const cell of row.cells) {
        if (at === index && cell.span === 1) {
          const number = DECIMAL.exec(cell.text.trim());
          if (number && (number[2] || number[4])) {
            numbers++;
            int = Math.max(int, number[1].length + number[2].length);
            frac = Math.max(frac, number[4]?.length ?? 0);
          }
        }
        at += cell.span;
      }
    }
    if (numbers) layouts.set(index, { int, frac });
  });
  return layouts;
}

/** A tabular as a grid; cells render their LaTeX, and become editable through table-edit.ts. */
/**
 * The grid of a tabular. With `readOnlyLength`, the source is a reading of the
 * document rather than a slice of it (a longtable's rows): cells are not
 * edited, and a click shows the source of the `readOnlyLength` characters
 * from `start`. `extras` holds what the commands around the tabular set for it,
 * and the rows the document's macros write: those are drawn from their
 * expansion, and a click shows their source; the other cells stay editable.
 */
export function renderTableGrid(view: EditorView, source: string, start: () => number | null, readOnlyLength?: number, extras: TableExtras = {}) {
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
  // tabulary's `C` and `R` align as `c` and `r` (unless the document defines them); siunitx's `S` centres its numbers.
  const aligns = model.columns.map((column) => types.get(column)?.align ?? (column === "c" || column === "C" || column === "S" ? "center" : column === "r" || column === "R" || column === "D" ? "right" : "left"));
  // dcolumn's `D{.}{.}{3.2}` cells (and `>{$}c<{$}`) are formulas: `1.41^{***}` has its stars raised.
  const formulas = model.columns.map((column) => column === "D" || !!types.get(column)?.math);
  // As in TeX, only paragraph columns (`p{…}`, `m{…}`, `b{…}`, tabularx's `X`, tabulary's `L C R J`) wrap; the
  // others are one line, so a wide table scrolls instead of breaking "2.46" into "2." and "46" (Carlini & Wagner).
  const wraps = model.columns.map((column) => (types.has(column) ? !!types.get(column)!.paragraph : /^[pmbXLCRJ]$/.test(column)));
  // `m{…}` and `b{…}` set their cells' text in the middle and at the bottom of the row.
  const valigns = model.columns.map((column) => (types.has(column) ? null : column === "m" ? "middle" : column === "b" ? "bottom" : null));
  // colortbl's `>{\columncolor{…}}c`: the column's fill, under a row's.
  const spans = columnSpans(model.spec, 0, types) ?? [];
  const columnFills = model.columns.map((_, index) => {
    const span = spans[index];
    const fill = span && /\\columncolor\s*(?:\[([^\]]*)\]\s*)?\{([^{}]*)\}/.exec(model.spec.slice(span.from, span.to));
    return fill ? tableFill(fill[1] ?? null, fill[2], context.defs.colors) : null;
  });
  const decimals = decimalColumns(model, types);
  const settings = extras.settings;
  // `\renewcommand{\arraystretch}{1.5}`: taller rows.
  if (settings?.stretch) table.style.setProperty("--vis-arraystretch", String(settings.stretch));
  // xcolor's `\rowcolors{2}{gray!10}{white}`: odd and even rows filled faintly from the row it names.
  const rowColors = settings?.rowColors
    ? { start: settings.rowColors.start, odd: tableFill(null, settings.rowColors.odd, context.defs.colors), even: tableFill(null, settings.rowColors.even, context.defs.colors) }
    : null;
  /** Columns a `\multirow` above still covers, and for how many more rows. */
  const rowsCovered = new Map<number, number>();
  /** The rules of rows not drawn, drawn above the next row; whether the last such row closes the table. */
  let carried: string[] = [];
  let closing = false;

  // The rows to draw: the tabular's own, and for a row the document's macros write, the rows of its expansion.
  type Shown = { row: TableRow; index: number | null; text: string; macro?: { from: number; to: number }; raw?: boolean };
  const shown: Shown[] = [];
  let pending: string[] = [];
  model.rows.forEach((row, index) => {
    const before = pending.length ? [...pending, ...row.rulesBefore] : row.rulesBefore;
    pending = [];
    const reading = extras.macroRows?.[index];
    if (reading === undefined) { shown.push({ row: before === row.rulesBefore ? row : { ...row, rulesBefore: before }, index, text: source }); return; }
    const macro = { from: row.from, to: row.to };
    const wrapped = reading === null ? "" : `\\begin{tabular}{${model.spec}}${reading}\\end{tabular}`;
    const sub = reading === null ? null : parseTabular(wrapped, 0, types);
    // A row whose expansion cannot be read: its source, alone in its row.
    if (!sub) { shown.push({ row: { ...row, rulesBefore: before }, index: null, text: source, macro, raw: true }); return; }
    sub.rows.forEach((subRow, k) => shown.push({ row: k === 0 ? { ...subRow, rulesBefore: [...before, ...subRow.rulesBefore] } : subRow, index: null, text: wrapped, macro }));
    if (!sub.rows.length) pending.push(...before);
    pending.push(...sub.rulesAfter);
  });
  if (pending.length) closing = true;

  let drawn = 0;
  shown.forEach(({ row, index: rowIndex, text: rowSource, macro, raw }, shownIndex) => {
    const rulesBefore = [...carried, ...row.rulesBefore];
    carried = [];
    // stargazer's `\\[-1.8ex]\hline` and `\hline \\[-1.8ex]`: empty rows a negative space pulls up to nothing in the
    // PDF (the Grammarly paper's tables); their rules go to the next row.
    if (row.breakAt !== null && row.cells.every((cell) => !cell.text.trim()) && /^\\\\\*?\s*\[\s*-/.test(rowSource.slice(row.breakAt, row.to)) && ![...rowsCovered.values()].some((count) => count > 0)) {
      if (shownIndex + 1 < shown.length) { carried = rulesBefore; return; }
      if (rulesBefore.length) { closing = true; return; }
    }
    const tr = el("tr", "cm-vis-table-row");
    // `\addlinespace` is space, not a line; `\noalign{…}` sets up the line after it (a thicker one: Mask R-CNN's `\shline`).
    const lines = rulesBefore.filter((rule) => !/^\\(?:addlinespace|noalign)/.test(rule));
    // `\cline{2-3}` and `\cmidrule{2-3}` rule only their columns.
    const partial = lines.map((rule) => PARTIAL_RULE.exec(rule)).filter((match): match is RegExpExecArray => !!match).map((match) => [Number(match[1]) - 1, Number(match[2]) - 1] as const);
    const full = lines.filter((rule) => !PARTIAL_RULE.test(rule));
    const thick = rulesBefore.some((rule) => /^\\noalign\s*\{[^}]*\\arrayrulewidth\s*[\d.]+\s*pt/.test(rule));
    if (full.length) tr.classList.add(thick || full.some((rule) => /toprule|bottomrule/.test(rule)) ? "cm-vis-rule-heavy" : "cm-vis-rule");
    if (rulesBefore.some((rule) => /^\\addlinespace/.test(rule))) tr.classList.add("cm-vis-row-spaced");
    drawn++;
    if (rowColors && drawn >= rowColors.start) {
      const fill = drawn % 2 ? rowColors.odd : rowColors.even;
      if (fill) { tr.style.setProperty("--vis-fill", fill); tr.dataset.fill = ""; }
    }
    /** Shows the source of the row a macro writes. */
    const revealMacro = (event: MouseEvent) => {
      if (event.button !== 0 || !macro) return;
      event.preventDefault();
      event.stopPropagation();
      const base = start();
      if (base === null) return;
      if (readOnly) revealSourceAt(view, base, base + readOnlyLength!);
      else revealSourceAt(view, base + macro.from, base + macro.to);
    };
    if (raw && macro) {
      const td = el("td", "cm-vis-table-cell cm-vis-table-macro") as HTMLTableCellElement;
      td.colSpan = Math.max(1, model.columns.length);
      td.append(el("code", "cm-vis-raw", source.slice(macro.from, macro.to)));
      td.title = "A row written through a macro: click to edit its source";
      td.addEventListener("mousedown", revealMacro);
      tr.append(td);
      table.append(tr);
      return;
    }
    if (rowIndex !== null) {
      // More cells than the column specification has (or a `\multicolumn` past its end): drawn, and marked.
      const width = row.cells.reduce((sum, cell) => sum + cell.span, 0);
      if (model.columns.length && width > model.columns.length) {
        tr.classList.add("cm-vis-table-row-odd");
        tr.title = `This row has ${width} columns; the table's specification has ${model.columns.length}`;
      }
    }
    // Rows read from another file (`\input{./tables/summary_stats_post.tex} \\`, the Grammarly paper): a placeholder row.
    const input = rowIndex !== null && row.cells.length === 1 ? /^\\(?:input|include)\s*\{([^{}]+)\}$/.exec(row.cells[0].text.trim()) : null;
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
      if (partial.some(([first, last]) => column <= last && column + cell.span - 1 >= first)) td.classList.add("cm-vis-cell-rule");
      if (cell.span === 1 && columnFills[column]) { td.style.setProperty("--vis-column-fill", columnFills[column]!); td.dataset.columnFill = ""; }
      let text = cell.contentFrom !== undefined ? rowSource.slice(cell.contentFrom, cell.contentTo) : cell.text;
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
      } else if (cell.span === 1 && valigns[column]) td.style.verticalAlign = valigns[column]!;
      const trimmed = text.trim();
      const decimal = cell.span === 1 ? decimals.get(column) : undefined;
      const number = decimal ? DECIMAL.exec(trimmed) : null;
      const diagonal = DIAGBOX.exec(trimmed);
      const rotated = ROTATED.exec(trimmed);
      if (decimal && number && (number[2] || number[4])) {
        // The number as written, padded with digit-wide spaces so the column's points line up.
        const whole = number[1] + number[2];
        const fraction = number[4] ?? "";
        td.classList.add("cm-vis-table-decimal");
        td.textContent = FIGURE_SPACE.repeat(decimal.int - whole.length) + whole + (number[3] ?? (decimal.frac ? PUNCTUATION_SPACE : "")) + fraction + FIGURE_SPACE.repeat(decimal.frac - fraction.length);
      } else if (diagonal) {
        // A cell split by a diagonal: the first part below it, the second above.
        td.classList.add("cm-vis-table-diag");
        const above = el("span", "cm-vis-diag-above");
        above.append(renderLatexFragment(diagonal[2], context));
        const below = el("span", "cm-vis-diag-below");
        below.append(renderLatexFragment(diagonal[1], context));
        td.append(above, below);
      } else if (rotated && /^(?:90|-90|270)$/.test(rotated[1])) {
        // A header turned a quarter, read from the bottom up (90) or the top down (-90).
        const turned = el("span", rotated[1] === "90" ? "cm-vis-rotated cm-vis-rotated-up" : "cm-vis-rotated");
        turned.append(renderLatexFragment(rotated[2], context));
        td.append(turned);
      } else {
        const formula = cell.span === 1 && formulas[column] && trimmed && !text.includes("$") && !/^\s*\\multi(?:column|row)/.test(text);
        td.append(renderLatexFragment(formula ? `$${trimmed}$` : text, context));
        if (text.includes("\\")) dynamic.push({ td, text, from: macro ? macro.from : cell.contentFrom ?? cell.from });
      }
      if (macro) {
        // A row the document's macros write: drawn from their expansion; a click shows the row's source.
        td.classList.add("cm-vis-table-macro");
        td.title = "Written through a macro: click to edit its source";
        td.addEventListener("mousedown", revealMacro);
        tr.append(td);
        column += cell.span;
        return;
      }
      td.dataset.row = String(rowIndex);
      td.dataset.cell = String(cellIndex);
      // A cell with a comment or a line break inside opens as its whole source.
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
        // Shift-click selects cells, for merging them.
        if (event.shiftKey && tableHooks?.select) { tableHooks.select(view, td, start, rowIndex!, cellIndex); return; }
        if (tableHooks && !event.altKey && view.state.facet(visualConfig).editable() && !view.state.readOnly) { tableHooks.edit(view, td, start, rowIndex!, cellIndex); return; }
        const base = start();
        if (base !== null) revealSourceAt(view, base + cell.from, base + cell.to + 1);
      });
      td.addEventListener("contextmenu", (event) => {
        if (readOnly || !tableHooks || view.state.readOnly || !view.state.facet(visualConfig).editable()) return;
        event.preventDefault();
        event.stopPropagation();
        tableHooks.menu(view, event, start, rowIndex!, cellIndex);
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
    const cell = table.querySelector<HTMLElement>(".cm-vis-table-cell[data-row]:not(.cm-vis-table-source-only)") ?? table.querySelector<HTMLElement>(".cm-vis-table-cell[data-row]");
    if (!cell || !table.liberaTableStart) return false;
    tableHooks.edit(view, cell, table.liberaTableStart, Number(cell.dataset.row), Number(cell.dataset.cell));
    return true;
  }
  return false;
}

/** A tabular outside a table environment. */
export class TableWidget extends VisualWidget {
  /** `readOnly`: the source is a reading of the document (rows written through its macros), not a slice of it. */
  constructor(readonly source: string, readonly offset: number, readonly length: number, readonly readOnly = false, readonly extras?: TableExtras) {
    super(`${offset}\u0000${readOnly ? 1 : 0}\u0000${source}${extras ? `\u0000${JSON.stringify(extras)}` : ""}`);
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-vis-tabular");
    dom.append(renderTableGrid(view, this.source, () => {
      const pos = widgetPos(view, dom);
      return pos === null ? null : pos + this.offset;
    }, this.readOnly ? this.length - this.offset : undefined, this.extras));
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

/** The parts of a title block that open in the title editor (title-edit.ts). */
export type TitlePart = "title" | "author" | "date" | "abstract" | "line" | "note";

/**
 * A drawn title block: where it starts and how long its construct is, for finding its source; how far the source it
 * reads goes (past the block when a command in its run stays source); and how it redraws.
 */
export type TitleElement = HTMLElement & { liberaTitleStart?: () => number | null; liberaTitleLength?: number; liberaTitleScope?: number; liberaTitleRender?: () => void };

export type TitleHooks = {
  /** Opens the LaTeX of one part (the `index`th author) in place; false when its source cannot be found. */
  edit: (view: EditorView, block: TitleElement, part: TitlePart, index: number) => boolean;
  /** Shows the real source of the whole block (the preamble's `\title`, `\author`, … included) with the cursor at its first command; false when it cannot be found. */
  reveal?: (view: EditorView, block: TitleElement) => boolean;
  /** Whether another author can be added (only where `\and` joins the authors), and opens a field for the new one. */
  canAddAuthor?: (view: EditorView, block: TitleElement) => boolean;
  addAuthor?: (view: EditorView, block: TitleElement) => boolean;
  /** A redrawn title block: continues an edit that was open in the block it replaces. */
  adopt?: (view: EditorView, block: TitleElement) => void;
};
let titleHooks: TitleHooks | null = null;
/** Set by title-edit.ts. */
export function setTitleHooks(hooks: TitleHooks | null) { titleHooks = hooks; }

function titleEditable(view: EditorView) {
  return !!titleHooks && !view.state.readOnly && view.state.facet(visualConfig).editable();
}

/** Opens the first part of a title block drawn in [from, to] (Enter on the selected block); false when there is none. */
export function editTitleAt(view: EditorView, from: number, to: number) {
  if (!titleHooks || !titleEditable(view)) return false;
  for (const block of view.contentDOM.querySelectorAll<TitleElement>(".cm-vis-title-block")) {
    const start = block.liberaTitleStart?.();
    if (start === null || start === undefined || start < from || start >= to) continue;
    const first = block.querySelector<HTMLElement>("[data-title-part]");
    if (!first) return false;
    return titleHooks.edit(view, block, first.dataset.titlePart as TitlePart, Number(first.dataset.titleIndex ?? 0));
  }
  return false;
}

/** The title block drawn in [from, to] shows its whole source (Alt+Enter on the selected block); false when there is none. */
export function revealTitleSourceAt(view: EditorView, from: number, to: number) {
  if (!titleHooks?.reveal) return false;
  for (const block of view.contentDOM.querySelectorAll<TitleElement>(".cm-vis-title-block")) {
    const start = block.liberaTitleStart?.();
    if (start === null || start === undefined || start < from || start >= to) continue;
    return titleHooks.reveal(view, block);
  }
  return false;
}

/**
 * `\maketitle`: the title, authors and date from the preamble. Click a part to edit its LaTeX (title-edit.ts); the
 * source button (or Alt-click) shows the block's real source, in the preamble where it is written.
 */
export class TitleWidget extends VisualWidget {
  /**
   * `abstract`: an abstract the class prints with the title (acmart's, written before `\begin{document}`); `notes`: small
   * lines under it, as label and LaTeX (keywords, CCS concepts, subject classes).
   */
  /**
   * `details`: a class's subtitle, each author's affiliations and emails, institutes and notes (front-matter.ts), each
   * editable line a `line` part numbered in editableLines' order; `scope`: how far from the block's start its source goes.
   */
  constructor(readonly title: string | null, readonly author: string | null, readonly date: string | null, readonly length: number, readonly abstract: string | null = null, readonly notes: ReadonlyArray<readonly [string, string]> = [], readonly details: FrontDetailsView | null = null, readonly scope: number | null = null) {
    super(JSON.stringify([title, author, date, length, abstract, notes, details, scope]));
  }
  toDOM(view: EditorView) {
    const dom: TitleElement = el("div", "cm-vis-title-block");
    const editable = titleEditable(view);
    const part = (node: HTMLElement, name: TitlePart, index = 0) => {
      node.dataset.titlePart = name;
      node.dataset.titleIndex = String(index);
      if (editable) node.title = "Click to edit · Alt-click for the source";
      return node;
    };
    const render = (target: EditorView) => {
      // An open editor keeps its draft: a numbering change elsewhere does not redraw it away.
      if (dom.querySelector(".cm-vis-title-editor")) return;
      const context = widgetContext(target, dom);
      dom.replaceChildren();
      const details = this.details;
      // The class's lines, numbered as title-edit.ts finds their source.
      const editableIndex = new Map(details ? editableLines(details).map((line, index) => [line, index] as const) : []);
      const line = (className: string, item: FrontLineView) => {
        const node = el("div", className);
        if (item.label) node.append(el("span", "cm-vis-title-line-label", item.label));
        node.append(renderLatexFragment(item.latex, context));
        return item.editable && editableIndex.has(item) ? part(node, "line", editableIndex.get(item)!) : node;
      };
      if (this.title !== null) { const title = part(el("div", "cm-vis-title"), "title"); title.append(renderLatexFragment(this.title, context)); dom.append(title); }
      if (details?.subtitle) dom.append(line("cm-vis-subtitle", details.subtitle));
      if (this.author !== null) {
        const authors = el("div", "cm-vis-authors");
        let index = 0;
        for (const piece of this.author.split(/\\(?:and|And|AND)(?![A-Za-z])/)) {
          if (!piece.trim()) continue;
          const lines = details?.authorLines[index] ?? [];
          const author = part(el("div", "cm-vis-author"), "author", index++);
          author.append(renderLatexFragment(piece.trim(), context));
          if (!lines.length) { authors.append(author); continue; }
          // The author's affiliations and emails under the name, each its own part.
          const group = el("div", "cm-vis-author-group");
          group.append(author, ...lines.map((item) => line("cm-vis-affiliation", item)));
          authors.append(group);
        }
        // Another author, after `\and`: only where the class joins authors that way (title-edit.ts decides, once placed).
        if (editable && titleHooks?.addAuthor && titleHooks.canAddAuthor) {
          const add = el("button", "cm-vis-title-add-author") as HTMLButtonElement;
          add.type = "button";
          add.title = "Add an author";
          add.setAttribute("aria-label", "Add an author");
          add.addEventListener("mousedown", (event) => event.preventDefault());
          add.addEventListener("click", (event) => {
            event.preventDefault();
            if (!titleHooks?.addAuthor?.(view, dom)) showSource();
          });
          const sync = () => { add.hidden = !titleHooks?.canAddAuthor?.(view, dom); };
          sync();
          queueMicrotask(() => { if (add.isConnected) sync(); });
          authors.append(add);
        }
        dom.append(authors);
      }
      if (details?.places.length) {
        const places = el("div", "cm-vis-title-places");
        places.append(...details.places.map((item) => line("cm-vis-affiliation", item)));
        dom.append(places);
      }
      if (this.date !== null) { const date = part(el("div", "cm-vis-date"), "date"); date.append(renderLatexFragment(this.date, context)); dom.append(date); }
      if (this.abstract) {
        const abstract = el("div", "cm-vis-title-abstract");
        const heading = el("div", "cm-vis-title-abstract-heading");
        heading.textContent = "Abstract";
        const body = part(el("div", "cm-vis-title-abstract-body"), "abstract");
        body.append(renderLatexFragment(this.abstract, context));
        abstract.append(heading, body);
        dom.append(abstract);
      }
      // Keywords, CCS concepts and subject classes: numbered on their own, each opens its LaTeX (or its source, when several commands write it).
      this.notes.forEach(([label, latex], index) => {
        const note = el("div", "cm-vis-title-note");
        note.dataset.titleNote = String(index);
        if (editable) note.title = "Click to edit · Alt-click for the source";
        note.append(el("span", "cm-vis-title-note-label", `${label}: `), renderLatexFragment(latex, context));
        dom.append(note);
      });
      for (const item of details?.notes ?? []) dom.append(line("cm-vis-title-note", item));
      // Always a way to the raw source: the button shows when the pointer or the focus is in the block.
      const tools = el("div", "cm-vis-title-tools");
      const source = el("button", "cm-vis-title-source") as HTMLButtonElement;
      source.type = "button";
      source.title = "Edit source";
      source.setAttribute("aria-label", "Edit the title block's source");
      source.addEventListener("mousedown", (event) => event.preventDefault());
      source.addEventListener("click", (event) => { event.preventDefault(); showSource(); });
      tools.append(source);
      dom.append(tools);
    };
    /** The block's real source: its commands wherever they are written (the preamble opens), else its own range. */
    const showSource = () => {
      if (titleHooks?.reveal?.(view, dom)) return;
      const from = widgetPos(view, dom);
      if (from !== null) revealSourceAt(view, from, from + this.length);
    };
    dom.liberaTitleStart = () => widgetPos(view, dom);
    dom.liberaTitleLength = this.length;
    if (this.scope !== null) dom.liberaTitleScope = this.scope;
    dom.liberaTitleRender = () => render(view);
    render(view);
    refreshable(dom, view, render);
    if (editable) {
      dom.classList.add("cm-vis-title-editable");
      queueMicrotask(() => { if (dom.isConnected) titleHooks?.adopt?.(view, dom); });
    }
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // Clicks in an open editor place its caret.
      if (target.closest(".cm-vis-title-editor, .cm-vis-title-tools, .cm-vis-title-add-author")) return;
      event.preventDefault();
      const clicked = target.closest<HTMLElement>("[data-title-part], [data-title-note]");
      if (clicked && !event.altKey && titleHooks && titleEditable(view)) {
        const note = clicked.dataset.titleNote !== undefined;
        if (titleHooks.edit(view, dom, note ? "note" : clicked.dataset.titlePart as TitlePart, Number((note ? clicked.dataset.titleNote : clicked.dataset.titleIndex) ?? 0))) return;
        // A part that is not one field (a list several commands write): its source, where it is written.
        if (titleHooks.reveal?.(view, dom)) return;
      }
      if (event.altKey && titleHooks?.reveal?.(view, dom)) return;
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
      // Author–year lists hang without a label column.
      dom.classList.toggle("cm-vis-references-labelled", entries.some((entry) => entry.label));
      for (const entry of sorted) {
        const line = el("div", "cm-vis-references-item");
        const who = entry.author ? plainTexText(entry.author.split(/\s+and\s+/).join(", ")) : entry.citeAuthor ? plainTexText(entry.citeAuthor) : "";
        const title = entry.title ? plainTexText(entry.title) : "";
        // A working paper's title block may end with its year ("…disaggregated data, 2016").
        const year = entry.year && !title.endsWith(entry.year) ? entry.year : "";
        // "Abadie et al." already ends with its period.
        const parts = [who, title, year].map((part) => part.trim().replace(/\.$/, "")).filter(Boolean);
        if (entry.label) line.append(el("span", "cm-vis-references-label", `[${entry.label}]`));
        line.append(document.createTextNode(`${parts.join(". ")}.`));
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
  constructor(readonly variant: "theorem" | "proof" | "abstract" | "user", readonly title: string, readonly note: string | null, readonly kind: NumberingKind | null, readonly numberOffset: number, readonly length = 0) {
    super(JSON.stringify([variant, title, note, kind, numberOffset, length]));
  }
  toDOM(view: EditorView) {
    const dom = el("span", `cm-vis-env-header cm-vis-env-header-${this.variant}`);
    // A box's title (its `\begin` over several lines): a click shows the opening as written.
    if (this.length) revealOnClick(view, dom, this.length);
    const render = (target: EditorView) => {
      dom.replaceChildren();
      const context = widgetContext(target, dom);
      if (this.variant === "user") {
        // A numbered box's title (`Box~\thetcbcounter: …`): the number the numbering pass gave the box.
        let title = this.title;
        if (this.kind) {
          const pos = widgetPos(target, dom);
          const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos + this.numberOffset, this.kind);
          title = title.replace(/\\thetcbcounter(?![A-Za-z@])\s*/g, entry?.number ?? "");
        }
        dom.append(renderLatexFragment(title, context));
        return;
      }
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

/** thmtools' `\begin{restatable}[note]{env}{name}` in a document, by name: where each is, its environment and note (per document version). */
const restatableCache = new WeakMap<Text, Map<string, { from: number; env: string; note: string | null }>>();
export function restatablesIn(doc: Text) {
  let found = restatableCache.get(doc);
  if (found) return found;
  found = new Map();
  const text = doc.toString();
  for (const match of text.matchAll(/\\begin\s*\{restatable\*?\}\s*(?:\[((?:[^\][{}]|\{[^{}]*\})*)\])?\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
    if (!found.has(match[3].trim())) found.set(match[3].trim(), { from: match.index, env: match[2].trim(), note: match[1]?.trim() || null });
  }
  restatableCache.set(doc, found);
  return found;
}

/**
 * thm-restate's `\promisemonoids*` (Larrauri & Živný), printing a restatable theorem again with its number: its
 * heading, "Theorem 1 (Main, restated)". The number is the restatable's, looked up where it is when drawn.
 */
export class RestatedTheoremWidget extends VisualWidget {
  constructor(readonly name: string, readonly title: string, readonly note: string | null, readonly numbered: boolean) {
    super(JSON.stringify([name, title, note, numbered]));
  }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-env-header cm-vis-env-header-theorem");
    const render = (target: EditorView) => {
      const context = widgetContext(target, dom);
      const at = restatablesIn(target.state.doc).get(this.name)?.from;
      const entry = this.numbered && at !== undefined ? numberingEntryAt(visualNumbering(target.state), at, "theorem") : null;
      const head = el("span", "cm-vis-env-title");
      head.append(renderLatexFragment(this.title, context), document.createTextNode(entry?.number ? ` ${entry.number}` : ""));
      const note = el("span", "cm-vis-env-note");
      note.append(document.createTextNode(" ("));
      if (this.note) note.append(renderLatexFragment(this.note, context), document.createTextNode(", "));
      note.append(document.createTextNode("restated)"));
      dom.replaceChildren(head, note, document.createTextNode(". "));
    };
    render(view);
    refreshable(dom, view, render);
    return dom;
  }
}

/** todonotes' `\todo{…}` and `\missingfigure{…}`: a note chip with its text; a click shows the source. */
export class TodoWidget extends VisualWidget {
  constructor(readonly label: string, readonly latex: string, readonly length: number) { super(`${label}\u0000${latex}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = el("span", "cm-vis-chip cm-vis-todo");
    const render = (target: EditorView) => dom.replaceChildren(el("strong", undefined, `${this.label}: `), renderLatexFragment(this.latex, widgetContext(target, dom)));
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
