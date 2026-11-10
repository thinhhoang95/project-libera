import { historyField, isolateHistory, undo, undoDepth } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import { insertLargeText, utf8Length } from "../../collab/bindings/codemirror";
import { stopCapturing } from "../../collab/undo-boundary";
import { indentLines } from "../latex-text";
import { isRichClipboardHtml, looksLikeMarkdown, scoreMarkdown } from "../markdown-paste/detect";
import { createPasteContext, readPreambleInfo, sectionBefore, type LatexPasteContext, type PasteEngine } from "../markdown-paste/context";
import { resolveLatexEngine, stripLatexComments } from "../project";
import type { MathMarkerSettings } from "../../math-markers";
import { latexProjectField } from "./editing";
import { macroSourcesField } from "./visual/model";

/* Pasting Markdown in a `.tex` file, in Source and Visual mode
 * (docs/latex-markdown-paste-plan.md §1, §5, §8). This part is synchronous
 * and small: it decides in the paste event whether the text is Markdown,
 * keeps the target range mapped through later edits (a collaborator's, say)
 * while the dialog is open, and inserts the result as one undo step. Parsing
 * and conversion are loaded on demand by the editor component. */

/** Where a paste may not be converted: math, verbatim and comments take the text as it is. */
const LITERAL = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math", "VerbatimEnvironment", "Comment", "VerbatimContent", "LstInlineContent", "VerbContent"]);
const LARGE_PASTE_BYTES = 64 * 1024;

export type MarkdownPasteRequest = {
  text: string;
  /** Rich clipboard HTML (Word, Google Docs, a web page) to convert instead of `text`; `text` is its plain text. */
  html?: string;
  range: TrackedRange;
  /** "paste": detected in a paste event; "command": Paste Markdown as LaTeX; "selection": Convert Markdown to LaTeX. */
  origin: "paste" | "command" | "selection";
  /**
   * The text that must still be at the range when the result goes in: the
   * selection the paste replaces or the Markdown being converted (a
   * collaborator's edit inside it while the dialog is open is never
   * overwritten), or, for Options… on a notice, the LaTeX inserted earlier.
   */
  expected?: string;
  /** Options… on a notice: the range holds LaTeX pasted earlier, which the new result replaces. */
  notice?: boolean;
};

/**
 * Paste events this extension declined to convert on purpose (⇧⌘V, or the
 * cursor in math, verbatim, a comment or the preamble): the Visual mode's
 * HTML paste leaves them alone too, so they paste as plain text.
 */
export const plainPasteEvents = new WeakSet<Event>();

/* ---- Target ranges, mapped through changes ---------------------------------- */

/** `before`: text inserted at the range's start goes after it (a target range's start sticks to the text after it, by default). */
type Range = { from: number; to: number; before?: boolean };
const addRange = StateEffect.define<{ id: number } & Range>();
const removeRange = StateEffect.define<number>();

const trackedRanges = StateField.define<ReadonlyMap<number, Range>>({
  create: () => new Map(),
  update(ranges, transaction) {
    let next = ranges;
    if (transaction.docChanged && ranges.size) {
      const mapped = new Map<number, Range>();
      for (const [id, range] of ranges) {
        const from = transaction.changes.mapPos(range.from, range.before ? -1 : 1);
        mapped.set(id, { from, to: Math.max(from, transaction.changes.mapPos(range.to, -1)), before: range.before });
      }
      next = mapped;
    }
    for (const effect of transaction.effects) {
      if (effect.is(addRange)) next = new Map(next).set(effect.value.id, { from: effect.value.from, to: effect.value.to, before: effect.value.before });
      else if (effect.is(removeRange) && next.has(effect.value)) { const copy = new Map(next); copy.delete(effect.value); next = copy; }
    }
    return next;
  },
});

/** Views that were destroyed (tab closed, editor recreated): their ranges are gone, and nothing is inserted into them. */
const destroyedViews = new WeakSet<EditorView>();
const destroyWatcher = ViewPlugin.define((view) => ({ destroy() { destroyedViews.add(view); } }));

