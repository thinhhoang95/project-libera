import { WidgetType, type EditorView } from "@codemirror/view";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { listOptionMap, numberingEntryAt, type LatexNumbering } from "../../macros/numbering";
import type { LatexDefinitions } from "../../macros/definitions";
import { visualNumbering } from "./model";
import { renderLatexFragment } from "./render-fragment";
export { TEXT_WRAPPERS } from "./symbols";
import { refreshable, revealSourceAt, widgetContext, widgetPos } from "./widgets";

/* Running-text commands the Visual mode draws (lists' and counters' text, code, tracked changes, boxes): what each
 * command shows, and the widgets for those it draws whole. walk.ts recognises them; their text stays editable in place
 * where it is text (a tracked change, a box, a code block's lines). */

/** The counters a document may print with `\the…`, `\arabic{…}` and the like: LaTeX's, its theorems', and those its preamble makes. */
const preambleCounters = new WeakMap<LatexDefinitions, Set<string>>();
const LATEX_COUNTERS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "equation", "figure", "table", "footnote", "enumi", "enumii", "enumiii", "enumiv", "algorithm", "lstlisting"];
export function documentCounters(defs: LatexDefinitions, preamble: () => string) {
  let counters = preambleCounters.get(defs);
  if (!counters) {
    counters = new Set(LATEX_COUNTERS);
    for (const theorem of defs.theorems.values()) counters.add(theorem.counter);
    for (const counter of defs.counterWithin.keys()) counters.add(counter);
    for (const match of preamble().matchAll(/\\newcounter\s*\{\s*([A-Za-z@]+)\s*\}/g)) counters.add(match[1]);
    preambleCounters.set(defs, counters);
  }
  return counters;
}

/** `\verb|…|`, `\verb*|…|`, `\lstinline[…]|…|`, `\lstinline{…}`: where the code is in `text` (from the content's start), or null when it is not closed on its line. */
export function inlineCodeRange(text: string): { from: number; to: number } | null {
  let i = 0;
  if (text[i] === "*") i++;
  if (text[i] === "[") {
    const options = readOptional(text, i, TEX_GROUPS);
    if (!options) return null;
    i = options.end;
  }
  const delimiter = text[i];
  if (!delimiter || /[\sA-Za-z*]/.test(delimiter)) return null;
  const close = text.indexOf(delimiter === "{" ? "}" : delimiter, i + 1);
  if (close < 0 || /\n/.test(text.slice(i, close))) return null;
  return { from: i + 1, to: close };
}

/** Environments the Visual mode draws as code: their lines stay as written, in the typewriter face. */
export const CODE_ENVIRONMENTS = /^(?:verbatim\*?|Verbatim\*?|lstlisting|minted)$/;

export type CodeHeader = {
  /** Where the header (`\begin{lstlisting}[…]`, `\begin{minted}{python}`) ends, from the content's start. */
  end: number;
  language: string | null;
  /** listings' `caption=` (numbered) or `title=` (not), as LaTeX. */
  caption: string | null;
  numbered: boolean;
};

