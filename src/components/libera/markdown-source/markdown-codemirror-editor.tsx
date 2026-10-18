"use client";

import { isolateHistory } from "@codemirror/commands";
import { Compartment, EditorState, Prec, type ChangeSet } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties,
} from "react";
import { beginAiActivity } from "@/lib/ai-activity";
import {
  changeHeadingLevels, fileLinkDestinationAt, markdownFormatCommand, sourcePasteEdit, textareaEditSpec,
} from "@/lib/markdown-codemirror/commands";
import { setFindMatches } from "@/lib/markdown-codemirror/find";
import { liberaMathMarkers } from "@/lib/markdown-codemirror/libera-syntax";
import { markdownSourceSetup } from "@/lib/markdown-codemirror/setup";
import type { CodeMirrorTextareaAdapter } from "@/lib/markdown-codemirror/textarea-adapter";
import {
  markdownValueSync, minimalTextChange, rebaseTextChange, replacesWholeDocument,
} from "@/lib/markdown-codemirror/value-sync";
import { findTextMatches, replaceTextMatches, type TextMatch } from "@/lib/text-find";
import type { MarkdownFileLinkSelection } from "@/components/libera/types";
import { useCanvasViewStateCapture } from "../canvas-view-state";
import { registerEditorSelectionReader } from "../editor-selection-registry";
import {
  MARKDOWN_SHORTCUT_FORMATS, changeSelectedHeadingLevels, findMarkdownImageInText, getClipboardImageFiles,
  getDroppedImageFiles, hasImageDragItem, SOURCE_DRAFT_DELAY_MS,
} from "../markdown-editor";
import { MarkdownFileLinkPopup, buildMarkdownFileLinkSections, flattenMarkdownFileLinkSections } from "../markdown-file-link-popup";
import { useCodeMirrorReview } from "../use-editor-review";
import { MarkdownSourceContextMenu, sourceContextMenuPosition, type SourceContextMenuState } from "./markdown-source-context-menu";
import { MarkdownSourceFindBar } from "./markdown-source-find-bar";
import type { MarkdownSourceEditorProps } from "./types";

/* The Markdown Source editor on CodeMirror 6 (decision D8). It keeps the
 * textarea editor's props, keyboard shortcuts, menus and draft flow, and
 * stands behind the workspace's textarea ref through `adapter`, so the shared
 * toolbar, outline, slides, snipping and scroll sync drive it unchanged. */

const SELECTION_CHANGE_DEBOUNCE_MS = 120;
const PUBLISHED_DRAFT_MEMORY = 20;
const FILE_LINK_POPUP_WIDTH = 384;
const FILE_LINK_POPUP_HEIGHT = 384;

type FileLinkPopupContext = {
  destinationEnd: number;
  destinationStart: number;
  query: string;
  x: number;
  y: number;
};

type FindState = { open: boolean; query: string; replacement: string; wildcards: boolean; active: number; text: string };

/** The document position under a pointer event, or null when layout is not
 * available (a hidden pane); callers then keep the current selection. */
function positionAt(view: EditorView, event: MouseEvent) {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY });
  } catch {
    return null;
  }
}

const sameFileLinkPopup = (left: FileLinkPopupContext | null, right: FileLinkPopupContext | null) =>
  left?.destinationEnd === right?.destinationEnd && left?.destinationStart === right?.destinationStart &&
  left?.query === right?.query && left?.x === right?.x && left?.y === right?.y;