export function isViewAlive(view: EditorView) {
  return !destroyedViews.has(view);
}

export type TrackedRange = {
  readonly view: EditorView;
  /** The range now, after any changes since it was taken; null once released or when the editor is gone. */
  current(): { from: number; to: number } | null;
  release(): void;
};

let nextRangeId = 1;

export function trackRange(view: EditorView, from: number, to: number, { before = false }: { before?: boolean } = {}): TrackedRange {
  const id = nextRangeId++;
  view.dispatch({ effects: addRange.of({ id, from, to, before }) });
  let released = false;
  const read = () => { const range = view.state.field(trackedRanges, false)?.get(id); return range ? { from: range.from, to: range.to } : null; };
  return {
    view,
    current: () => released || destroyedViews.has(view) ? null : read(),
    release: () => {
      if (released) return;
      released = true;
      if (destroyedViews.has(view)) return;
      try { view.dispatch({ effects: removeRange.of(id) }); } catch { /* destroyed */ }
    },
  };
}

/* ---- Context ---------------------------------------------------------------- */

/** `\begin{document}` that is not in a comment: its start, and where the body starts. */
function documentBegin(head: string): { index: number; end: number } | null {
  for (const match of head.matchAll(/\\begin\s*\{document\}/g)) {
    const lineStart = head.lastIndexOf("\n", match.index) + 1;
    const prefix = head.slice(lineStart, match.index);
    if (stripLatexComments(prefix) !== prefix) continue;
    return { index: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Whether a paste at `pos` must stay as typed: math, verbatim, comments, the preamble. */
export function pasteStaysLiteral(state: EditorState, pos: number) {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (!LITERAL.has(node.name)) continue;
    // Right after a formula's closing delimiter is outside it; a comment runs to the end of its line.
    if (node.name === "Comment" ? pos > node.from : pos > node.from && pos < node.to) return true;
  }
  const begin = documentBegin(state.doc.sliceString(0, Math.min(state.doc.length, 400_000)));
  return !!begin && pos < begin.end;
}

/** Inside a command argument, a group or a tabular: only inline LaTeX fits there. */
export function pasteIsInlineOnly(state: EditorState, pos: number) {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (pos <= node.from || pos >= node.to) continue;
    if (/Argument$/.test(node.name) || node.name === "Group" || node.name === "NonEmptyGroup") return true;
    if (node.name === "TabularEnvironment") return true;
    if (/Environment$/.test(node.name) || node.name === "Document") return false;
  }
  return false;
}

/** Lists and other list-based environments around `pos` (LaTeX nests four of a kind, six in all). */
export function listDepthAt(state: EditorState, pos: number) {
  const depth = { itemize: 0, enumerate: 0, other: 0 };
  // An environment can have two nodes over the same range (KnownEnvironment around ListEnvironment): counted once.
  const counted = new Set<number>();
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (!/Environment$/.test(node.name) || pos <= node.from || pos >= node.to || counted.has(node.from)) continue;
    counted.add(node.from);
    const name = /^\\begin\s*\{([^}]*)\}/.exec(state.doc.sliceString(node.from, Math.min(node.to, node.from + 80)))?.[1].trim() ?? "";
    if (name === "itemize") depth.itemize++;
    else if (name === "enumerate") depth.enumerate++;
    else if (/^(?:description|quote|quotation|verse|list|trivlist|center|flushleft|flushright)$/.test(name)) depth.other++;
  }
  return depth;
}

/** Floats: a table or image pasted inside one gets no float of its own. */
const FLOAT_ENVIRONMENTS = /^(?:table|figure|wraptable|wrapfigure|sidewaystable|sidewaysfigure|margintable|marginfigure|subtable|subfigure|SCfigure|SCtable)\*?$/;
/** Boxes: neither floats nor captions fit inside them. */
const BOX_ENVIRONMENTS = /^(?:tcolorbox|minipage|mdframed|framed|shaded|snugshade|leftbar|tcb\w*|boxed\w*)\*?$/;
/** Commands whose argument is a footnote's text. */
const FOOTNOTE_COMMANDS = /^\\(?:footnote|footnotetext|tablefootnote|thanks|sidenote|marginnote)(?![A-Za-z@])/;