/** A code environment's options at the start of its (verbatim) content, on its `\begin` line; null when they are not closed there. */
export function readCodeHeader(env: string, content: string): CodeHeader | null {
  let i = 0;
  let options = "";
  const open = /^[ \t]*\[/.exec(content);
  if (open) {
    const group = readOptional(content, open[0].length - 1, TEX_GROUPS);
    if (!group || content.slice(0, group.end).includes("\n")) return null;
    options = group.content;
    i = group.end;
  }
  let language: string | null = null;
  if (env === "minted") {
    const brace = /^[ \t]*\{/.exec(content.slice(i));
    const group = brace ? readGroup(content, i + brace[0].length - 1, TEX_GROUPS) : null;
    if (!group || content.slice(0, group.end).includes("\n")) return null;
    language = group.content.trim();
    i = group.end;
  }
  // Nothing else on the `\begin` line.
  const rest = /^[ \t]*(?:\r?\n|$)/.exec(content.slice(i));
  if (!rest) return null;
  const map = listOptionMap(options);
  language ??= map.get("language") ?? null;
  let caption = map.get("caption") ?? null;
  const title = map.get("title") ?? null;
  // `caption={[short]long}`: the long one is shown.
  if (caption?.startsWith("[")) caption = caption.slice((readOptional(caption, 0, TEX_GROUPS)?.end ?? 0)).trim();
  return { end: i, language, caption: caption || title || null, numbered: env === "lstlisting" && !!caption };
}

/* A small tokenizer for a few languages' comments, strings and keywords: a code block's colours. */
const KEYWORDS: Record<string, Set<string>> = {
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  c: new Set("auto bool break case char class const continue default delete do double else enum extern false float for goto if inline int long namespace new nullptr private protected public return short signed sizeof static struct switch template this true typedef typename union unsigned using virtual void volatile while".split(" ")),
  java: new Set("abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void while".split(" ")),
  javascript: new Set("async await break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while yield".split(" ")),
};
const LANGUAGE_FAMILY: Record<string, string> = {
  python: "python", py: "python", python3: "python", c: "c", "c++": "c", cpp: "c", cuda: "c", java: "java", javascript: "javascript", js: "javascript", typescript: "javascript", ts: "javascript",
};

export type CodeToken = { from: number; to: number; class: string };

/** The comments, strings and keywords in a code block's text, for the languages above; none for others. */
export function codeTokens(text: string, language: string | null): CodeToken[] {
  const family = LANGUAGE_FAMILY[(language ?? "").toLowerCase().replace(/^\[[^\]]*\]/, "")];
  if (!family) return [];
  const keywords = KEYWORDS[family];
  const lineComment = family === "python" ? "#" : "//";
  const tokens: CodeToken[] = [];
  const pattern = family === "python"
    ? /#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[A-Za-z_]\w*/g
    : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[A-Za-z_]\w*/g;
  for (const match of text.matchAll(pattern)) {
    const word = match[0];
    const from = match.index!;
    if (word.startsWith(lineComment) || word.startsWith("/*")) tokens.push({ from, to: from + word.length, class: "cm-vis-code-comment" });
    else if (word[0] === "\"" || word[0] === "'") tokens.push({ from, to: from + word.length, class: "cm-vis-code-string" });
    else if (keywords.has(word)) tokens.push({ from, to: from + word.length, class: "cm-vis-code-keyword" });
  }
  return tokens;
}

/**
 * A code environment's source (`\begin{lstlisting}[caption=…] … \end{lstlisting}`, `minted`, `verbatim`) as a block, for
 * a float that holds one: its caption and its code; null for anything else. The text is taken as written.
 */
export function readCodeBlock(source: string): { env: string; header: CodeHeader; code: string } | null {
  const begin = /^\s*\\begin\s*\{([A-Za-z]+\*?)\}/.exec(source);
  if (!begin || !CODE_ENVIRONMENTS.test(begin[1])) return null;
  const env = begin[1];
  const end = source.lastIndexOf(`\\end{${env}}`);
  if (end < begin[0].length || source.slice(end + env.length + 6).trim()) return null;
  const content = source.slice(begin[0].length, end);
  const header = readCodeHeader(env, content);
  if (!header) return null;
  return { env, header, code: content.slice(header.end).replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "") };
}

/** A code block drawn whole (in a float): its caption ("Listing 2: …", numbered by `number`) and its lines, coloured. */
export function renderCodeBlock(block: NonNullable<ReturnType<typeof readCodeBlock>>, render: (latex: string) => Node, number: string | null) {
  const figure = document.createElement("div");
  figure.className = "cm-vis-code-block";
  if (block.header.caption) figure.append(codeCaption(block.header.caption, block.header.numbered ? number : null, render));
  const pre = document.createElement("pre");
  pre.className = "cm-vis-code";
  let at = 0;
  for (const token of codeTokens(block.code, block.header.language)) {
    pre.append(document.createTextNode(block.code.slice(at, token.from)));
    const span = document.createElement("span");
    span.className = token.class;
    span.textContent = block.code.slice(token.from, token.to);
    pre.append(span);
    at = token.to;
  }
  pre.append(document.createTextNode(block.code.slice(at)));
  figure.append(pre);
  return figure;
}

function codeCaption(caption: string, number: string | null, render: (latex: string) => Node) {
  const head = document.createElement("span");
  head.className = "cm-vis-code-caption";
  if (number !== null) {
    const label = document.createElement("span");
    label.className = "cm-vis-figure-label";
    label.textContent = `Listing ${number}: `;
    head.append(label);
  }
  head.append(render(caption));
  return head;
}

