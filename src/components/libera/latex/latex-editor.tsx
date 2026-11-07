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
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import type { LatexDiagnostic } from "@/lib/latex/build";
import { locateTextHint, type SynctexTextHint } from "@/lib/latex/synctex-text";
import { latexCompletionSource, latexFormattingKeymap, latexInputHandler, latexProjectField, setLatexProject, syncEnvironmentNames, type LatexProjectData } from "@/lib/latex/codemirror/editing";
import { latexLanguageSupport } from "@/lib/latex/codemirror/latex-language";
import { latexMathPreview } from "@/lib/latex/codemirror/preview";
import {
  latexVisualMode, latexVisualState, rebuildVisualEffect, setAuxData, setMacroSources, setNumberingIncludes, setNumberingStart, visualCompartment, visualEntrySelection,
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
};

export type LatexEditorMode = "source" | "visual";

const DRAFT_DELAY_MS = 250;
const lineNumbersCompartment = new Compartment();

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
  documentPath, fileName, value, fontFamily, fontSizePx, lineHeight, initialViewState, diagnostics, project, editorRef,
  onChange, onEdit, onRegisterDraft, onViewStateChange, onCompile, onForwardSync, onAiError, onAddSnippet, collab,
  editorMode = "source", macroSources, auxData, numberingStart, numberingIncludes, rootPath,
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
  const [hunks, setHunks] = useState<ReviewHunk[]>([]);
  const [view, setView] = useState<EditorView | null>(null);
  const initialRef = useRef({ value, initialViewState, fileName, collab, documentPath, editorMode, compileRoot });
  /** The paths the installed Visual mode resolves against, to reconfigure it when the tab is renamed or moved. */
  const visualPathsRef = useRef<string | null>(null);
  const shared = !!collab;

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
        syncEnvironmentNames,
        latexProjectField,
        latexReviewExtension(),
        // The agent's changes under manual review; shared tabs get suggestions instead.
        ...(binding ? [] : [agentReviewCodeMirror(initialRef.current.documentPath, { outside: (transaction) => transaction.annotation(Transaction.remote) === true })]),
        latexSyncExtension(),
        ...(isTex ? [latexMathPreview(), latexVisualState()] : []),
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
      className={`libera-latex-editor relative min-h-0 min-w-0 overflow-hidden bg-card${visualActive ? " libera-latex-visual" : ""}`}
      data-libera-code-editor
      ref={wrapperRef}
      style={{ "--latex-editor-font": fontFamily, "--latex-editor-font-size": `${fontSizePx}px`, "--latex-editor-line-height": String(lineHeight) } as CSSProperties}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {view && menu ? (
        <LatexAiMenu
          view={view}
          menu={menu}
          documentPath={documentPath}
          onClose={() => setMenu(null)}
          onError={onAiError}
          onForwardSync={(pos) => onForwardSync(compiledLocationForPosition(view.state, pos))}
          onAddSnippet={({ from, to }) => onAddSnippet(snippetBodyFromSelection(view.state.sliceDoc(from, to), /^[ \t]*/.exec(view.state.doc.lineAt(from).text)![0]))}
        />
      ) : null}
      {view && hunks.length ? <LatexChangeBar view={view} hunks={hunks} /> : null}
    </div>
  );
}
