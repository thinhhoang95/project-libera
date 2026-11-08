import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { insertLargeText, utf8Length } from "../../collab/bindings/codemirror";
import { stopCapturing } from "../../collab/undo-boundary";
import { indentLines } from "../latex-text";
import { isRichClipboardHtml, looksLikeMarkdown } from "../markdown-paste/detect";
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
  /** The text that must still be at the range (Options… on a notice replaces the LaTeX inserted earlier only while it is unchanged). */
  expected?: string;
};

/**
 * Paste events this extension declined to convert on purpose (⇧⌘V, or the
 * cursor in math, verbatim, a comment or the preamble): the Visual mode's
 * HTML paste leaves them alone too, so they paste as plain text.
 */
export const plainPasteEvents = new WeakSet<Event>();

/* ---- Target ranges, mapped through changes ---------------------------------- */

const addRange = StateEffect.define<{ id: number; from: number; to: number }>();
const removeRange = StateEffect.define<number>();

const trackedRanges = StateField.define<ReadonlyMap<number, { from: number; to: number }>>({
  create: () => new Map(),
  update(ranges, transaction) {
    let next = ranges;
    if (transaction.docChanged && ranges.size) {
      const mapped = new Map<number, { from: number; to: number }>();
      for (const [id, range] of ranges) {
        const from = transaction.changes.mapPos(range.from, 1);
        mapped.set(id, { from, to: Math.max(from, transaction.changes.mapPos(range.to, -1)) });
      }
      next = mapped;
    }
    for (const effect of transaction.effects) {
      if (effect.is(addRange)) next = new Map(next).set(effect.value.id, { from: effect.value.from, to: effect.value.to });
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

export function trackRange(view: EditorView, from: number, to: number): TrackedRange {
  const id = nextRangeId++;
  view.dispatch({ effects: addRange.of({ id, from, to }) });
  let released = false;
  return {
    view,
    current: () => released || destroyedViews.has(view) ? null : view.state.field(trackedRanges, false)?.get(id) ?? null,
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

/** What was inserted, and where: what the notice's "Paste as plain text instead" may replace, as long as it is still there. */
export type InsertedLatex = { from: number; to: number; text: string };

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
  let { from, to } = target;
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

  stopCapturing(view);
  if (utf8Length(text) > LARGE_PASTE_BYTES) {
    // Large pastes go in pieces on shared tabs; the package lines go first, in their own transaction.
    if (preambleChange) {
      view.dispatch({ changes: preambleChange, userEvent: "input.paste" });
      from += preambleChange.insert.length;
      to += preambleChange.insert.length;
    }
    view.dispatch({ selection: EditorSelection.range(from, to) });
    insertLargeText(view, text, { userEvent: "input.paste" });
  } else {
    const shift = preambleChange ? preambleChange.insert.length : 0;
    view.dispatch({
      changes: [...(preambleChange ? [preambleChange] : []), { from, to, insert: text }],
      selection: EditorSelection.cursor(from + shift + text.length - trail.length),
      userEvent: "input.paste",
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
    });
    from += shift;
  }
  stopCapturing(view);
  const inserted = { from, to: from + text.length, text };
  // Suggest mode turns the change into a suggestion and leaves the document as it was: nothing to track.
  if (inserted.to > view.state.doc.length || view.state.sliceDoc(inserted.from, inserted.to) !== text) return null;
  return inserted;
}

/** The text as it is (Paste as plain text, or Markdown that turned out to have nothing to convert). */
export function insertPlainAt(range: TrackedRange, text: string) {
  const { view } = range;
  const target = range.current();
  range.release();
  if (!target || view.state.readOnly || !isViewAlive(view)) return;
  if (utf8Length(text) > LARGE_PASTE_BYTES) {
    view.dispatch({ selection: EditorSelection.range(target.from, target.to) });
    insertLargeText(view, text, { userEvent: "input.paste" });
    return;
  }
  view.dispatch({ changes: { from: target.from, to: target.to, insert: text }, selection: EditorSelection.cursor(target.from + text.length), userEvent: "input.paste", scrollIntoView: true });
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
        // A plain paste, or one into math, verbatim, a comment or the preamble: no conversion here or in the Visual mode's HTML paste.
        if (plain || pasteStaysLiteral(view.state, from)) { plainPasteEvents.add(event); return false; }
        const current = config();
        if (!current || view.state.readOnly) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        const visual = current.visual(view.state);
        const rich = !!html && isRichClipboardHtml(html);
        // Formatted HTML wins over list-like plain text only where it can be converted: the Visual mode.
        const markdown = current.detect() && !!text.trim() && looksLikeMarkdown(text, { richHtml: rich && visual, mathMarkers: current.mathMarkers?.() });
        const richText = !markdown && rich && visual;
        if (!markdown && !richText) return false;
        if (view.state.selection.ranges.length > 1) return false;
        event.preventDefault();
        current.onRequest({ text, html: richText ? html : undefined, range: trackRange(view, from, to), origin: "paste" });
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
  onRequest({ text, range: trackRange(view, from, to), origin: "command" });
  return true;
}

/** Convert Markdown to LaTeX: the selected text, converted in place. */
export function convertSelectionCommand(view: EditorView, onRequest: (request: MarkdownPasteRequest) => void) {
  const { from, to } = view.state.selection.main;
  if (view.state.readOnly || from === to) return false;
  onRequest({ text: view.state.sliceDoc(from, to), range: trackRange(view, from, to), origin: "selection" });
  return true;
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