abstract class TextWidget extends WidgetType {
  constructor(readonly key: string) { super(); }
  eq(other: WidgetType) { return other instanceof TextWidget && other.constructor === this.constructor && other.key === this.key; }
}

/** A clickable widget: a click shows the source of its range, `length` long from the widget's start. */
function revealOnClick(dom: HTMLElement, view: EditorView, length: number) {
  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = widgetPos(view, dom);
    if (from !== null) revealSourceAt(view, from, from + length);
  });
}

/** A counter printed in the text (`\theex`, `\arabic{ex}`): its value where it is, from the numbering pass; its source until then. */
export class CounterWidget extends TextWidget {
  constructor(readonly source: string) { super(source); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-counter";
    dom.title = this.source;
    refreshable(dom, view, (target) => {
      const pos = widgetPos(target, dom);
      const entry = pos === null ? null : numberingEntryAt(visualNumbering(target.state), pos, "counter");
      dom.textContent = entry?.number ?? this.source;
      dom.classList.toggle("cm-vis-raw", !entry);
    });
    dom.textContent = this.source;
    return dom;
  }
}

/** A drawing in the text written as LaTeX (`\rule{2cm}{0.4pt}`, `\hrulefill`): drawn by the fragment renderer; a click shows its source. */
export class TextDrawingWidget extends TextWidget {
  constructor(readonly latex: string, readonly length: number) { super(`${latex}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-text-drawing";
    dom.title = this.latex;
    dom.append(renderLatexFragment(this.latex, widgetContext(view, dom)));
    revealOnClick(dom, view, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
}

/** A `\url` whose address was written with a macro (`\url{\repourl}`): the address it prints, as a link; a click shows the source (Ctrl-click opens it). */
export class LinkTextWidget extends TextWidget {
  /** `href`: where Ctrl-click goes when it is not the text itself (`\doi{10.1/x}` prints "doi: 10.1/x", a link to doi.org). */
  constructor(readonly text: string, readonly title: string, readonly length: number, readonly href = text) { super(`${text}\u0000${title}\u0000${length}\u0000${href}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-link";
    dom.textContent = this.text;
    dom.title = this.title;
    dom.dataset.href = this.href;
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const from = widgetPos(view, dom);
      if (from !== null) revealSourceAt(view, from, from + this.length);
    });
    return dom;
  }
  ignoreEvent() { return true; }
}