/** Whether `pos` is inside a float or a box (the innermost one wins), and whether it is in a footnote's text. */
export function surroundingsAt(state: EditorState, pos: number): { container: "float" | "box" | null; inFootnote: boolean } {
  let container: "float" | "box" | null = null;
  let inFootnote = false;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (pos <= node.from || pos >= node.to) continue;
    const head = state.doc.sliceString(node.from, Math.min(node.to, node.from + 80));
    if (/Environment$/.test(node.name) && !container) {
      const name = /^\\begin\s*\{([^}]*)\}/.exec(head)?.[1].trim() ?? "";
      if (FLOAT_ENVIRONMENTS.test(name)) container = "float";
      else if (BOX_ENVIRONMENTS.test(name)) container = "box";
    } else if (/Command$/.test(node.name) && FOOTNOTE_COMMANDS.test(head)) inFootnote = true;
  }
  return { container, inFootnote };
}

export type PasteContextOptions = {
  documentPath: string;
  /** The file TeX compiles (a chapter's main file): image paths are written relative to its folder. */
  rootPath?: string;
  /** The engine chosen for the build ("auto": from the preamble). */
  engine?: PasteEngine | "auto";
};

/** What the converter needs to know about the place the paste lands. */
export function latexPasteContextAt(state: EditorState, pos: number, { documentPath, rootPath = documentPath, engine = "auto" }: PasteContextOptions): LatexPasteContext {
  const text = state.doc.toString();
  const sources = state.field(macroSourcesField, false) ?? [];
  const project = state.field(latexProjectField, false);
  const preamble = readPreambleInfo([text, ...sources.map((source) => source.text)]);
  let resolved = resolveLatexEngine(text, engine);
  if (resolved === "pdflatex" && engine === "auto") {
    for (const source of sources) {
      const other = resolveLatexEngine(source.text, "auto");
      if (other !== "pdflatex") { resolved = other; break; }
    }
  }
  const labels = new Set<string>(project?.labels ?? []);
  for (const match of text.matchAll(/\\label\s*\{([^}]*)\}/g)) labels.add(match[1].trim());
  const keys = new Set<string>((project?.bibEntries ?? []).map((entry) => entry.key));
  const aliases = new Map<string, string>();
  for (const entry of project?.libraryEntries ?? []) {
    keys.add(entry.key);
    for (const alias of entry.aliases) if (alias !== entry.key) { keys.add(alias); aliases.set(alias, entry.key); }
  }
  const section = sectionBefore(text, pos);
  const folder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  // The project's file list is relative to the edited file's folder: it can check paths only when TeX runs from there.
  const sameFolder = folder(rootPath) === folder(documentPath);
  return createPasteContext({
    sectionLevel: section?.level ?? null,
    sectionCommand: section?.command ?? null,
    sectionTitle: section?.title ?? null,
    documentClass: preamble.documentClass,
    classOptions: preamble.classOptions,
    engine: resolved,
    packages: preamble.packages,
    labels,
    bibKeys: keys.size ? keys : null,
    bibAliases: aliases,
    definedCommands: preamble.commands,
    definedEnvironments: preamble.environments,
    listDepth: listDepthAt(state, pos),
    files: sameFolder && project?.files.length ? new Set(project.files.map((file) => file.path)) : null,
    documentDir: folder(rootPath),
    inlineOnly: pasteIsInlineOnly(state, pos),
    ...surroundingsAt(state, pos),
  });
}

/* ---- Inserting the result --------------------------------------------------- */

export type LatexInsertion = {
  latex: string;
  /** The output has paragraphs, lists or environments (not just inline text). */
  block: boolean;
  /** `\usepackage` lines to add to the preamble (only when the user ticked the box). */
  packages?: string[];
};

/**
 * Where a paste sits in the undo history right after it went in: while it is
 * still the latest step there, "Paste as plain text instead" undoes it rather
 * than adding a step of its own.
 */
