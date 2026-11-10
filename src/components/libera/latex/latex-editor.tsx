"use client";

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { forEachDiagnostic, lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { lazy, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import {
  convertSelectionCommand, insertLatexAt, insertPlainAt, isViewAlive, latexMarkdownPaste, latexPasteContextAt, markdownPasteKeymap, pasteFromClipboard, pasteMarkdownCommand,
  pasteStaysLiteral, preambleInsertPoint, revertPasteToPlain, trackRange, type InsertedLatex, type MarkdownPasteConfig, type MarkdownPasteRequest, type TrackedRange,
} from "@/lib/latex/codemirror/markdown-paste";
import type { MarkdownPasteChoices, MarkdownPasteOptions } from "@/lib/latex/markdown-paste/options";
import type { LatexEngineSetting } from "@/lib/latex/project";
import type { MarkdownPasteDialogRequest } from "./latex-markdown-paste-dialog";
import { getMarkdownPasteOptions, loadMarkdownPasteOptions, saveMarkdownPasteOptions } from "./latex-paste-options-store";
import { LatexPasteNotice } from "./latex-paste-notice";
import type { LatexDiagnostic } from "@/lib/latex/build";
import { latexDefinitionDiagnostics } from "@/lib/latex/codemirror/visual/diagnostics";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { locateTextHint, type SynctexTextHint } from "@/lib/latex/synctex-text";
import { latexCompletionSource, latexFormattingKeymap, latexInputHandler, latexProjectField, setLatexProject, syncEnvironmentNames, type LatexProjectData } from "@/lib/latex/codemirror/editing";
import { latexLanguageSupport } from "@/lib/latex/codemirror/latex-language";
import { latexMathPreview } from "@/lib/latex/codemirror/preview";
import {
  isVisualModeOn, latexVisualMode, latexVisualState, rebuildVisualEffect, setAuxData, setMacroSources, setNumberingIncludes, setNumberingStart, visualCompartment, visualEntrySelection,
  visualRevealRanges, type MacroSource,
} from "@/lib/latex/codemirror/visual";
import { EMPTY_AUX, type LatexAuxData } from "@/lib/latex/aux-file";
import type { NumberingStart } from "@/lib/latex/macros/numbering";
import { previewSuggestions } from "@/lib/collab/suggestions/codemirror";
import { encodeFilePath } from "@/components/libera/api-client";
import { latexSnippetCompletionSource } from "@/lib/latex/codemirror/snippets";
import { snippetBodyFromSelection } from "@/lib/latex/snippets";
import { decideReviewHunks, latexReviewExtension, reviewHunksField, type ReviewHunk } from "@/lib/latex/codemirror/review";
import { readCodeMirrorScroll, restoreCodeMirrorScroll } from "@/lib/codemirror-scroll";
import { codeMirrorReflowAdapter, keepScrollOnReflow } from "@/lib/reflow-scroll-anchor";
import {
  compiledLocationForPosition, latexSyncExtension, markCompileShown, markCompileStarted, positionForCompiledLine, revealPosition,
} from "@/lib/latex/codemirror/sync";
import { useCanvasViewStateCapture } from "@/components/libera/canvas-view-state";
import type { LatexTabViewState } from "@/components/libera/types";
import { registerEditorSelectionReader } from "@/components/libera/editor-selection-registry";
import { useCodeMirrorReview } from "@/components/libera/use-editor-review";
import type { SharedCodeMirrorSource } from "@/lib/collab/bindings/react-codemirror";
import { relocateLatexCitation, type CitationSnippet } from "@/lib/references/occurrences";
import { LatexAiMenu, type LatexAiMenuState } from "./latex-ai-menu";
import { LatexChangeBar } from "./latex-change-bar";
import { agentReviewCodeMirror } from "@/lib/agent-review/codemirror";
import { getLatexSnippets } from "./latex-snippets-store";
import { CODEMIRROR_TEXT_WIDTH_CLASS, CodeMirrorTextWidth } from "../codemirror-text-width";

export type LatexEditorHandle = {
  view: EditorView;
  /** Reveal a line given in the numbering of the compiled text (SyncTeX, log). */
  revealCompiledLine: (line: number, column?: number, hint?: SynctexTextHint) => void;
  /** Reveal a line in the current text (outline), refined to the hinted word if given. */
  revealLine: (line: number, hint?: SynctexTextHint) => void;
  /** Select and reveal a range of the current text. */
  revealRange: (from: number, to: number, snippet?: CitationSnippet) => void;
  markCompileStarted: () => void;
  markCompileShown: () => void;
  text: () => string;
};

type LatexEditorProps = {
  documentPath: string;
  fileName: string;
  value: string;
  fontFamily: string;
  /** Visual mode's typeface (the visual editors' theme font); a serif book face when absent. */
  visualFontFamily?: string;
  fontSizePx: number;
  lineHeight: number;
  initialViewState?: LatexTabViewState;
  diagnostics: LatexDiagnostic[];
  project: LatexProjectData;
  editorRef: MutableRefObject<LatexEditorHandle | null>;
  onChange: (value: string) => void;
  onEdit: () => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onViewStateChange: (patch: LatexTabViewState) => void;
  onCompile: () => void;
  onForwardSync: (location: { line: number; column: number }) => void;
  onAiError: (message: string) => void;
  /** Offers the selected code, without its shared indentation, to save as a snippet. */
  onAddSnippet: (body: string) => void;
  /**
   * Shared tab: the document is the shared Y.Text. `value` is ignored, edits
   * go through the binding (with a Y.UndoManager instead of history()), and
   * `onChange` only reports the text for analysis; it is not a draft.
   * Fixed for the editor's lifetime; key the editor on its generation.
   */
  collab?: SharedCodeMirrorSource;
  /** "visual" draws the LaTeX as formatted text, formulas and widgets (`.tex` files only). */
  editorMode?: LatexEditorMode;
  /** Other files whose definitions apply here (the root's preamble, macro files). */
  macroSources?: MacroSource[];
  /** Labels and citation labels from the last compile's `.aux`. */
  auxData?: LatexAuxData | null;
  /** Counter values where this chapter is included in its main file. */
  numberingStart?: NumberingStart | null;
  /** Texts of the files this file includes in its body (by `loadKey`), whose counters advance its numbers. */
  numberingIncludes?: ReadonlyMap<string, string>;
  /** The file TeX compiles (a chapter's main file): figures resolve from its directory. */
  rootPath?: string;
  /** The user's math markers (Preferences → Markdown): pasted Markdown's formulas are read with them. */
  mathMarkers?: MathMarkerSettings;
  /** The engine chosen for the build: pasted text keeps Unicode and emoji under XeLaTeX and LuaLaTeX. */
  engine?: LatexEngineSetting;
};

export type LatexEditorMode = "source" | "visual";

const DRAFT_DELAY_MS = 250;
const lineNumbersCompartment = new Compartment();
/** The Markdown paste dialog and its converter load on the first Markdown paste. */
const LatexMarkdownPasteDialog = lazy(() => import("./latex-markdown-paste-dialog"));

/** `literal`: the target was already in math, a comment or verbatim when the request started (an explicit command may convert there). */
type PasteDialogState = MarkdownPasteDialogRequest & { id: number; request: MarkdownPasteRequest; literal: boolean };
/** A notice after a paste that skipped the dialog: what was inserted, so it is replaced only while unchanged. */
type PasteNoticeState = { id: number; range: TrackedRange; inserted: InsertedLatex; markdown: string; html?: string; missing: string[]; warnings: string[] };

/** Why a request's result was not put in: its range no longer holds the text it held when the request was made. */
function staleRequestMessage(request: MarkdownPasteRequest) {
  return request.notice
    ? "The pasted LaTeX was edited since, so it was left as it is."
    : "The text there changed while the paste was being converted, so nothing was replaced.";
}

/** What a paste into a .tex file is converted with: the paste handler's, and the context menu's Paste. */
function markdownPasteConfig(onRequest: (request: MarkdownPasteRequest) => void, mathMarkers: () => MathMarkerSettings | undefined): MarkdownPasteConfig {
  return { onRequest, detect: () => getMarkdownPasteOptions().ask !== "off", visual: isVisualModeOn, mathMarkers };
}

/**
 * When the place a request goes became math, a comment, verbatim or the
 * preamble since it started (a collaborator's edit, say): a paste goes in as
 * the text it was, as an ordinary paste there would; a conversion of text
 * already in the document is left alone. True when it was settled so.
 */
function settleLiteralTarget(request: MarkdownPasteRequest, from: number, literalAtStart: boolean, onError: (message: string) => void) {
  if (literalAtStart || !pasteStaysLiteral(request.range.view.state, from)) return false;
  if (request.origin === "selection" || request.notice) {
    request.range.release();
    onError("That place is now inside math, a comment or verbatim, so the text was left as it is.");
  } else insertPlainAt(request.range, request.text);
  return true;
}

function visualExtensions(documentPath: string, rootPath: string) {
  return latexVisualMode({
    documentPath,
    rootPath,
    fileUrl: (path) => `/api/files/raw/${encodeFilePath(path)}`,
  });
}
const VIEW_STATE_DELAY_MS = 300;

/** The part of a line TeX had read when it stopped, from its "l.12 …" context
 * line, so the error can be underlined where it happened. */
function errorRange(lineText: string, details: string | undefined) {
  const context = details?.match(/^l\.\d+ (.*)$/m)?.[1];
  if (!context || context.startsWith("...")) return null;
  const tail = context.slice(-24);
  const index = lineText.lastIndexOf(tail);
  if (index < 0 || !tail.trim()) return null;
  const end = index + tail.length;
  const command = lineText.slice(0, end).match(/\\[A-Za-z@]+\*?$|\S$/);
  return command ? { from: end - command[0].length, to: end } : null;
}

function toEditorDiagnostics(state: EditorState, diagnostics: LatexDiagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.line).map((diagnostic) => {
    const from = positionForCompiledLine(state, diagnostic.line!);
    const line = state.doc.lineAt(from);
    const range = errorRange(line.text, diagnostic.details);
    return {
      from: range ? line.from + range.from : line.from,
      to: range ? line.from + range.to : line.to,
      severity: diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "info",
      message: diagnostic.message,
      source: "LaTeX",
    };
  });
}

export function LatexEditor({
  documentPath, fileName, value, fontFamily, visualFontFamily, fontSizePx, lineHeight, initialViewState, diagnostics, project, editorRef,
  onChange, onEdit, onRegisterDraft, onViewStateChange, onCompile, onForwardSync, onAiError, onAddSnippet, collab,
  editorMode = "source", macroSources, auxData, numberingStart, numberingIncludes, rootPath, mathMarkers, engine,
}: LatexEditorProps) {
  const compileRoot = rootPath ?? documentPath;
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onEdit, onViewStateChange, onCompile, onForwardSync });
  useLayoutEffect(() => { callbacks.current = { onChange, onEdit, onViewStateChange, onCompile, onForwardSync }; });
  const publishedRef = useRef<string[]>([]);
  const lastPublishedRef = useRef(value);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRestoreRef = useRef<(() => void) | null>(null);
  const [menu, setMenu] = useState<LatexAiMenuState | null>(null);
  const [pasteDialog, setPasteDialog] = useState<PasteDialogState | null>(null);
  const [pasteNotice, setPasteNotice] = useState<PasteNoticeState | null>(null);
  const [hunks, setHunks] = useState<ReviewHunk[]>([]);
  const [view, setView] = useState<EditorView | null>(null);
  const initialRef = useRef({ value, initialViewState, fileName, collab, documentPath, editorMode, compileRoot });
  /** The paths the installed Visual mode resolves against, to reconfigure it when the tab is renamed or moved. */
  const visualPathsRef = useRef<string | null>(null);
  const shared = !!collab;
  const documentPathRef = useRef(documentPath);
  const aiErrorRef = useRef(onAiError);
  const mathMarkersRef = useRef(mathMarkers);
  useLayoutEffect(() => { documentPathRef.current = documentPath; aiErrorRef.current = onAiError; mathMarkersRef.current = mathMarkers; });

  /* ---- Markdown pasted as LaTeX (docs/latex-markdown-paste-plan.md) ---- */

  const engineRef = useRef(engine);
  const compileRootRef = useRef(rootPath ?? documentPath);
  useLayoutEffect(() => { engineRef.current = engine; compileRootRef.current = rootPath ?? documentPath; });
  const pasteContext = useCallback((state: EditorState, pos: number) => latexPasteContextAt(state, pos, {
    documentPath: documentPathRef.current, rootPath: compileRootRef.current, engine: engineRef.current ?? "auto",
  }), []);

  const pasteNoticeRef = useRef<PasteNoticeState | null>(null);
  /** Shows (or with null, hides) the notice; the range of the one it replaces is released unless `keep`. */
  const showPasteNotice = useCallback((next: PasteNoticeState | null, keep = false) => {
    if (!keep) pasteNoticeRef.current?.range.release();
    pasteNoticeRef.current = next;
    setPasteNotice(next);
  }, []);

  /** Requests run one at a time: a second paste waits until the first is inserted or its dialog closed. */
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dialogDoneRef = useRef<(() => void) | null>(null);
  const nextDialogIdRef = useRef(1);

  const runMarkdownPaste = useCallback(async (request: MarkdownPasteRequest) => {
    const { range } = request;
    const target = range.view;
    const start = range.current();
    if (!start) { range.release(); return; }
    // A paste event never starts in math, a comment or verbatim; an explicit command may (and may convert there).
    const literal = request.origin !== "paste" && pasteStaysLiteral(target.state, start.from);
    if (pasteNoticeRef.current && pasteNoticeRef.current.range !== range) showPasteNotice(null);
    try {
      const [options, converter] = await Promise.all([loadMarkdownPasteOptions(), import("@/lib/latex/markdown-paste")]);
      const at = range.current();
      // The editor was closed meanwhile: nothing is inserted anywhere.
      if (!at || !isViewAlive(target)) { range.release(); return; }
      // Rich text pasted in Source mode follows the Markdown setting; in the Visual mode it always converts, as it did before.
      const visualHtml = !!request.html && isVisualModeOn(target.state);
      // The settings loaded after the paste was caught say not to convert Markdown: it goes in as written.
      if (request.origin === "paste" && !visualHtml && options.ask === "off") { insertPlainAt(range, request.text); return; }
      // The text there changed meanwhile (a collaborator's edit inside the selection, or the LaTeX a notice offers to redo).
      if (request.expected !== undefined && target.state.sliceDoc(at.from, at.to) !== request.expected) {
        range.release();
        aiErrorRef.current(staleRequestMessage(request));
        return;
      }
      if (settleLiteralTarget(request, at.from, literal, aiErrorRef.current)) return;
      const prepared = request.html ? converter.prepareHtmlPaste(request.html) : converter.prepareMarkdownPaste(request.text, mathMarkersRef.current);
      // Nothing to convert after all: the text goes in as it was.
      if (!prepared || (request.origin === "paste" && !visualHtml && !prepared.analysis.markdown)) { insertPlainAt(range, request.text); return; }
      const context = pasteContext(target.state, at.from);
      const ask = request.origin !== "paste" || options.ask === "always" || (options.ask === "structure" && prepared.analysis.structural);
      if (ask && !context.inlineOnly) {
        const preamble = preambleInsertPoint(target.state);
        const done = new Promise<void>((resolve) => { dialogDoneRef.current = resolve; });
        setPasteDialog({ id: nextDialogIdRef.current++, request, literal, prepared, context, options, origin: request.origin, rich: !!request.html, canAddPackages: preamble !== null && preamble <= at.from });
        await done;
        return;
      }
      const result = converter.convertPreparedMarkdown(prepared, converter.resolveChoices(options, prepared.analysis, context), context);
      const inserted = insertLatexAt(range, { latex: result.latex, block: result.block });
      target.focus();
      // No notice when nothing went into the document (suggest mode made it a suggestion).
      if (inserted && inserted.to > inserted.from) {
        showPasteNotice({ id: nextDialogIdRef.current++, range: trackRange(target, inserted.from, inserted.to), inserted, markdown: request.text, html: request.html, missing: result.missing.map((pkg) => pkg.line), warnings: result.warnings.map((warning) => warning.message) });
      }
    } catch {
      // The conversion failed: a paste still goes in, as the text it was.
      if (request.origin === "paste") insertPlainAt(range, request.text);
      else range.release();
      aiErrorRef.current("The Markdown could not be converted to LaTeX.");
    }
  }, [pasteContext, showPasteNotice]);
  const handleMarkdownPaste = useCallback((request: MarkdownPasteRequest) => {
    const run = pasteQueueRef.current.then(() => runMarkdownPaste(request));
    pasteQueueRef.current = run.catch(() => undefined);
    return run;
  }, [runMarkdownPaste]);
  const pasteRequestRef = useRef(handleMarkdownPaste);
  useLayoutEffect(() => { pasteRequestRef.current = handleMarkdownPaste; });
  useEffect(() => {
    void loadMarkdownPasteOptions();
    // The converter loads while the editor is idle, so the first paste does not wait for it.
    const idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(() => { void import("@/lib/latex/markdown-paste"); }, { timeout: 5000 })
      : window.setTimeout(() => { void import("@/lib/latex/markdown-paste"); }, 2000);
    return () => { if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle); else window.clearTimeout(idle); };
  }, []);

  const pasteDialogRef = useRef<PasteDialogState | null>(null);
  useLayoutEffect(() => { pasteDialogRef.current = pasteDialog; });
  const finishPasteDialog = useCallback(async (action: { kind: "paste"; choices: MarkdownPasteChoices; options: MarkdownPasteOptions } | { kind: "plain" } | { kind: "cancel" }) => {
    const current = pasteDialogRef.current;
    pasteDialogRef.current = null;
    setPasteDialog(null);
    const done = dialogDoneRef.current;
    dialogDoneRef.current = null;
    try {
      if (!current) return;
      const { request, prepared } = current;
      const view = request.range.view;
      if (action.kind === "paste") {
        void saveMarkdownPasteOptions(action.options);
        const at = request.range.current();
        if (!at || !isViewAlive(view)) { request.range.release(); return; }
        // A collaborator edited inside the selection while the dialog was open: their edit is never overwritten.
        if (request.expected !== undefined && view.state.sliceDoc(at.from, at.to) !== request.expected) {
          request.range.release();
          aiErrorRef.current(staleRequestMessage(request));
          return;
        }
        // The place became math, a comment or verbatim while the dialog was open.
        if (settleLiteralTarget(request, at.from, current.literal, aiErrorRef.current)) return;
        // Converted again for the document as it is now: a collaborator may have added a label or a package meanwhile.
        const converter = await import("@/lib/latex/markdown-paste");
        const context = pasteContext(view.state, at.from);
        const result = converter.convertPreparedMarkdown(prepared, action.choices, context);
        const packages = action.choices.addPackages ? result.missing.map((pkg) => pkg.line) : [];
        insertLatexAt(request.range, { latex: result.latex, block: result.block, packages });
      } else if (action.kind === "plain" && request.origin !== "selection") {
        const at = request.range.current();
        if (at && (request.expected === undefined || view.state.sliceDoc(at.from, at.to) === request.expected)) insertPlainAt(request.range, request.text);
        else {
          request.range.release();
          if (at) aiErrorRef.current(staleRequestMessage(request));
        }
      } else request.range.release();
      if (isViewAlive(view)) view.focus();
    } finally {
      done?.();
    }
  }, [pasteContext]);

  /** The notice's "Paste as plain text instead": the converted LaTeX goes back to the Markdown as written, if it is still there unchanged. */
  const revertPasteNotice = useCallback(() => {
    const notice = pasteNoticeRef.current;
    showPasteNotice(null, true);
    // Undone first while the paste is the latest step, so one Undo afterwards goes back to before the paste.
    if (notice && !revertPasteToPlain(notice.range, notice.inserted, notice.markdown)) {
      aiErrorRef.current("The pasted LaTeX was edited since, so it was left as it is.");
    }
  }, [showPasteNotice]);

  /** The notice's "Options…": the dialog for the same Markdown, replacing what was inserted (while it is unchanged). */
  const reopenPasteNotice = useCallback(() => {
    const notice = pasteNoticeRef.current;
    showPasteNotice(null, true);
    if (notice) void handleMarkdownPaste({ text: notice.markdown, html: notice.html, range: notice.range, origin: "command", expected: notice.inserted.text, notice: true });
  }, [handleMarkdownPaste, showPasteNotice]);

  // Closing the editor releases what the dialog and the notice hold, and lets queued pastes finish (they insert nothing).
  useEffect(() => () => {
    pasteNoticeRef.current?.range.release();
    pasteDialogRef.current?.request.range.release();
    dialogDoneRef.current?.();
  }, []);

  const publishDraft = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const current = viewRef.current;
    if (!current) return lastPublishedRef.current;
    const text = current.state.doc.toString();
    if (text !== lastPublishedRef.current) {
      lastPublishedRef.current = text;
      publishedRef.current.push(text);
      if (publishedRef.current.length > 20) publishedRef.current.shift();
      callbacks.current.onChange(text);
    }
    return text;
  }, []);

  const reportViewState = useCallback((target: EditorView) => {
      const selection = target.state.selection.main;
      callbacks.current.onViewStateChange({
        selectionStart: selection.anchor,
        selectionEnd: selection.head,
        line: target.state.doc.lineAt(selection.head).number,
        ...readCodeMirrorScroll(target),
      });
  }, []);
  useCanvasViewStateCapture(() => {
    publishDraft();
    // Until the restore lands the view is at the top, not where the tab was left.
    if (viewRef.current && !cancelRestoreRef.current) reportViewState(viewRef.current);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { initialViewState: restore, fileName: name } = initialRef.current;
    const isTex = !/\.(bib|sty|cls)$/i.test(name);
    const visual = isTex && initialRef.current.editorMode === "visual";
    // Created with the view so the two live and die together (Strict Mode, tab switches).
    const binding = initialRef.current.collab?.create() ?? null;
    const initialValue = binding ? binding.initialText : initialRef.current.value;

    const appKeymap = Prec.highest(keymap.of([
      { key: "Mod-Enter", run: () => { callbacks.current.onCompile(); return true; } },
      { key: "Mod-Shift-Enter", run: (target) => decideReviewHunks(target, "all", "accept") },
      { key: "Mod-Shift-Backspace", run: (target) => decideReviewHunks(target, "all", "reject") },
      { key: "Mod-Shift-j", run: (target) => { callbacks.current.onForwardSync(compiledLocationForPosition(target.state, target.state.selection.main.head)); return true; } },
    ]));

    if (visual) visualPathsRef.current = `${initialRef.current.documentPath}\u0000${initialRef.current.compileRoot}`;
    const created0 = EditorState.create({
      doc: initialValue,
      selection: restore?.selectionStart !== undefined
        ? { anchor: Math.min(restore.selectionStart, initialValue.length), head: Math.min(restore.selectionEnd ?? restore.selectionStart, initialValue.length) }
        : undefined,
      extensions: [
        appKeymap,
        lineNumbersCompartment.of(visual ? [] : lineNumbers()),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        // Shared tabs undo through the binding's Y.UndoManager, which never
        // reverts a collaborator's edit.
        ...(binding ? [binding.extension] : [history()]),
        foldGutter({ openText: "▾", closedText: "▸" }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: isTex ? [latexCompletionSource, latexSnippetCompletionSource(getLatexSnippets)] : [], activateOnTypingDelay: 60, maxRenderedOptions: 80, icons: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        lintGutter(),
        EditorView.lineWrapping,
        latexLanguageSupport(name),
        Prec.high(latexInputHandler),
        Prec.high(keymap.of(latexFormattingKeymap)),
        // Markdown pasted into a .tex file becomes LaTeX, in both modes (latex-markdown-paste-plan.md).
        ...(isTex ? [
          latexMarkdownPaste(() => markdownPasteConfig((request) => { void pasteRequestRef.current(request); }, () => mathMarkersRef.current)),
          Prec.high(markdownPasteKeymap(() => (request) => { void pasteRequestRef.current(request); }, (message) => aiErrorRef.current(message))),
        ] : []),
        syncEnvironmentNames,
        latexProjectField,
        latexReviewExtension(),
        // The agent's changes under manual review; shared tabs get suggestions instead.
        ...(binding ? [] : [agentReviewCodeMirror(initialRef.current.documentPath, { outside: (transaction) => transaction.annotation(Transaction.remote) === true })]),
        latexSyncExtension(),
        ...(isTex ? [latexMathPreview(), latexVisualState(), latexDefinitionDiagnostics()] : []),
        // Pending suggestions and AI changes stay visible as source in the Visual mode.
        visualRevealRanges.of((target) => [...(target.field(reviewHunksField, false) ?? []), ...previewSuggestions(target)]),
        // So does LaTeX with a compile error, so its underline is not hidden with the markup.
        visualRevealRanges.of((target) => {
          const ranges: Array<{ from: number; to: number }> = [];
          forEachDiagnostic(target, (diagnostic, from, to) => { if (diagnostic.severity === "error") ranges.push({ from, to }); });
          return ranges;
        }),
        visualCompartment.of(visual ? visualExtensions(initialRef.current.documentPath, initialRef.current.compileRoot) : []),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...(binding ? [] : historyKeymap), ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": "LaTeX source editor", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && binding) {
            // Local and remote edits both change what the outline and the
            // compile target analysis see; only local ones count as editing.
            if (!update.transactions.some((transaction) => transaction.annotation(ySyncAnnotation) !== undefined)) callbacks.current.onEdit();
            if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
            draftTimerRef.current = setTimeout(() => startTransition(() => { publishDraft(); }), DRAFT_DELAY_MS);
          } else if (update.docChanged) {
            const remote = update.transactions.some((transaction) => transaction.annotation(Transaction.remote));
            if (!remote) {
              callbacks.current.onEdit();
              if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
              draftTimerRef.current = setTimeout(() => startTransition(() => { publishDraft(); }), DRAFT_DELAY_MS);
            }
          }
          if (update.startState.field(reviewHunksField) !== update.state.field(reviewHunksField)) setHunks(update.state.field(reviewHunksField));
          if (update.docChanged || update.selectionSet) {
            if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
            viewStateTimerRef.current = setTimeout(() => reportViewState(update.view), VIEW_STATE_DELAY_MS);
          }
        }),
        EditorView.domEventHandlers({
          contextmenu: (event, target) => {
            event.preventDefault();
            const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
            let { from, to } = target.state.selection.main;
            if (pos !== null && (pos < from || pos > to)) {
              from = to = pos;
              target.dispatch({ selection: { anchor: pos } });
            }
            setMenu({ from, to, x: event.clientX, y: event.clientY });
            return true;
          },
          scroll: (_event, target) => {
            if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
            viewStateTimerRef.current = setTimeout(() => reportViewState(target), VIEW_STATE_DELAY_MS);
            return false;
          },
        }),
      ],
    });
    // Opening straight into the Visual mode: the restored cursor must not sit inside the folded preamble either.
    const entry = visual ? visualEntrySelection(created0) : null;
    const state = entry ? created0.update({ selection: entry }).state : created0;

    const created = new EditorView({ state, parent: host });
    binding?.attach(created);
    viewRef.current = created;
    setView(created);
    cancelRestoreRef.current = restore ? restoreCodeMirrorScroll(created, restore, () => { cancelRestoreRef.current = null; }) : null;
    if (!cancelRestoreRef.current && restore?.selectionStart !== undefined) {
      created.dispatch({ effects: EditorView.scrollIntoView(created.state.selection.main.head, { y: "center" }) });
    }

    // Side panels and window resizes rewrap long lines; hold the reader's place
    // once the tab-switch restore above has run.
    const releaseReflow = keepScrollOnReflow(created.scrollDOM, codeMirrorReflowAdapter(created, () => cancelRestoreRef.current !== null));

    const unregisterSelection = registerEditorSelectionReader(wrapperRef.current ?? host, () => {
      const selection = created.state.selection.main;
      return created.state.sliceDoc(selection.from, selection.to);
    });

    return () => {
      unregisterSelection();
      // Layout cleanup runs while the editor is still attached. A switch must
      // flush both selection and scroll, even inside the debounce interval.
      if (cancelRestoreRef.current) cancelRestoreRef.current();
      else reportViewState(created);
      if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
      publishDraft();
      releaseReflow();
      binding?.destroy();
      created.destroy();
      viewRef.current = null;
    };
  }, [publishDraft, reportViewState]);

  // Expose imperative actions for the PDF pane, the log and the outline.
  useLayoutEffect(() => {
    if (!view) return;
    editorRef.current = {
      view,
      revealCompiledLine: (line, column = 0, hint) => {
        const pos = positionForCompiledLine(view.state, line, column);
        const word = hint ? locateTextHint(view.state.doc.toString(), view.state.doc.lineAt(pos).number, hint) : null;
        revealPosition(view, word?.from ?? pos, { selectTo: word?.to });
        view.focus();
      },
      revealLine: (line, hint) => {
        const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line)));
        const word = hint ? locateTextHint(view.state.doc.toString(), target.number, hint) : null;
        revealPosition(view, word?.from ?? target.from, { selectTo: word?.to });
        view.focus();
      },
      revealRange: (from, to, snippet) => {
        if (snippet) {
          const current = relocateLatexCitation(view.state.doc.toString(), snippet);
          if (!current) return;
          from = current.start;
          to = current.end;
        }
        const length = view.state.doc.length;
        revealPosition(view, Math.max(0, Math.min(from, length)), { selectTo: Math.max(0, Math.min(to, length)) });
        view.focus();
      },
      markCompileStarted: () => view.dispatch({ effects: markCompileStarted.of(null) }),
      markCompileShown: () => view.dispatch({ effects: markCompileShown.of(null) }),
      text: () => view.state.doc.toString(),
    };
    return () => { if (editorRef.current?.view === view) editorRef.current = null; };
  }, [editorRef, view]);

  useLayoutEffect(() => {
    // A shared tab's draft is read from the Y.Text, never from the editor.
    if (shared) return;
    const unregister = onRegisterDraft?.(publishDraft);
    window.addEventListener("pagehide", publishDraft);
    return () => { unregister?.(); window.removeEventListener("pagehide", publishDraft); };
  }, [onRegisterDraft, publishDraft, shared]);

  // Adopt outside changes to the draft (for example a reload), ignoring the
  // echoes of drafts this editor published itself.
  useLayoutEffect(() => {
    const current = viewRef.current;
    // On a shared tab remote edits arrive through the binding as minimal
    // changes; a whole-document replacement would reset every caret.
    if (!current || shared) return;
    const echo = publishedRef.current.indexOf(value);
    if (echo >= 0) {
      publishedRef.current.splice(0, echo + 1);
      return;
    }
    if (value === current.state.doc.toString()) return;
    lastPublishedRef.current = value;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value }, annotations: Transaction.remote.of(true) });
  }, [value, shared]);

  // Review comments: accepted/undone review results replace the whole text.
  // The tab draft is already updated, so this mirrors it without republishing.
  const applyReviewText = useCallback((text: string) => {
    const current = viewRef.current;
    // Shared tabs: the workspace applied the review result to the Y.Text as
    // minimal edits, and the binding already brought it here.
    if (!current || shared || text === current.state.doc.toString()) return;
    lastPublishedRef.current = text;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text }, annotations: Transaction.remote.of(true) });
  }, [shared]);
  useCodeMirrorReview(view, applyReviewText);

  useEffect(() => {
    if (view) view.dispatch(setDiagnostics(view.state, toEditorDiagnostics(view.state, diagnostics)));
  }, [diagnostics, view]);

  useEffect(() => {
    if (view) view.dispatch({ effects: setLatexProject.of(project) });
  }, [project, view]);

  // Switching modes reconfigures the view; the document and its undo history are untouched.
  const isTexFile = !/\.(bib|sty|cls)$/i.test(fileName);
  const visualActive = isTexFile && editorMode === "visual";
  useEffect(() => {
    if (!view) return;
    // Compare with what the view has, not with the last request: a recreated view starts from its own state.
    const current = visualCompartment.get(view.state);
    const active = Array.isArray(current) ? current.length > 0 : !!current;
    const paths = `${documentPath}\u0000${compileRoot}`;
    if (active === visualActive) {
      // Still in the Visual mode, but the tab was renamed or moved (or its main file changed): images resolve anew.
      if (active && visualPathsRef.current !== paths) {
        visualPathsRef.current = paths;
        view.dispatch({ effects: [visualCompartment.reconfigure(visualExtensions(documentPath, compileRoot)), rebuildVisualEffect.of(null)] });
      }
      return;
    }
    visualPathsRef.current = visualActive ? paths : null;
    const selection = visualActive ? visualEntrySelection(view.state) : null;
    view.dispatch({
      effects: [
        visualCompartment.reconfigure(visualActive ? visualExtensions(documentPath, compileRoot) : []),
        lineNumbersCompartment.reconfigure(visualActive ? [] : lineNumbers()),
      ],
      ...(selection ? { selection } : {}),
      scrollIntoView: true,
    });
  }, [compileRoot, documentPath, view, visualActive]);

  useEffect(() => {
    if (view && macroSources && isTexFile) view.dispatch({ effects: setMacroSources.of(macroSources) });
  }, [isTexFile, macroSources, view]);

  useEffect(() => {
    // No compiled data (another compile target, or none yet) clears the labels of the previous one.
    if (view && auxData !== undefined && isTexFile) view.dispatch({ effects: setAuxData.of(auxData ?? EMPTY_AUX) });
  }, [auxData, isTexFile, view]);

  useEffect(() => {
    if (view && isTexFile && numberingStart !== undefined) view.dispatch({ effects: setNumberingStart.of(numberingStart) });
  }, [isTexFile, numberingStart, view]);

  useEffect(() => {
    if (view && isTexFile && numberingIncludes) view.dispatch({ effects: setNumberingIncludes.of(numberingIncludes) });
  }, [isTexFile, numberingIncludes, view]);

  return (
    <div
      className={`libera-latex-editor ${CODEMIRROR_TEXT_WIDTH_CLASS} relative min-h-0 min-w-0 overflow-hidden bg-card${visualActive ? " libera-latex-visual" : ""}`}
      data-libera-code-editor
      ref={wrapperRef}
      style={{ "--latex-editor-font": fontFamily, "--latex-editor-font-size": `${fontSizePx}px`, "--latex-editor-line-height": String(lineHeight), ...(visualFontFamily ? { "--latex-visual-font": visualFontFamily } : {}) } as CSSProperties}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <CodeMirrorTextWidth wrapperRef={wrapperRef} enabled kind="latex" />
      {view && menu ? (
        <LatexAiMenu
          view={view}
          menu={menu}
          documentPath={documentPath}
          onClose={() => setMenu(null)}
          onError={onAiError}
          onForwardSync={(pos) => onForwardSync(compiledLocationForPosition(view.state, pos))}
          onAddSnippet={({ from, to }) => onAddSnippet(snippetBodyFromSelection(view.state.sliceDoc(from, to), /^[ \t]*/.exec(view.state.doc.lineAt(from).text)![0]))}
          onPaste={() => pasteFromClipboard(view, isTexFile ? markdownPasteConfig((request) => { void pasteRequestRef.current(request); }, () => mathMarkersRef.current) : null)}
          onPasteMarkdown={() => {
            pasteMarkdownCommand(view, (request) => { void pasteRequestRef.current(request); })
              .catch(() => onAiError("The clipboard is not available here. Use Ctrl+V or ⌘V instead."));
          }}
          onConvertMarkdown={({ from, to }) => {
            view.dispatch({ selection: { anchor: from, head: to } });
            convertSelectionCommand(view, (request) => { void pasteRequestRef.current(request); });
          }}
        />
      ) : null}
      {pasteDialog ? (
        <Suspense fallback={null}>
          <LatexMarkdownPasteDialog
            key={pasteDialog.id}
            request={pasteDialog}
            onPaste={(choices, options) => void finishPasteDialog({ kind: "paste", choices, options })}
            onPlain={() => void finishPasteDialog({ kind: "plain" })}
            onCancel={() => void finishPasteDialog({ kind: "cancel" })}
          />
        </Suspense>
      ) : null}
      {pasteNotice ? (
        <LatexPasteNotice
          key={pasteNotice.id}
          rich={!!pasteNotice.html}
          missing={pasteNotice.missing}
          warnings={pasteNotice.warnings}
          onPlain={revertPasteNotice}
          onOptions={reopenPasteNotice}
          onClose={() => showPasteNotice(null)}
        />
      ) : null}
      {view && hunks.length ? <LatexChangeBar view={view} hunks={hunks} /> : null}
    </div>
  );
}