/** pdfpages' `\includepdf[pages=…]{file.pdf}`: a small placeholder naming the file (its pages are not drawn); a click shows its source. */
export class PdfPagesWidget extends TextWidget {
  constructor(readonly file: string, readonly source: string, readonly length: number) { super(`${file}\u0000${source}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-pdf-pages cm-vis-symbol";
    dom.textContent = `PDF pages: ${this.file}`;
    dom.title = this.source;
    dom.setAttribute("style", "border:1px dashed currentColor;border-radius:3px;padding:0 .4em;opacity:.7;font-size:.85em");
    revealOnClick(dom, view, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
}

/** `\input{chapters/intro}`, `\include{…}`: the file the line pulls in, as a small chip naming it; a click shows its source. */
export class IncludeChipWidget extends TextWidget {
  constructor(readonly file: string, readonly source: string, readonly length: number) { super(`${file}\u0000${source}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-include cm-vis-symbol";
    dom.textContent = `include: ${this.file}`;
    dom.title = this.source;
    dom.setAttribute("style", "border:1px dashed currentColor;border-radius:3px;padding:0 .4em;opacity:.7;font-size:.85em");
    revealOnClick(dom, view, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
}

/** listings' caption over a code block (its `\begin{lstlisting}[caption=…]` line): "Listing 1: …", numbered by the numbering pass. */
export class CodeCaptionWidget extends TextWidget {
  constructor(readonly caption: string, readonly numbered: boolean, readonly numberOffset: number) { super(`${caption}\u0000${numbered ? 1 : 0}\u0000${numberOffset}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-vis-code-caption";
    const render = (target: EditorView) => {
      const pos = widgetPos(target, dom);
      const entry = this.numbered && pos !== null ? numberingEntryAt(visualNumbering(target.state), pos + this.numberOffset, "listing") : null;
      dom.replaceChildren(codeCaption(this.caption, this.numbered ? entry?.number ?? "" : null, (latex) => renderLatexFragment(latex, widgetContext(target, dom))));
    };
    render(view);
    refreshable(dom, view, render);
    return dom;
  }
}

/** listings' `\lstinputlisting[caption=…]{file}` and minted's `\inputminted{lang}{file}`: the file's name in a code block, under its caption. */
export class CodeFileWidget extends TextWidget {
  constructor(readonly file: string, readonly caption: string | null, readonly numbered: boolean, readonly length: number) { super(`${file}\u0000${caption}\u0000${numbered ? 1 : 0}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-vis-code-block cm-vis-code-file";
    const pre = document.createElement("pre");
    pre.className = "cm-vis-code";
    pre.textContent = this.file;
    const render = (target: EditorView) => {
      const pos = widgetPos(target, dom);
      const entry = this.numbered && pos !== null ? numberingEntryAt(visualNumbering(target.state), pos, "listing") : null;
      const parts: Node[] = [];
      if (this.caption) parts.push(codeCaption(this.caption, this.numbered ? entry?.number ?? "" : null, (latex) => renderLatexFragment(latex, widgetContext(target, dom))));
      dom.replaceChildren(...parts, pre);
    };
    render(view);
    refreshable(dom, view, render);
    revealOnClick(dom, view, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 40; }
}

/** The headings, figures or tables the numbering pass found, with their titles read from the document at their positions. */
function contentsEntries(numbering: LatexNumbering, kind: "section" | "figure" | "table", read: (from: number, to: number) => string, length: number) {
  const out: Array<{ number: string | null; level: number; title: string }> = [];
  for (const entry of numbering.entries) {
    if (entry.kind !== kind || entry.pos < 0) continue;
    const text = read(entry.pos, Math.min(length, entry.pos + 4000));
    if (kind === "section") {
      // `\section[short]{Long}`: the short title is what the contents list shows; a starred heading is not listed.
      const head = /^\\[A-Za-z]+(\*)?\s*/.exec(text);
      if (!head || head[1]) continue;
      let i = head[0].length;
      let title: string | null = null;
      if (text[i] === "[") { const short = readOptional(text, i, TEX_GROUPS); if (!short) continue; title = short.content; i = short.end; while (/\s/.test(text[i] ?? "")) i++; }
      const group = text[i] === "{" ? readGroup(text, i, TEX_GROUPS) : null;
      if (!group) continue;
      out.push({ number: entry.number, level: entry.level ?? 1, title: title ?? group.content });
    } else {
      const caption = /\\caption\s*(?:\[[^\]]*\]\s*)?\{/.exec(text);
      const group = caption ? readGroup(text, caption.index + caption[0].length - 1, TEX_GROUPS) : null;
      if (!group || !entry.number) continue;
      out.push({ number: entry.number, level: 1, title: group.content });
    }
  }
  return out;
}

/**
 * `\tableofcontents`, `\listoffigures` and `\listoftables`: the list they print, from the document's headings and
 * captions as numbered here (read-only; a click shows the command).
 */
export class ContentsWidget extends TextWidget {
  constructor(readonly kind: "section" | "figure" | "table", readonly length: number) { super(`${kind}\u0000${length}`); }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-vis-contents";
    const render = (target: EditorView) => {
      const heading = document.createElement("div");
      heading.className = "cm-vis-contents-title";
      heading.textContent = this.kind === "section" ? "Contents" : this.kind === "figure" ? "List of Figures" : "List of Tables";
      const doc = target.state.doc;
      const context = widgetContext(target, dom);
      const rows = contentsEntries(visualNumbering(target.state), this.kind, (from, to) => doc.sliceString(from, to), doc.length).map((entry) => {
        const row = document.createElement("div");
        row.className = `cm-vis-contents-row cm-vis-contents-level${Math.max(0, Math.min(4, entry.level))}`;
        const number = document.createElement("span");
        number.className = "cm-vis-contents-number";
        number.textContent = entry.number ?? "";
        row.append(number, renderLatexFragment(entry.title, context));
        return row;
      });
      dom.replaceChildren(heading, ...rows);
    };
    render(view);
    refreshable(dom, view, render);
    revealOnClick(dom, view, this.length);
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 80; }
}