type PasteHistoryMark = { kind: "local"; depth: number } | { kind: "shared"; item: unknown };

/** What was inserted, and where: what the notice's "Paste as plain text instead" may replace, as long as it is still there. */
export type InsertedLatex = {
  from: number;
  to: number;
  text: string;
  /** The text the paste replaced (the selection it was pasted over). */
  replaced?: string;
  history?: PasteHistoryMark | null;
};

type SharedUndoManager = { undo(): unknown; undoStack: unknown[] };

/** The shared tab's undo manager (a Y.UndoManager), or null on a tab with CodeMirror's own history. */
function sharedUndoManager(view: EditorView): SharedUndoManager | null {
  const sync = view.state.facet(ySyncFacet) as unknown as { undoManager?: SharedUndoManager } | undefined;
  return sync?.undoManager ?? null;
}

function historyMark(view: EditorView): PasteHistoryMark | null {
  const shared = sharedUndoManager(view);
  if (shared) return shared.undoStack.length ? { kind: "shared", item: shared.undoStack[shared.undoStack.length - 1] } : null;
  return view.state.field(historyField, false) ? { kind: "local", depth: undoDepth(view.state) } : null;
}

/** Undo the paste `mark` was taken after, if it is still the latest step in the undo history. */
function undoPasteStep(view: EditorView, mark: PasteHistoryMark) {
  if (mark.kind === "shared") {
    const shared = sharedUndoManager(view);
    if (!shared || !mark.item || shared.undoStack[shared.undoStack.length - 1] !== mark.item) return false;
    shared.undo();
    return true;
  }
  if (sharedUndoManager(view) || !view.state.field(historyField, false) || !mark.depth || undoDepth(view.state) !== mark.depth) return false;
  return undo(view);
}

/**
 * A paste's text, replacing `from`–`to` as one undo step of its own. Local
 * tabs take it in one transaction, however large; shared tabs take a large
 * paste in pieces (one bounded update each), which land within the undo
 * manager's capture window and so undo together. `preamble` (the
 * `\usepackage` lines) goes in with it, in the same step.
 */
function dispatchPaste(view: EditorView, from: number, to: number, text: string, { preamble = null, cursor = text.length }: { preamble?: { from: number; insert: string } | null; cursor?: number } = {}) {
  const shift = preamble ? preamble.insert.length : 0;
  stopCapturing(view);
  if (sharedUndoManager(view) && utf8Length(text) > LARGE_PASTE_BYTES) {
    if (preamble) view.dispatch({ changes: preamble, userEvent: "input.paste" });
    view.dispatch({ selection: EditorSelection.range(from + shift, to + shift) });
    insertLargeText(view, text, { userEvent: "input.paste" });
  } else {
    view.dispatch({
      changes: [...(preamble ? [preamble] : []), { from, to, insert: text }],
      selection: EditorSelection.cursor(from + shift + cursor),
      userEvent: "input.paste",
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
    });
  }
  stopCapturing(view);
  return from + shift;
}

/** The end of the group opened at `index` (`{` or `[`), skipping escapes and comments, or -1. */
function closeGroup(text: string, index: number) {
  const open = text[index];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let at = index; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") { at++; continue; }
    if (char === "%") { const end = text.indexOf("\n", at); if (end < 0) return -1; at = end; continue; }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * Where `\usepackage` lines go: at the end of the line where the last
 * `\usepackage` before `\begin{document}` ends (its arguments may span lines),
 * else after `\documentclass`, else right before `\begin{document}`.
 * Commented-out commands do not count.
 */
export function preambleInsertPoint(state: EditorState): number | null {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 400_000));
  const begin = documentBegin(head);
  if (!begin) return null;
  const preamble = head.slice(0, begin.index);
  const commandEnd = (pattern: RegExp) => {
    let at = -1;
    for (const match of preamble.matchAll(pattern)) {
      const lineStart = preamble.lastIndexOf("\n", match.index) + 1;
      const prefix = preamble.slice(lineStart, match.index);
      if (stripLatexComments(prefix) !== prefix) continue;
      let end = match.index + match[0].length;
      for (;;) {
        while (/[ \t\n]/.test(preamble[end] ?? "")) end++;
        if (preamble[end] !== "[" && preamble[end] !== "{") break;
        const close = closeGroup(preamble, end);
        if (close < 0) break;
        end = close;
        if (preamble[close - 1] === "}") break;
      }
      const lineEnd = preamble.indexOf("\n", end);
      at = lineEnd < 0 ? preamble.length : lineEnd;
    }
    return at;
  };
  const packages = commandEnd(/\\(?:usepackage|RequirePackage)(?![A-Za-z@])/g);
  if (packages >= 0) return packages;
  const documentClass = commandEnd(/\\documentclass(?![A-Za-z@])/g);
  return documentClass >= 0 ? documentClass : begin.index;
}

