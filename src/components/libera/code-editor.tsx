"use client";

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { codeHighlightStyle, codeLanguageName, findCodeLanguage, loadCodeLanguage } from "@/lib/code-languages";
import { useCanvasViewStateCapture } from "@/components/libera/canvas-view-state";
import type { TextTabViewState } from "@/components/libera/types";
import { registerEditorSelectionReader } from "@/components/libera/editor-selection-registry";

type CodeEditorProps = {
  fileName: string;
  value: string;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  initialViewState?: TextTabViewState;
  saving: boolean;
  onChange: (value: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onViewStateChange: (patch: TextTabViewState) => void;
  onSave: () => void;
};

const DRAFT_DELAY_MS = 250;
const VIEW_STATE_DELAY_MS = 300;

/** A CodeMirror editor for plain-text and code files, highlighted by file name. */
export function CodeEditor({
  fileName, value, fontFamily, fontSizePx, lineHeight, initialViewState, saving,
  onChange, onRegisterDraft, onViewStateChange, onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onViewStateChange, onSave, saving });
  useLayoutEffect(() => { callbacks.current = { onChange, onViewStateChange, onSave, saving }; });
  const publishedRef = useRef<string[]>([]);
  const lastPublishedRef = useRef(value);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialRef = useRef({ value, initialViewState, fileName });
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 });

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
        editorScrollTop: target.scrollDOM.scrollTop,
        editorScrollLeft: target.scrollDOM.scrollLeft,
      });
  }, []);
  useCanvasViewStateCapture(() => {
    publishDraft();
    if (viewRef.current) reportViewState(viewRef.current);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { value: initialValue, initialViewState: restore, fileName: name } = initialRef.current;
    const language = new Compartment();
    // Prose-like files wrap; code keeps its lines.
    const description = findCodeLanguage(name);
    const wrap = !description || description.name === "Markdown";

    const state = EditorState.create({
      doc: initialValue,
      selection: restore?.selectionStart !== undefined
        ? { anchor: Math.min(restore.selectionStart, initialValue.length), head: Math.min(restore.selectionEnd ?? restore.selectionStart, initialValue.length) }
        : undefined,
      extensions: [
        Prec.highest(keymap.of([{
          key: "Mod-s",
          run: () => {
            if (!callbacks.current.saving) callbacks.current.onSave();
            return true;
          },
        }])),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({ openText: "▾", closedText: "▸" }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(codeHighlightStyle),
        language.of([]),
        ...(wrap ? [EditorView.lineWrapping] : []),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": `${name} source editor`, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(Transaction.remote))) {
            if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
            draftTimerRef.current = setTimeout(() => startTransition(() => { publishDraft(); }), DRAFT_DELAY_MS);
          }
          if (update.docChanged || update.selectionSet) {
            const selection = update.state.selection.main;
            const line = update.state.doc.lineAt(selection.head);
            setCursor({ line: line.number, column: selection.head - line.from + 1, selected: selection.to - selection.from });
            if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
            viewStateTimerRef.current = setTimeout(() => reportViewState(update.view), VIEW_STATE_DELAY_MS);
          }
        }),
        EditorView.domEventHandlers({
          scroll: (_event, target) => {
            if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
            viewStateTimerRef.current = setTimeout(() => reportViewState(target), VIEW_STATE_DELAY_MS);
            return false;
          },
        }),
      ],
    });

    const created = new EditorView({ state, parent: host });
    viewRef.current = created;
    const head = created.state.selection.main.head;
    const headLine = created.state.doc.lineAt(head);
    setCursor({ line: headLine.number, column: head - headLine.from + 1, selected: 0 });
    let restoreFrame: number | undefined;
    if (restore?.editorScrollTop !== undefined || restore?.editorScrollLeft !== undefined) {
      restoreFrame = requestAnimationFrame(() => {
        created.scrollDOM.scrollTop = restore.editorScrollTop ?? 0;
        created.scrollDOM.scrollLeft = restore.editorScrollLeft ?? 0;
        restoreFrame = undefined;
      });
    } else if (restore?.selectionStart !== undefined) {
      created.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
    }

    let disposed = false;
    void loadCodeLanguage(name).then((support) => {
      if (!disposed && support) created.dispatch({ effects: language.reconfigure(support) });
    });

    const unregisterSelection = registerEditorSelectionReader(wrapperRef.current ?? host, () => {
      const selection = created.state.selection.main;
      return created.state.sliceDoc(selection.from, selection.to);
    });

    return () => {
      disposed = true;
      unregisterSelection();
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
      // Layout cleanup runs while the editor is still attached. A switch must
      // flush both selection and scroll, even inside the debounce interval.
      if (restoreFrame === undefined) reportViewState(created);
      if (viewStateTimerRef.current !== null) clearTimeout(viewStateTimerRef.current);
      publishDraft();
      created.destroy();
      viewRef.current = null;
    };
  }, [publishDraft, reportViewState]);

  useLayoutEffect(() => {
    const unregister = onRegisterDraft?.(publishDraft);
    window.addEventListener("pagehide", publishDraft);
    return () => { unregister?.(); window.removeEventListener("pagehide", publishDraft); };
  }, [onRegisterDraft, publishDraft]);

  // Adopt outside changes to the draft (for example a reload), ignoring the
  // echoes of drafts this editor published itself.
  useLayoutEffect(() => {
    const current = viewRef.current;
    if (!current) return;
    const echo = publishedRef.current.indexOf(value);
    if (echo >= 0) {
      publishedRef.current.splice(0, echo + 1);
      return;
    }
    if (value === current.state.doc.toString()) return;
    lastPublishedRef.current = value;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value }, annotations: Transaction.remote.of(true) });
  }, [value]);

  useEffect(() => () => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="libera-latex-editor libera-code-editor relative min-h-0 min-w-0 flex-1 overflow-hidden bg-card"
        data-libera-code-editor
        ref={wrapperRef}
        style={{ "--latex-editor-font": fontFamily, "--latex-editor-font-size": `${fontSizePx}px`, "--latex-editor-line-height": String(lineHeight) } as CSSProperties}
      >
        <div ref={hostRef} className="absolute inset-0" />
      </div>
      <div className="libera-code-editor-status flex shrink-0 items-center gap-4 border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground">
        <span>{codeLanguageName(fileName)}</span>
        <span className="ml-auto tabular-nums">
          {`Ln ${cursor.line}, Col ${cursor.column}`}{cursor.selected ? ` (${cursor.selected} selected)` : ""}
        </span>
      </div>
    </div>
  );
}