export function MarkdownCodeMirrorEditor({
  adapter,
  activeFilePath,
  files,
  formatting,
  fontFamily,
  fontSizePx,
  imageConverting,
  lineHeightPx,
  mathMarkers,
  openTabs,
  readOpenTabs,
  recentFiles,
  smartPaste = false,
  value,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onAiRewriteSelection,
  onAiWriteAt,
  onChange,
  onRegisterDraft,
  onInsertFileLink,
  onInsertImageFile,
  onSelectionChange,
  extensions,
  documentSource = "value",
  onViewChange,
}: MarkdownSourceEditorProps & { adapter: CodeMirrorTextareaAdapter }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [contextMenu, setContextMenu] = useState<SourceContextMenuState | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const [find, setFind] = useState<FindState>({ open: false, query: "", replacement: "", wildcards: false, active: 0, text: "" });
  const findRef = useRef(find);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [fileLinkPopup, setFileLinkPopup] = useState<FileLinkPopupContext | null>(null);
  const [activeFileLinkIndex, setActiveFileLinkIndex] = useState(0);
  const fileLinkPopupRef = useRef<FileLinkPopupContext | null>(null);
  const fileLinkFrameRef = useRef<number | null>(null);

  // Draft flow (same contract as the textarea editor and the LaTeX editor).
  const lastPublishedRef = useRef(value);
  const publishedDraftsRef = useRef<string[]>([]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  // Changes since `lastPublishedRef`, to rebase outside values in external mode.
  const changesSinceBaseRef = useRef<ChangeSet | null>(null);
  const pendingValueRef = useRef<string | null>(null);
  const previousFilePathRef = useRef(activeFilePath);
  const initialRef = useRef({ value, documentSource, mathMarkers, extensions });
  const extensionsCompartment = useRef(new Compartment()).current;
  const mathCompartment = useRef(new Compartment()).current;

  const latest = useRef({ onChange, onSelectionChange, onInsertImageFile, onViewChange, smartPaste, mathMarkers });
  // Keymaps are built once with the view; they call the current handlers.
  const handlersRef = useRef<{
    chooseActiveFileLink: () => boolean;
    moveFileLinkSelection: (step: number) => boolean;
    openFind: (query?: string) => void;
  }>({ chooseActiveFileLink: () => false, moveFileLinkSelection: () => false, openFind: () => {} });
  useLayoutEffect(() => {
    latest.current = { onChange, onSelectionChange, onInsertImageFile, onViewChange, smartPaste, mathMarkers };
  });
  useLayoutEffect(() => { findRef.current = find; }, [find]);

  /** Publishes the live text as the tab draft now, and returns it. This is the
   * reader registered with the workspace (`getTabDraft`). */
  const readDraft = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const current = viewRef.current;
    if (!current) return lastPublishedRef.current;
    const text = current.state.doc.toString();
    if (text !== lastPublishedRef.current) {
      lastPublishedRef.current = text;
      changesSinceBaseRef.current = null;
      publishedDraftsRef.current.push(text);
      if (publishedDraftsRef.current.length > PUBLISHED_DRAFT_MEMORY) publishedDraftsRef.current.shift();
      latest.current.onChange(text);
    }
    return text;
  }, []);

  const schedulePublish = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    // Keep workspace, outline and review renders out of the typing path; they
    // read the exact live draft through `readDraft` whenever they need it.
    draftTimerRef.current = setTimeout(function publishAfterPause() {
      if (viewRef.current?.composing) draftTimerRef.current = setTimeout(publishAfterPause, SOURCE_DRAFT_DELAY_MS);
      else startTransition(() => { readDraft(); });
    }, SOURCE_DRAFT_DELAY_MS);
  }, [readDraft]);

  const emitSelection = useCallback(() => {
    const current = viewRef.current;
    if (!current) return;
    const { from, to } = current.state.selection.main;
    startTransition(() => latest.current.onSelectionChange?.({ start: from, end: to }));
  }, []);

  const scheduleSelection = useCallback(() => {
    if (!latest.current.onSelectionChange) return;
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null;
      emitSelection();
    }, SELECTION_CHANGE_DEBOUNCE_MS);
  }, [emitSelection]);

  const flushSelection = useCallback(() => {
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = null;
    emitSelection();
  }, [emitSelection]);

  const closeFileLinkPopup = useCallback(() => {
    if (fileLinkFrameRef.current !== null) window.cancelAnimationFrame(fileLinkFrameRef.current);
    fileLinkFrameRef.current = null;
    fileLinkPopupRef.current = null;
    setFileLinkPopup(null);
  }, []);

  const refreshFileLinkPopup = useCallback(() => {
    const current = viewRef.current;
    let next: FileLinkPopupContext | null = null;
    if (current?.hasFocus && current.state.selection.main.empty) {
      const cursor = current.state.selection.main.head;
      const context = fileLinkDestinationAt(current.state.doc.toString(), cursor);
      if (context) {
        const point = adapter.clientPointForOffset(cursor);
        const width = Math.min(FILE_LINK_POPUP_WIDTH, window.innerWidth - 16);
        next = {
          ...context,
          x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
          y: Math.max(8, Math.min(point.y + 6, window.innerHeight - FILE_LINK_POPUP_HEIGHT - 8)),
        };
      }
    }
    const previous = fileLinkPopupRef.current;
    if (next?.query !== previous?.query) setActiveFileLinkIndex(0);
    if (sameFileLinkPopup(previous, next)) return;
    fileLinkPopupRef.current = next;
    setFileLinkPopup(next);
  }, [adapter]);

  const scheduleFileLinkPopupRefresh = useCallback(() => {
    if (fileLinkFrameRef.current !== null) window.cancelAnimationFrame(fileLinkFrameRef.current);
    fileLinkFrameRef.current = window.requestAnimationFrame(() => {
      fileLinkFrameRef.current = null;
      refreshFileLinkPopup();
    });
  }, [refreshFileLinkPopup]);

  /** Applies a whole text coming from outside the editor (workspace draft,
   * review result) without replacing the document. */
  const applyIncomingText = useCallback((text: string, source: "value" | "review") => {
    const current = viewRef.current;
    if (!current) return;
    if (current.composing) {
      // Never rewrite text under an active IME composition; apply when it ends.
      pendingValueRef.current = text;
      return;
    }
    pendingValueRef.current = null;
    publishedDraftsRef.current = [];
    const annotations = [markdownValueSync.of(source), ...(source === "review" ? [isolateHistory.of("full")] : [])];
    if (initialRef.current.documentSource === "external") {
      // On a shared tab the workspace writes to the Y.Text itself and the
      // binding has already brought the document level: re-applying the
      // intended change would insert it twice.
      if (text === current.state.doc.toString()) {
        readDraft();
        lastPublishedRef.current = text;
        changesSinceBaseRef.current = null;
        return;
      }
      // The injected binding owns the document: turn the new value into the
      // edit it represents against the draft the workspace last saw, and move
      // that edit onto the current document.
      const intended = minimalTextChange(lastPublishedRef.current, text);
      if (intended) {
        const change = rebaseTextChange(intended, changesSinceBaseRef.current);
        if (!replacesWholeDocument(change, current.state.doc.length)) current.dispatch({ changes: change, annotations });
      }
      // Publish the derived draft at once so the workspace converges on the
      // document rather than on its own (possibly stale) value.
      readDraft();
      return;
    }
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const change = minimalTextChange(current.state.doc.toString(), text);
    if (change) current.dispatch({ changes: change, annotations });
    lastPublishedRef.current = text;
    changesSinceBaseRef.current = null;
  }, [readDraft]);

  // Create the view once. Later prop changes reconfigure it in place.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = initialRef.current;
    const closeMenus = () => {
      setContextMenu(null);
      closeFileLinkPopup();
    };
    const formatKeys = Object.entries(MARKDOWN_SHORTCUT_FORMATS).map(([key, format]) => ({
      key: `Mod-${key}`,
      run: (target: EditorView) => {
        closeMenus();
        markdownFormatCommand(format)(target);
        readDraft();
        return true;
      },
    }));
    const headingKey = (direction: "indent" | "unindent") => (target: EditorView) => {
      if (!changeHeadingLevels(target, direction)) return false;
      closeMenus();
      readDraft();
      return true;
    };
    const popupOpen = () => fileLinkPopupRef.current !== null;

    const state = EditorState.create({
      doc: initial.value,
      extensions: [
        // The file-link picker takes the arrows, Enter and Escape while open.
        Prec.highest(keymap.of([
          { key: "Escape", run: () => { if (!popupOpen()) return false; closeFileLinkPopup(); return true; } },
          { key: "ArrowDown", run: () => handlersRef.current.moveFileLinkSelection(1) },
          { key: "ArrowUp", run: () => handlersRef.current.moveFileLinkSelection(-1) },
          { key: "Enter", run: () => handlersRef.current.chooseActiveFileLink() },
        ])),
        Prec.high(keymap.of([
          ...formatKeys,
          { key: "Tab", run: headingKey("indent") },
          { key: "Shift-Tab", run: headingKey("unindent") },
          { key: "Mod-f", run: () => { handlersRef.current.openFind(); return true; } },
        ])),
        markdownSourceSetup(),
        mathCompartment.of(liberaMathMarkers.of(initial.mathMarkers ?? {})),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            changesSinceBaseRef.current = changesSinceBaseRef.current
              ? changesSinceBaseRef.current.compose(update.changes)
              : update.changes;
            const fromOutside = update.transactions.every((tr) => !tr.docChanged || tr.annotation(markdownValueSync));
            // In value mode, text applied from the workspace is already its draft.
            if (initial.documentSource === "external" || !fromOutside) schedulePublish();
            if (findRef.current.open) {
              const text = update.state.doc.toString();
              setFind((currentFind) => ({ ...currentFind, text }));
            }
          }
          if (update.docChanged || update.selectionSet) {
            scheduleSelection();
            scheduleFileLinkPopupRefresh();
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) scheduleFileLinkPopupRefresh();
            else {
              readDraft();
              flushSelection();
            }
          }
        }),
        EditorView.domEventHandlers({
          paste: (event, target) => {
            const data = event.clipboardData;
            if (!data) return false;
            const { from, to } = target.state.selection.main;
            const images = getClipboardImageFiles(data);
            if (images.length) {
              event.preventDefault();
              closeMenus();
              void latest.current.onInsertImageFile(images[0], { start: from, end: to });
              return true;
            }
            const markdown = data.getData("text/markdown");
            const edit = sourcePasteEdit(target.state.doc.toString(), { start: from, end: to }, {
              markdown,
              html: markdown ? "" : data.getData("text/html"),
              plain: data.getData("text/plain"),
            }, { mathMarkers: latest.current.mathMarkers, smartPaste: latest.current.smartPaste });
            if (!edit) return false;
            event.preventDefault();
            closeMenus();
            target.dispatch({ ...textareaEditSpec(target.state, edit), userEvent: "input.paste", scrollIntoView: true });
            readDraft();
            return true;
          },
          dragover: (event) => {
            if (!event.dataTransfer || !hasImageDragItem(event.dataTransfer)) return false;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDraggingImage(true);
            return true;
          },
          dragleave: () => {
            setDraggingImage(false);
            return false;
          },
          drop: (event, target) => {
            setDraggingImage(false);
            const images = event.dataTransfer ? getDroppedImageFiles(event.dataTransfer) : [];
            if (!images.length) return false;
            event.preventDefault();
            const pos = positionAt(target, event) ?? target.state.selection.main.head;
            target.dispatch({ selection: { anchor: pos } });
            target.focus();
            void latest.current.onInsertImageFile(images[0], { start: pos, end: pos });
            return true;
          },
          contextmenu: (event, target) => {
            event.preventDefault();
            const pos = positionAt(target, event);
            let { from, to } = target.state.selection.main;
            if (pos !== null && (pos < from || pos > to)) {
              from = to = pos;
              target.dispatch({ selection: { anchor: pos } });
            }
            const text = target.state.doc.toString();
            const hasText = !!text.slice(from, to).trim();
            const image = findMarkdownImageInText(text, from, to);
            setContextMenu({
              ...sourceContextMenuPosition(event.clientX, event.clientY, hasText, !!image),
              start: from,
              end: to,
              hasText,
              image,
              canIndent: from !== to && changeSelectedHeadingLevels(text, from, to, "indent").changed,
              canUnindent: from !== to && changeSelectedHeadingLevels(text, from, to, "unindent").changed,
            });
            return true;
          },
          compositionend: () => {
            // CodeMirror finishes the composition after this event.
            window.setTimeout(() => {
              const pending = pendingValueRef.current;
              if (pending !== null && pending !== viewRef.current?.state.doc.toString()) applyIncomingText(pending, "value");
              pendingValueRef.current = null;
            }, 0);
            return false;
          },
        }),
        extensionsCompartment.of(initial.extensions ?? []),
      ],
    });

    const created = new EditorView({ state, parent: host });
    viewRef.current = created;
    adapter.attach(created, {
      applyEdit: (edit) => created.dispatch(textareaEditSpec(created.state, edit)),
      applyValue: (text) => applyIncomingText(text, "value"),
      scrollIntoView: (pos, block, margin) => created.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: block === "start" ? "start" : "center", yMargin: margin ?? 5 }),
      }),
    });
    setView(created);
    latest.current.onViewChange?.(created);
    const unregisterSelection = registerEditorSelectionReader(wrapperRef.current ?? host, () => {
      const { from, to } = created.state.selection.main;
      return created.state.sliceDoc(from, to);
    });

    return () => {
      unregisterSelection();
      // Layout cleanup runs while the view is attached: flush the draft and the
      // selection before the view goes, even inside the debounce intervals.
      readDraft();
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
      const { from, to } = created.state.selection.main;
      latest.current.onSelectionChange?.({ start: from, end: to });
      if (fileLinkFrameRef.current !== null) window.cancelAnimationFrame(fileLinkFrameRef.current);
      latest.current.onViewChange?.(null);
      adapter.detach();
      created.destroy();
      viewRef.current = null;
    };
    // The view is created once per mount; everything it calls is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const unregister = onRegisterDraft?.(readDraft);
    window.addEventListener("pagehide", readDraft);
    return () => { readDraft(); unregister?.(); window.removeEventListener("pagehide", readDraft); };
  }, [onRegisterDraft, readDraft]);
  useCanvasViewStateCapture(readDraft);

  useEffect(() => () => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
  }, []);

  // Adopt outside changes to the draft, ignoring echoes of drafts this editor
  // published itself (they may arrive after more typing).
  useLayoutEffect(() => {
    const current = viewRef.current;
    if (!current) return;
    const fileChanged = previousFilePathRef.current !== activeFilePath;
    previousFilePathRef.current = activeFilePath;
    const echo = publishedDraftsRef.current.indexOf(value);
    if (!fileChanged && echo >= 0) {
      publishedDraftsRef.current.splice(0, echo + 1);
      return;
    }
    if (value === current.state.doc.toString()) {
      lastPublishedRef.current = value;
      changesSinceBaseRef.current = null;
      return;
    }
    applyIncomingText(value, "value");
  }, [activeFilePath, value, applyIncomingText]);

  useEffect(() => {
    if (view) view.dispatch({ effects: extensionsCompartment.reconfigure(extensions ?? []) });
  }, [view, extensions, extensionsCompartment]);

  useEffect(() => {
    if (view) view.dispatch({ effects: mathCompartment.reconfigure(liberaMathMarkers.of(mathMarkers ?? {})) });
  }, [view, mathMarkers, mathCompartment]);

  // Review mode: comment anchors, agentic-review suggestions, the comment
  // gesture and read-only locking come from the shared CodeMirror review hook.
  const applyReviewText = useCallback((text: string) => applyIncomingText(text, "review"), [applyIncomingText]);
  useCodeMirrorReview(view, applyReviewText);

  const aiWorking = formatting || imageConverting;
  useEffect(() => (aiWorking ? beginAiActivity() : undefined), [aiWorking]);

  // Find and Replace ---------------------------------------------------------

  const matches = useMemo(
    () => (find.open ? findTextMatches(find.text, find.query, { wildcards: find.wildcards }) : []),
    [find.open, find.text, find.query, find.wildcards],
  );
  const activeMatch = matches.length ? ((find.active % matches.length) + matches.length) % matches.length : 0;

  useEffect(() => {
    if (!view) return;
    view.dispatch({ effects: setFindMatches.of({ matches: find.open ? matches : [], active: activeMatch }) });
  }, [view, find.open, matches, activeMatch]);

  function selectMatch(index: number, list: TextMatch[]) {
    if (!list.length) return;
    const normalized = ((index % list.length) + list.length) % list.length;
    const match = list[normalized];
    setFind((current) => ({ ...current, active: normalized }));
    window.requestAnimationFrame(() => {
      viewRef.current?.dispatch({
        selection: { anchor: match.start, head: match.end },
        effects: EditorView.scrollIntoView(match.start, { y: "center" }),
      });
    });
  }

  function openFind(nextQuery?: string) {
    const current = viewRef.current;
    if (!current) return;
    const text = current.state.doc.toString();
    const { from, to } = current.state.selection.main;
    const selected = text.slice(from, to);
    const query = nextQuery ?? (selected.includes("\n") ? "" : selected);
    setContextMenu(null);
    setFind((previous) => ({ ...previous, open: true, text, ...(query ? { query, active: 0 } : {}) }));
    if (query) selectMatch(0, findTextMatches(text, query, { wildcards: findRef.current.wildcards }));
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    const current = viewRef.current;
    const scrollTop = current?.scrollDOM.scrollTop ?? 0;
    const scrollLeft = current?.scrollDOM.scrollLeft ?? 0;
    setFind((previous) => ({ ...previous, open: false }));
    current?.focus();
    window.requestAnimationFrame(() => {
      if (!current) return;
      // Focusing must not move the viewport the user was reading.
      current.scrollDOM.scrollTop = scrollTop;
      current.scrollDOM.scrollLeft = scrollLeft;
    });
  }

  function updateFindQuery(query: string) {
    const list = findTextMatches(find.text, query, { wildcards: find.wildcards });
    setFind((current) => ({ ...current, query, active: 0 }));
    if (list.length) selectMatch(0, list);
  }

  function updateWildcards(wildcards: boolean) {
    const list = findTextMatches(find.text, find.query, { wildcards });
    setFind((current) => ({ ...current, wildcards, active: 0 }));
    if (list.length) selectMatch(0, list);
  }

  function replaceMatches(list: TextMatch[]) {
    const current = viewRef.current;
    if (!current || !list.length) return;
    const text = current.state.doc.toString();
    const first = list[0];
    const last = list.at(-1)!;
    const replacement = replaceTextMatches(
      text.slice(first.start, last.end),
      list.map((match) => ({ start: match.start - first.start, end: match.end - first.start })),
      find.replacement,
    );
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    current.dispatch(textareaEditSpec(current.state, {
      selectionStart: first.start,
      selectionEnd: last.end,
      replacement,
      nextSelectionStart: first.start + replacement.length,
      nextSelectionEnd: first.start + replacement.length,
    }));
    readDraft();
    const nextText = current.state.doc.toString();
    const nextList = findTextMatches(nextText, find.query, { wildcards: find.wildcards });
    const nextOffset = first.start + find.replacement.length;
    const nextIndex = list.length === 1 ? Math.max(0, nextList.findIndex((match) => match.start >= nextOffset)) : 0;
    setFind((previous) => ({ ...previous, text: nextText, active: nextIndex }));
    if (nextList.length) selectMatch(nextIndex, nextList);
    window.requestAnimationFrame(() => focused?.focus());
  }

  // File-link picker -----------------------------------------------------------

  const fileLinkSections = useMemo(
    () => fileLinkPopup
      ? buildMarkdownFileLinkSections({ activeFilePath, files, openTabs: readOpenTabs?.() ?? openTabs ?? [], query: fileLinkPopup.query, recentFiles })
      : [],
    [activeFilePath, fileLinkPopup, files, openTabs, readOpenTabs, recentFiles],
  );
  const fileLinkOptions = useMemo(() => flattenMarkdownFileLinkSections(fileLinkSections), [fileLinkSections]);
  const selectedFileLinkIndex = fileLinkOptions.length ? Math.min(activeFileLinkIndex, fileLinkOptions.length - 1) : 0;
  const fileLinkKeysRef = useRef({ options: fileLinkOptions, selected: selectedFileLinkIndex });
  useLayoutEffect(() => { fileLinkKeysRef.current = { options: fileLinkOptions, selected: selectedFileLinkIndex }; });

  function moveFileLinkSelection(step: number) {
    const count = fileLinkKeysRef.current.options.length;
    if (!fileLinkPopupRef.current || !count) return false;
    setActiveFileLinkIndex((current) => (current + step + count) % count);
    return true;
  }

  function insertFileLink(selection: MarkdownFileLinkSelection) {
    const popup = fileLinkPopupRef.current;
    const range = popup ? { start: popup.destinationStart, end: popup.destinationEnd } : undefined;
    closeFileLinkPopup();
    onInsertFileLink(selection, range);
  }

  function chooseActiveFileLink() {
    const { options, selected } = fileLinkKeysRef.current;
    if (!fileLinkPopupRef.current || !options.length) return false;
    insertFileLink(options[selected]);
    return true;
  }

  useLayoutEffect(() => {
    handlersRef.current = { chooseActiveFileLink, moveFileLinkSelection, openFind };
  });

  // Context menu ---------------------------------------------------------------

  function runMenuAction(action: (menu: SourceContextMenuState) => void) {
    const menu = contextMenu;
    if (!menu) return;
    setContextMenu(null);
    action(menu);
  }

  return (
    <div
      ref={wrapperRef}
      className="libera-latex-editor libera-markdown-codemirror relative min-h-0 min-w-0 overflow-hidden border-b border-border bg-card lg:border-b-0 lg:border-r"
      data-libera-code-editor
      style={{
        "--latex-editor-font": fontFamily,
        "--latex-editor-font-size": `${fontSizePx}px`,
        "--latex-editor-line-height": `${lineHeightPx}px`,
      } as CSSProperties}
    >
      <div ref={hostRef} className="absolute inset-0" />

      {find.open ? (
        <MarkdownSourceFindBar
          activeIndex={activeMatch}
          findInputRef={findInputRef}
          matchCount={matches.length}
          query={find.query}
          replacement={find.replacement}
          wildcards={find.wildcards}
          onClose={closeFind}
          onNext={() => selectMatch(activeMatch + 1, matches)}
          onPrevious={() => selectMatch(activeMatch - 1, matches)}
          onQueryChange={updateFindQuery}
          onReplace={() => { if (matches[activeMatch]) replaceMatches([matches[activeMatch]]); }}
          onReplaceAll={() => replaceMatches(matches)}
          onReplacementChange={(replacement) => setFind((current) => ({ ...current, replacement }))}
          onWildcardsChange={updateWildcards}
        />
      ) : null}

      {draggingImage ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-input bg-white/70 text-sm font-medium text-foreground">
          Drop image to insert
        </div>
      ) : null}

      {contextMenu ? (
        <MarkdownSourceContextMenu
          key={`${contextMenu.x}:${contextMenu.y}:${contextMenu.start}:${contextMenu.end}`}
          aiWorking={aiWorking}
          formatting={formatting}
          imageConverting={imageConverting}
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onFormat={() => runMenuAction((menu) => { if (!aiWorking) void onAiFormatSelection({ start: menu.start, end: menu.end }); })}
          onHeadingLevels={(direction) => runMenuAction((menu) => {
            const current = viewRef.current;
            if (!current || !changeHeadingLevels(current, direction, { start: menu.start, end: menu.end })) return;
            closeFileLinkPopup();
            readDraft();
            current.focus();
          })}
          onRewrite={(prompt) => runMenuAction((menu) => { void onAiRewriteSelection({ start: menu.start, end: menu.end }, prompt); })}
          onWrite={(prompt) => runMenuAction((menu) => { void onAiWriteAt(menu.end, prompt); })}
          onImageToMarkdown={() => runMenuAction((menu) => { if (menu.image && !aiWorking) void onAiImageToMarkdown(menu.image); })}
        />
      ) : null}

      {fileLinkPopup ? (
        <MarkdownFileLinkPopup
          activeIndex={selectedFileLinkIndex}
          sections={fileLinkSections}
          x={fileLinkPopup.x}
          y={fileLinkPopup.y}
          onSelect={insertFileLink}
        />
      ) : null}
    </div>
  );
}