/**
 * Insert converted LaTeX at a tracked range, as one undo step of its own.
 * Block output pasted inside a line gets the blank lines that keep the text
 * around it in its own paragraphs; lines after the first take the line's
 * indentation, except inside verbatim blocks. Returns what was inserted, or
 * null when nothing was (the editor is gone, read-only, or suggest mode took
 * the change as a suggestion instead).
 */
export function insertLatexAt(range: TrackedRange, insertion: LatexInsertion): InsertedLatex | null {
  const { view } = range;
  const target = range.current();
  range.release();
  if (!target || view.state.readOnly || !isViewAlive(view)) return null;
  const { from, to } = target;
  const state = view.state;
  const lineStart = state.doc.lineAt(from);
  const lineEnd = state.doc.lineAt(to);
  const before = state.doc.sliceString(lineStart.from, from);
  const after = state.doc.sliceString(to, lineEnd.to);
  const indent = /^[ \t]*/.exec(lineStart.text)![0];
  let body = insertion.latex;
  if (indent && /^[ \t]*$/.test(before)) body = indentLines(body, indent, true);
  const lead = insertion.block && before.trim() ? `\n\n${indent}` : "";
  const trail = insertion.block && after.trim() ? `\n\n${indent}` : "";
  const text = lead + body + trail;
  const packages = insertion.packages?.filter(Boolean) ?? [];
  const at = packages.length ? preambleInsertPoint(state) : null;
  const preambleChange = at !== null && at <= from ? { from: at, insert: `\n${packages.join("\n")}` } : null;
  const replaced = state.sliceDoc(from, to);
  const start = dispatchPaste(view, from, to, text, { preamble: preambleChange, cursor: text.length - trail.length });
  const inserted = { from: start, to: start + text.length, text };
  // Suggest mode turns the change into a suggestion and leaves the document as it was: nothing to track.
  if (inserted.to > view.state.doc.length || view.state.sliceDoc(inserted.from, inserted.to) !== text) return null;
  // A paste that went in pieces may not be one step to undo: the notice replaces it instead.
  const pieces = !!sharedUndoManager(view) && utf8Length(text) > LARGE_PASTE_BYTES;
  return { ...inserted, replaced, history: preambleChange || pieces ? null : historyMark(view) };
}

/** The text as it is (Paste as plain text, or Markdown that turned out to have nothing to convert), as one undo step. */
export function insertPlainAt(range: TrackedRange, text: string) {
  const { view } = range;
  const target = range.current();
  range.release();
  if (!target || view.state.readOnly || !isViewAlive(view)) return;
  dispatchPaste(view, target.from, target.to, text);
}

/**
 * Put back the Markdown as written in place of LaTeX inserted earlier: only
 * when the inserted text is still there unchanged (no edit, collaborator's or
 * own, and no undo since). Returns false otherwise, touching nothing.
 */
