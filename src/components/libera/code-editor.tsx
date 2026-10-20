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
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy, Scissors, Volume2 } from "lucide-react";
import { speakMarkdown } from "@/lib/tts/player";
import { codeHighlightStyle, codeLanguageName, findCodeLanguage, loadCodeLanguage } from "@/lib/code-languages";
import { useCanvasViewStateCapture } from "@/components/libera/canvas-view-state";
import type { TextTabViewState } from "@/components/libera/types";
import { registerEditorSelectionReader } from "@/components/libera/editor-selection-registry";
import type { SharedCodeMirrorSource } from "@/lib/collab/bindings/react-codemirror";

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
  /**
   * Shared tab: the document is the shared Y.Text, edited through the
   * binding. `value` and `onChange` are unused and no draft is registered.
   * Fixed for the editor's lifetime; key the editor on its generation.
   */
  collab?: SharedCodeMirrorSource;
};

const DRAFT_DELAY_MS = 250;
const VIEW_STATE_DELAY_MS = 300;

/** A CodeMirror editor for plain-text and code files, highlighted by file name. */
export function CodeEditor({
  fileName, value, fontFamily, fontSizePx, lineHeight, initialViewState, saving,
  onChange, onRegisterDraft, onViewStateChange, onSave, collab,
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
  const initialRef = useRef({ value, initialViewState, fileName, collab });
  const shared = !!collab;
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 });
  const [menu, setMenu] = useState<CodeEditorMenuState | null>(null);

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
    if (!shared) publishDraft();
    if (viewRef.current) reportViewState(viewRef.current);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { initialViewState: restore, fileName: name } = initialRef.current;
    // Created with the view so the two live and die together (Strict Mode, tab switches).
    const binding = initialRef.current.collab?.create() ?? null;
    const initialValue = binding ? binding.initialText : initialRef.current.value;
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
        // Shared tabs undo through the binding's Y.UndoManager.
        ...(binding ? [binding.extension] : [history()]),
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
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...(binding ? [] : historyKeymap), ...foldKeymap, ...completionKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": `${name} source editor`, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((update) => {
          if (!binding && update.docChanged && !update.transactions.some((transaction) => transaction.annotation(Transaction.remote))) {
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
          contextmenu: (event, target) => {
            event.preventDefault();
            const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
            let { from, to } = target.state.selection.main;
            if (pos !== null && (pos < from || pos > to)) {
              from = to = pos;
              target.dispatch({ selection: { anchor: pos } });
            }
            setMenu({ view: target, from, to, x: event.clientX, y: event.clientY });
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

    const created = new EditorView({ state, parent: host });
    binding?.attach(created);
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
      if (!binding) publishDraft();
      binding?.destroy();
      created.destroy();
      viewRef.current = null;
    };
  }, [publishDraft, reportViewState]);

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

  useEffect(() => () => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
  }, []);

  // A one-shot request (Global Search) to show and select lines.
  const reveal = initialViewState?.reveal;
  useEffect(() => {
    if (!reveal) return;
    // After the scroll restore, which runs in an animation frame.
    const frame = requestAnimationFrame(() => {
      const current = viewRef.current;
      if (current) {
        const { doc } = current.state;
        const first = doc.line(Math.max(1, Math.min(reveal.line, doc.lines)));
        const last = doc.line(Math.max(first.number, Math.min(reveal.endLine ?? reveal.line, doc.lines)));
        current.dispatch({
          selection: { anchor: first.from, head: last.to },
          effects: EditorView.scrollIntoView(first.from, { y: "center" }),
        });
        current.focus();
      }
      callbacks.current.onViewStateChange({ reveal: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);

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
      {menu ? <CodeEditorMenu view={menu.view} menu={menu} onClose={() => setMenu(null)} /> : null}
      <div className="libera-code-editor-status flex shrink-0 items-center gap-4 border-t border-border bg-card px-3 py-1 text-xs text-muted-foreground">
        <span>{codeLanguageName(fileName)}</span>
        <span className="ml-auto tabular-nums">
          {`Ln ${cursor.line}, Col ${cursor.column}`}{cursor.selected ? ` (${cursor.selected} selected)` : ""}
        </span>
      </div>
    </div>
  );
}

type CodeEditorMenuState = { view: EditorView; from: number; to: number; x: number; y: number };
const MENU_WIDTH = 224;
const menuItemClass = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

/** The code editor's right-click menu: Read Out Loud and the clipboard, as the LaTeX editor's menu has them. */
function CodeEditorMenu({ view, menu, onClose }: { view: EditorView; menu: CodeEditorMenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const hasText = !!view.state.sliceDoc(menu.from, menu.to).trim();

  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); view.focus(); }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, view]);

  async function clipboard(action: "cut" | "copy" | "paste") {
    onClose();
    view.focus();
    const { from, to } = view.state.selection.main;
    try {
      if (action === "paste") {
        const text = await navigator.clipboard.readText();
        view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
        return;
      }
      await navigator.clipboard.writeText(view.state.sliceDoc(from, to));
      if (action === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
    } catch {
      // The clipboard can be unavailable here; the keyboard shortcuts still work.
    }
  }

  return createPortal(
    <div ref={menuRef} role="menu" aria-label="Editor actions"
      className="fixed z-50 rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
      onContextMenu={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" className={menuItemClass} disabled={!hasText}
        onClick={() => { onClose(); speakMarkdown(view.state.sliceDoc(menu.from, menu.to), { label: "Selection", format: "plain" }); }}>
        <Volume2 aria-hidden className="h-4 w-4" />Read Out Loud
      </button>
      <div className="my-1 border-t border-border" />
      <button type="button" role="menuitem" className={menuItemClass} disabled={!hasText} onClick={() => void clipboard("cut")}><Scissors aria-hidden className="h-4 w-4" />Cut</button>
      <button type="button" role="menuitem" className={menuItemClass} disabled={!hasText} onClick={() => void clipboard("copy")}><Copy aria-hidden className="h-4 w-4" />Copy</button>
      <button type="button" role="menuitem" className={menuItemClass} onClick={() => void clipboard("paste")}><ClipboardPaste aria-hidden className="h-4 w-4" />Paste</button>
    </div>,
    document.body,
  );
}