export function replaceInsertedLatex(range: TrackedRange, inserted: string, markdown: string) {
  const { view } = range;
  const target = range.current();
  range.release();
  if (!target || view.state.readOnly || !isViewAlive(view)) return false;
  if (view.state.sliceDoc(target.from, target.to) !== inserted) return false;
  stopCapturing(view);
  view.dispatch({
    changes: { from: target.from, to: target.to, insert: markdown },
    selection: EditorSelection.cursor(target.from + markdown.length),
    userEvent: "input.paste",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
  stopCapturing(view);
  return true;
}

/**
 * The notice's "Paste as plain text instead": the Markdown as written in
 * place of LaTeX pasted earlier, only while that LaTeX is still there
 * unchanged. While the paste is still the latest step in the undo history
 * (local or shared) it is undone first, so one Undo afterwards goes back to
 * before the paste; otherwise the Markdown replaces it as a step of its own.
 */
export function revertPasteToPlain(range: TrackedRange, inserted: InsertedLatex, markdown: string) {
  const { view } = range;
  const target = range.current();
  if (!target || view.state.readOnly || !isViewAlive(view) || view.state.sliceDoc(target.from, target.to) !== inserted.text) {
    range.release();
    return false;
  }
  if (inserted.history) {
    // Where the paste started, kept before the text the undo puts back (the selection the paste replaced).
    const anchor = trackRange(view, target.from, target.from, { before: true });
    const undone = undoPasteStep(view, inserted.history);
    const at = anchor.current();
    anchor.release();
    if (undone) {
      range.release();
      if (!at) return false;
      const replaced = inserted.replaced ?? "";
      const to = replaced && view.state.sliceDoc(at.from, at.from + replaced.length) === replaced ? at.from + replaced.length : at.from;
      dispatchPaste(view, at.from, to, markdown);
      return true;
    }
  }
  return replaceInsertedLatex(range, inserted.text, markdown);
}

/* ---- The extension ---------------------------------------------------------- */

export type MarkdownPasteConfig = {
  /** Called with the Markdown to convert; the editor component shows the dialog or converts straight away. */
  onRequest: (request: MarkdownPasteRequest) => void;
  /** False turns detection off (the "Do not convert Markdown" setting); the commands still work. */
  detect: () => boolean;
  /** Whether the Visual mode is on, where rich text (Word, Google Docs) is converted too. */
  visual: (state: EditorState) => boolean;
  /** The user's math markers (Preferences → Markdown), so formulas written with them are recognised. */
  mathMarkers?: () => MathMarkerSettings | undefined;
};

/** HTML whose text is all code (a `<pre>` or `<code>` copied from a web page): source to paste as it is. */
export function isCodeOnlyHtml(html: string) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const text = (body?.textContent ?? "").replace(/\s+/g, "");
  if (!body || !text) return false;
  const code = Array.from(body.querySelectorAll("pre, code")).filter((element) => !element.parentElement?.closest("pre, code"));
  return code.map((element) => element.textContent ?? "").join("").replace(/\s+/g, "") === text;
}

/**
 * What a paste of `text` (and clipboard `html`) at the selection becomes:
 * converted Markdown, converted rich text, or (null) the text as it is.
 * Rich text (Word, Google Docs, web pages) converts in the Visual mode as it
 * always has; in Source mode only while Markdown conversion is on, and only
 * when its text carries no LaTeX and it is not just code, so LaTeX copied
 * from a web page still pastes as written.
 */
export function classifyPaste(state: EditorState, { text, html = "" }: { text: string; html?: string }, config: MarkdownPasteConfig): "markdown" | "html" | null {
  const visual = config.visual(state);
  const detect = config.detect();
  const mathMarkers = config.mathMarkers?.();
  const rich = !!html && isRichClipboardHtml(html)
    && (visual || (detect && scoreMarkdown(text, mathMarkers).latex === 0 && !isCodeOnlyHtml(html)));
  // Formatted HTML wins over list-like plain text wherever it can be converted.
  if (detect && !!text.trim() && looksLikeMarkdown(text, { richHtml: rich, mathMarkers })) return "markdown";
  return rich ? "html" : null;
}

/**
 * Detects Markdown in pastes and hands it to `onRequest`. Mod-Shift-V pastes
 * the text as it is: Chrome fires an ordinary paste event for it, so a
 * keydown flag marks the next paste as plain.
 */
export function latexMarkdownPaste(config: () => MarkdownPasteConfig | null): Extension {
  let plainNext = false;
  return [
    trackedRanges,
    destroyWatcher,
    Prec.highest(EditorView.domEventHandlers({
      keydown(event) {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
          plainNext = true;
          // Cleared if no paste follows (the shortcut was used for something else).
          setTimeout(() => { plainNext = false; }, 500);
        }
        return false;
      },
      paste(event, view) {
        const plain = plainNext;
        plainNext = false;
        const { from, to } = view.state.selection.main;
        // A plain paste, one into math, verbatim, a comment or the preamble, or one at several cursors
        // (CodeMirror's own paste spreads it over them): no conversion here or in the Visual mode's HTML paste.
        if (plain || view.state.selection.ranges.length > 1 || pasteStaysLiteral(view.state, from)) { plainPasteEvents.add(event); return false; }
        const current = config();
        if (!current || view.state.readOnly) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        const kind = classifyPaste(view.state, { text, html }, current);
        if (!kind) return false;
        event.preventDefault();
        current.onRequest({ text, html: kind === "html" ? html : undefined, range: trackRange(view, from, to), origin: "paste", expected: view.state.sliceDoc(from, to) });
        return true;
      },
    })),
  ];
}

/** Paste Markdown as LaTeX (Mod-Alt-V, the context menu): the dialog, whatever the clipboard holds. */
export async function pasteMarkdownCommand(view: EditorView, onRequest: (request: MarkdownPasteRequest) => void) {
  if (view.state.readOnly) return false;
  const text = await navigator.clipboard.readText();
  if (!text.trim() || !isViewAlive(view)) return false;
  const { from, to } = view.state.selection.main;
  onRequest({ text, range: trackRange(view, from, to), origin: "command", expected: view.state.sliceDoc(from, to) });
  return true;
}

/** Convert Markdown to LaTeX: the selected text, converted in place. */
export function convertSelectionCommand(view: EditorView, onRequest: (request: MarkdownPasteRequest) => void) {
  const { from, to } = view.state.selection.main;
  if (view.state.readOnly || from === to) return false;
  const text = view.state.sliceDoc(from, to);
  onRequest({ text, range: trackRange(view, from, to), origin: "selection", expected: text });
  return true;
}

/** The clipboard's HTML, where the browser lets a page read it (null otherwise). */
async function readClipboardHtml(): Promise<string | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/html")) return await (await item.getType("text/html")).text();
    }
  } catch { /* text only */ }
  return null;
}

/**
 * The context menu's Paste: the clipboard's text, converted as a paste event
 * would convert it (Markdown, or rich text where that converts), otherwise
 * pasted as it is. Throws when the clipboard cannot be read.
 */
export async function pasteFromClipboard(view: EditorView, config: MarkdownPasteConfig | null) {
  if (view.state.readOnly) return;
  const text = await navigator.clipboard.readText();
  const html = config ? await readClipboardHtml() : null;
  if (!isViewAlive(view) || view.state.readOnly || (!text && !html)) return;
  const { from, to } = view.state.selection.main;
  const kind = !config || view.state.selection.ranges.length > 1 || pasteStaysLiteral(view.state, from) ? null : classifyPaste(view.state, { text, html: html ?? "" }, config);
  if (kind) {
    config!.onRequest({ text, html: kind === "html" ? html! : undefined, range: trackRange(view, from, to), origin: "paste", expected: view.state.sliceDoc(from, to) });
    return;
  }
  if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
}

export function markdownPasteKeymap(onRequest: () => ((request: MarkdownPasteRequest) => void) | null, onError: (message: string) => void): Extension {
  return keymap.of([{
    key: "Mod-Alt-v",
    run: (view) => {
      const handler = onRequest();
      if (!handler) return false;
      pasteMarkdownCommand(view, handler).catch(() => onError("The clipboard is not available here. Use Ctrl+V or ⌘V instead."));
      return true;
    },
  }]);
}
