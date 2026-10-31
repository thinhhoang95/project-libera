"use client";

import { isolateHistory } from "@codemirror/commands";
import { Compartment, EditorState, Prec, type ChangeSet, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  textareaEditSpec,
} from "@/lib/markdown-codemirror/commands";
import { setFindMatches } from "@/lib/markdown-codemirror/find";
import { citationEditorHandlers, setCitationLibrary } from "@/lib/markdown-codemirror/citations";
import { DOCUMENT_STYLE_REQUEST_EVENT, textChange, writeDocumentStyleForPath, type DocumentStyleRequestDetail } from "@/lib/references/document-style";
import { citationInsertion, narrativeInsertionAllowed } from "@/lib/references/reference-suggestions";
import type { Citation } from "@/lib/references/types";
import { liberaMathMarkers } from "@/lib/markdown-codemirror/libera-syntax";
import { markdownSourceSetup } from "@/lib/markdown-codemirror/setup";
import { normalizeSourceLineEndings, type CodeMirrorTextareaAdapter } from "@/lib/markdown-codemirror/textarea-adapter";
import {
  markdownValueSync, minimalTextChange, rebaseTextChange, replacesWholeDocument,
} from "@/lib/markdown-codemirror/value-sync";
import type { MarkdownFileLinkSelection } from "@/components/libera/types";
import { registerEditorSelectionReader } from "../editor-selection-registry";
import {
  changeSelectedHeadingLevels, getChangedTextRange, sourceClipboardContents, sourceDragKind, getDroppedImageFiles,
  SELECTION_CHANGE_DEBOUNCE_MS, handleSourceKey, fileLinkPopupKey, refreshSourcePopupOnKeyUp,
  sourceFileLinkContext, sameFileLinkPopup, sourceHeadingLinkEdit, sourceCitationContext, sameCitationPopup,
  sourcePasteEdit, sourcePasteMode, sourceFormatEdit, sourceSelectionAfterChange, type FileLinkPopupContext, type CitationPopupContext, type SourceKey, type HeadingLevelChangeDirection,
} from "@/lib/markdown-source";
import { MarkdownFileLinkPopup, MarkdownHeadingLinkPopup, buildMarkdownFileLinkSections, flattenMarkdownFileLinkSections } from "../markdown-file-link-popup";
import { useCodeMirrorReview } from "../use-editor-review";
import { MarkdownSourceContextMenu, sourceContextMenuState, type SourceContextMenuState } from "./markdown-source-context-menu";
import { MarkdownSourceFindBar } from "./markdown-source-find-bar";
import { useMarkdownSourceDraft } from "./use-markdown-source-draft";
import { useMarkdownSourceFind } from "./use-markdown-source-find";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { filterMarkdownHeadingAnchors, type MarkdownHeadingAnchor } from "@/lib/markdown-heading-anchors";
import {
  CitationPopup, openCitationAttachment, useEditorCitationHover, useSingleCitationDocument, type CitationPopupHandle,
} from "../references/citation-popup";
import { CitationCardItems } from "../references/citation-hover-card";
import { referenceKeyResolver, useReferenceRender } from "../references/reference-render-context";
import { droppedQuoteMarkdown, hasPdfQuoteDrag, pdfQuoteFromDrop } from "../references/pdf-quote-cite";
import { quoteBlockInsertion } from "@/lib/references/pdf-quote";
import type { MarkdownSourceEditorProps } from "./types";
import { speakMarkdown } from "@/lib/tts/player";
import { headingNumberingSpec, headingNumberingTransactions, isHeadingNumberingEdit } from "@/lib/markdown-codemirror/heading-numbering";
import { detectMarkdownHeadingNumbering } from "@/lib/markdown-heading-numbering";
import { codeMirrorReflowAdapter, keepScrollOnReflow } from "@/lib/reflow-scroll-anchor";
import { useHeadingNumbering } from "../heading-numbering-state";
import { readClipboardText, type MenuPasteMode } from "../paste-menu-items";

/* The Markdown Source editor on CodeMirror 6 (decision D8). It keeps the
 * textarea editor's props, keyboard shortcuts, menus and draft flow, and
 * stands behind the workspace's textarea ref through `adapter`, so the shared
 * toolbar, outline, slides, snipping and scroll sync drive it unchanged. */

type CitationTooltip = { id: number; dom: HTMLElement; citation: Citation };

/** The shared citation card's contents, inside a CodeMirror hover tooltip. */
function CitationTooltipContent({ citation }: { citation: Citation }) {
  const document = useSingleCitationDocument(citation);
  return <CitationCardItems citation={citation} document={document} />;
}

/** The document position under a pointer event, or null when layout is not
 * available (a hidden pane); callers then keep the current selection. */
function positionAt(view: EditorView, event: MouseEvent) {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY });
  } catch {
    return null;
  }
}

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
  const contextMenuOpenRef = useRef(false);
  const clearReviewSelectionRef = useRef(() => {});
  useLayoutEffect(() => { contextMenuOpenRef.current = contextMenu !== null; }, [contextMenu]);
  const [draggingImage, setDraggingImage] = useState(false);
  const [findText, setFindText] = useState(value);
  const findOpenRef = useRef(false);
  const [sourceTextareaRef] = useState(() => ({ current: adapter.asTextarea() }));
  const [fileLinkPopup, setFileLinkPopup] = useState<FileLinkPopupContext | null>(null);
  const [activeFileLinkIndex, setActiveFileLinkIndex] = useState(0);
  const fileLinkPopupRef = useRef<FileLinkPopupContext | null>(null);
  const fileLinkFrameRef = useRef<number | null>(null);
  // The `@` citation popup and citation hover tooltips (references/citation-popup.tsx).
  const [citationPopup, setCitationPopup] = useState<CitationPopupContext | null>(null);
  const citationPopupRef = useRef<CitationPopupContext | null>(null);
  /** The `@key` the popup just inserted (it must not reopen the popup), and the library's key check for cited keys. */
  const citationInsertedRef = useRef<{ from: number; query: string } | null>(null);
  const citationResolverRef = useRef<((key: string) => boolean) | null>(null);
  const citationPopupHandleRef = useRef<CitationPopupHandle>(null);
  const [citationTooltips, setCitationTooltips] = useState<CitationTooltip[]>([]);
  const referenceRender = useReferenceRender();
  const citationHover = useEditorCitationHover();
  const referenceRenderRef = useRef(referenceRender);
  useLayoutEffect(() => { referenceRenderRef.current = referenceRender; }, [referenceRender]);

  // Draft flow (same contract as the textarea editor and the LaTeX editor).
  const selectionTimerRef = useRef<number | null>(null);
  // Changes since `lastPublishedRef`, to rebase outside values in external mode.
  const changesSinceBaseRef = useRef<ChangeSet | null>(null);
  const pendingValueRef = useRef<string | null>(null);
  const previousFilePathRef = useRef(activeFilePath);
  const initialRef = useRef({ value, documentSource, mathMarkers, extensions });
  const [extensionsCompartment] = useState(() => new Compartment());
  const [mathCompartment] = useState(() => new Compartment());

  const latest = useRef({ onChange, onSelectionChange, onInsertImageFile, onViewChange, smartPaste, mathMarkers, referenceNotebook: referenceRender?.notebook ?? null });
  // Keymaps are built once with the view; they call the current handlers.
  const handlersRef = useRef<{ key: (event: SourceKey) => boolean }>({ key: () => false });
  useLayoutEffect(() => {
    latest.current = { onChange, onSelectionChange, onInsertImageFile, onViewChange, smartPaste, mathMarkers, referenceNotebook: referenceRender?.notebook ?? null };
  });
  // Structural heading numbering, read by the view's dispatch handler.
  // Switching it on (or changing its title setting) renumbers now; opening a
  // document never edits it.
  const headingNumbering = useHeadingNumbering(activeFilePath, () => detectMarkdownHeadingNumbering(value));
  const headingNumberingRef = useRef(headingNumbering);
  useLayoutEffect(() => {
    const previous = headingNumberingRef.current;
    headingNumberingRef.current = headingNumbering;
    if (previous === headingNumbering || !headingNumbering.enabled || !view) return;
    const spec = headingNumberingSpec(view.state, headingNumbering);
    if (spec) view.dispatch({ ...spec, userEvent: "input.numbering" });
  }, [headingNumbering, view]);

  const { readDraft, schedulePublish, lastPublishedRef, publishedDraftsRef, draftTimerRef } = useMarkdownSourceDraft(value, {
    readText: () => viewRef.current?.state.doc.toString() ?? null,
    isComposing: () => !!viewRef.current?.compositionStarted,
    onChange, onPublish: () => { changesSinceBaseRef.current = null; }, onRegisterDraft,
  });

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

  const closeCitationPopup = useCallback(() => {
    if (!citationPopupRef.current) return;
    citationPopupRef.current = null;
    setCitationPopup(null);
  }, []);

  const closeFileLinkPopup = useCallback(() => {
    if (fileLinkFrameRef.current !== null) window.cancelAnimationFrame(fileLinkFrameRef.current);
    fileLinkFrameRef.current = null;
    fileLinkPopupRef.current = null;
    setFileLinkPopup(null);
    closeCitationPopup();
  }, [closeCitationPopup]);

  /** Opens, moves or closes the citation popup. `citationTriggerAt` analyses the
   * whole document, so it only runs right after `@` and key characters. */
  const refreshCitationPopup = useCallback(() => {
    const current = viewRef.current;
    const previous = citationPopupRef.current;
    const text = current?.state.doc.toString() ?? "";
    const selection = current?.state.selection.main;
    const result = sourceCitationContext(text, selection?.from ?? 0, selection?.to ?? 0, {
      fileLinkOpen: !!fileLinkPopupRef.current, previous, inserted: citationInsertedRef.current,
      mathMarkers: latest.current.mathMarkers, resolves: citationResolverRef.current,
      point: (offset) => adapter.clientPointForOffset(offset),
    });
    citationInsertedRef.current = result.inserted;
    if (sameCitationPopup(previous, result.popup)) return;
    citationPopupRef.current = result.popup;
    setCitationPopup(result.popup);
  }, [adapter]);

  const refreshFileLinkPopup = useCallback(() => {
    const current = viewRef.current;
    const selection = current?.state.selection.main;
    const next = current && selection ? sourceFileLinkContext(current.state.doc.toString(), selection.from, selection.to,
      fileLinkPopupRef.current, () => adapter.clientPointForOffset(selection.head)) : null;
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
      refreshCitationPopup();
    });
  }, [refreshFileLinkPopup, refreshCitationPopup]);

  /** Applies a whole text coming from outside the editor (workspace draft,
   * review result) without replacing the document. */
  const applyIncomingText = useCallback((text: string, source: "value" | "review") => {
    text = normalizeSourceLineEndings(text);
    const current = viewRef.current;
    if (!current) return;
    if (current.compositionStarted) {
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
  }, [readDraft, draftTimerRef, lastPublishedRef, publishedDraftsRef]);

  function applyEdit(edit: Parameters<typeof textareaEditSpec>[1]) {
    replaceTextareaSelectionWithUndo(adapter.asTextarea(), { ...edit, scrollTop: adapter.scrollTop, scrollLeft: adapter.scrollLeft });
  }

  // Create the view once. Later prop changes reconfigure it in place.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = initialRef.current;
    let compositionEdit: Transaction | null = null;
    const closeMenus = () => {
      setContextMenu(null);
      closeFileLinkPopup();
    };
    const state = EditorState.create({
      doc: initial.value,
      extensions: [
        Prec.highest(EditorView.domEventHandlers({
          keydown: (event) => {
            if (!handlersRef.current.key(event)) return false;
            event.preventDefault();
            return true;
          },
          keyup: (event) => {
            if (event.key !== "Escape") scheduleSelection();
            if (refreshSourcePopupOnKeyUp(event.key)) scheduleFileLinkPopupRefresh();
            return false;
          },
          click: () => { scheduleFileLinkPopupRefresh(); scheduleSelection(); return false; },
        })),
        markdownSourceSetup(),
        mathCompartment.of(liberaMathMarkers.of(initial.mathMarkers ?? {})),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            changesSinceBaseRef.current = changesSinceBaseRef.current
              ? changesSinceBaseRef.current.compose(update.changes)
              : update.changes;
            const fromOutside = update.transactions.every((tr) => !tr.docChanged || tr.annotation(markdownValueSync));
            if (!fromOutside) clearReviewSelectionRef.current();
            // In value mode, text applied from the workspace is already its draft.
            if (initial.documentSource === "external" || !fromOutside) schedulePublish();
            if (findOpenRef.current || contextMenuOpenRef.current) {
              const text = update.state.doc.toString();
              setFindText(text);
            }
          }
          if (update.docChanged || update.selectionSet) {
            scheduleSelection();
            if (update.docChanged) scheduleFileLinkPopupRefresh();
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
            const contents = sourceClipboardContents(data);
            if (contents.kind === "image") {
              event.preventDefault();
              closeMenus();
              void latest.current.onInsertImageFile(contents.image, { start: from, end: to });
              return true;
            }
            const edit = sourcePasteEdit(target.state.doc.toString(), { start: from, end: to }, contents.clipboard, { mathMarkers: latest.current.mathMarkers, smartPaste: sourcePasteMode(latest.current.smartPaste) });
            if (!edit) return false;
            event.preventDefault();
            closeMenus();
            applyEdit(edit);
            readDraft();
            window.requestAnimationFrame(() => { emitSelection(); scheduleFileLinkPopupRefresh(); });
            return true;
          },
          dragover: (event) => {
            const kind = sourceDragKind(event.dataTransfer, hasPdfQuoteDrag(event.dataTransfer));
            if (kind === "quote") {
              event.preventDefault();
              event.dataTransfer!.dropEffect = "copy";
              return true;
            }
            if (!event.dataTransfer || kind !== "image") return false;
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
            const quote = pdfQuoteFromDrop(event.dataTransfer);
            if (quote) {
              // A quote dragged from a PDF: quote and cite it as a block at the drop point.
              event.preventDefault();
              const offset = positionAt(target, event) ?? target.state.selection.main.head;
              void droppedQuoteMarkdown(quote, latest.current.referenceNotebook).then((markdown) => {
                if (!markdown || viewRef.current !== target) return;
                const insertion = quoteBlockInsertion(target.state.doc.toString(), offset, markdown);
                applyEdit({ selectionStart: insertion.from, selectionEnd: insertion.from, replacement: insertion.text, nextSelectionStart: insertion.caret, nextSelectionEnd: insertion.caret });
                readDraft();
              });
              return true;
            }
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
            setFindText(target.state.doc.toString());
            setContextMenu(sourceContextMenuState(target.state.doc.toString(), from, to, event.clientX, event.clientY));
            return true;
          },
          compositionend: () => {
            // CodeMirror finishes the composition after this event.
            window.setTimeout(() => {
              const current = viewRef.current;
              if (!current || current.compositionStarted) return;
              const pending = pendingValueRef.current;
              if (pending !== null && pending !== current.state.doc.toString()) applyIncomingText(pending, "value");
              else if (compositionEdit) {
                const main = current.state.selection.main;
                const shrunk = compositionEdit.newDoc.length < compositionEdit.startState.doc.length;
                const spec = headingNumberingSpec(current.state, headingNumberingRef.current, shrunk && main.empty ? main.head : undefined);
                if (spec) current.dispatch(spec);
              }
              compositionEdit = null;
              pendingValueRef.current = null;
            }, 0);
            return false;
          },
        }),
        citationEditorHandlers.of({
          pointer: citationHover.show,
          hover: (dom, citation) => {
            const id = Math.random();
            // Render synchronously so CodeMirror measures the tooltip with its content.
            const add = () => setCitationTooltips((list) => [...list, { id, dom, citation }]);
            try { flushSync(add); } catch { add(); }
            return () => setCitationTooltips((list) => list.filter((tooltip) => tooltip.id !== id));
          },
          open: (citation) => openCitationAttachment(referenceRenderRef.current, citation),
        }),
        extensionsCompartment.of(initial.extensions ?? []),
      ],
    });

    const created = new EditorView({
      state,
      parent: host,
      dispatchTransactions: (transactions, target) => {
        if (target.compositionStarted) {
          const edit = transactions.filter((tr) => tr.docChanged).at(-1);
          if (edit) compositionEdit = isHeadingNumberingEdit(edit) ? edit : null;
          target.update(transactions);
        } else {
          if (transactions.some((tr) => tr.docChanged)) compositionEdit = null;
          target.update(headingNumberingTransactions(transactions, headingNumberingRef.current));
        }
      },
    });
    viewRef.current = created;
    // Side panels and window resizes rewrap long lines; hold the reader's place.
    const releaseReflow = keepScrollOnReflow(created.scrollDOM, codeMirrorReflowAdapter(created));
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
      releaseReflow();
      adapter.detach();
      created.destroy();
      viewRef.current = null;
    };
    // The view is created once per mount; everything it calls is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [activeFilePath, value, applyIncomingText, lastPublishedRef, publishedDraftsRef]);

  useEffect(() => {
    if (view) view.dispatch({ effects: extensionsCompartment.reconfigure(extensions ?? []) });
  }, [view, extensions, extensionsCompartment]);

  useEffect(() => {
    if (view) view.dispatch({ effects: mathCompartment.reconfigure(liberaMathMarkers.of(mathMarkers ?? {})) });
  }, [view, mathMarkers, mathCompartment]);

  // The Document style control's request (references/document-style.ts): one undoable edit of the front matter.
  useEffect(() => {
    if (!view || !activeFilePath) return;
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<DocumentStyleRequestDetail>).detail;
      if (detail.path !== activeFilePath || detail.handled) return;
      detail.handled = true;
      const text = view.state.doc.toString();
      const next = writeDocumentStyleForPath(activeFilePath, text, detail.style);
      if (next === text) return;
      const change = textChange(text, next);
      applyEdit({ selectionStart: change.from, selectionEnd: change.to, replacement: change.insert,
        ...sourceSelectionAfterChange(adapter.selectionStart, adapter.selectionEnd, change) });
      readDraft();
    };
    window.addEventListener(DOCUMENT_STYLE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(DOCUMENT_STYLE_REQUEST_EVENT, onRequest);
    // applyEdit uses the stable textarea adapter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeFilePath, readDraft, adapter]);

  // Citation chips mark keys the notebook's library does not know.
  const citationLibraryKeys = referenceRender?.library ? referenceRender.entriesByKey : null;
  useLayoutEffect(() => {
    citationResolverRef.current = referenceKeyResolver(referenceRender);
  }, [referenceRender]);
  useEffect(() => {
    if (view) view.dispatch({ effects: setCitationLibrary.of(citationLibraryKeys ? { has: (key) => Object.hasOwn(citationLibraryKeys, key) } : null) });
  }, [view, citationLibraryKeys]);

  // Review mode: comment anchors, agentic-review suggestions, the comment
  // gesture and read-only locking come from the shared CodeMirror review hook.
  const applyReviewText = useCallback((text: string) => applyIncomingText(text, "review"), [applyIncomingText]);
  const review = useCodeMirrorReview(view, applyReviewText, sourceTextareaRef);
  useLayoutEffect(() => { clearReviewSelectionRef.current = () => review?.clearSelection(); }, [review]);

  const aiWorking = formatting || imageConverting;

  // Find and Replace ---------------------------------------------------------

  const find = useMarkdownSourceFind({
    text: findText, textareaRef: sourceTextareaRef, readText: () => adapter.value, updateText: setFindText,
    commitText: (textarea, text) => { textarea.value = text; }, readDraft, closeContextMenu: () => setContextMenu(null),
  });
  useLayoutEffect(() => { findOpenRef.current = find.open; }, [find.open]);
  const matches = find.matches;
  const activeMatch = matches.length ? (find.active + matches.length) % matches.length : 0;
  useEffect(() => {
    if (view) view.dispatch({ effects: setFindMatches.of({ matches, active: activeMatch }) });
  }, [view, matches, activeMatch]);

  // File-link picker -----------------------------------------------------------

  const fileLinkSections = useMemo(
    () => fileLinkPopup && !fileLinkPopup.headings
      ? buildMarkdownFileLinkSections({ activeFilePath, files, openTabs: readOpenTabs?.() ?? openTabs ?? [], query: fileLinkPopup.query, recentFiles })
      : [],
    [activeFilePath, fileLinkPopup, files, openTabs, readOpenTabs, recentFiles],
  );
  const headingLinkOptions = useMemo(() => fileLinkPopup?.headings ? filterMarkdownHeadingAnchors(fileLinkPopup.headings, fileLinkPopup.query) : null, [fileLinkPopup]);
  const fileLinkOptions = useMemo(() => flattenMarkdownFileLinkSections(fileLinkSections), [fileLinkSections]);
  const linkOptionCount = headingLinkOptions ? headingLinkOptions.length : fileLinkOptions.length;
  const selectedFileLinkIndex = linkOptionCount ? Math.min(activeFileLinkIndex, linkOptionCount - 1) : 0;
  function insertFileLink(selection: MarkdownFileLinkSelection) {
    const popup = fileLinkPopupRef.current;
    const range = popup ? { start: popup.destinationStart, end: popup.destinationEnd } : undefined;
    closeFileLinkPopup();
    onInsertFileLink(selection, range);
  }

  function insertHeadingLink(heading: MarkdownHeadingAnchor) {
    const popup = fileLinkPopupRef.current;
    closeFileLinkPopup();
    if (!popup) return;
    applyEdit(sourceHeadingLinkEdit(adapter.value, popup, heading));
    readDraft();
  }

  function applyHeadingLevelChange(direction: HeadingLevelChangeDirection, range?: { start: number; end: number }) {
    const current = viewRef.current;
    if (!current) return false;
    const text = current.state.doc.toString();
    const result = changeSelectedHeadingLevels(text, range?.start ?? adapter.selectionStart, range?.end ?? adapter.selectionEnd, direction);
    if (!result.hasHeading) return false;
    setContextMenu(null);
    closeFileLinkPopup();
    if (result.changed) {
      applyEdit({ ...getChangedTextRange(text, result.nextValue), nextSelectionStart: result.nextStart, nextSelectionEnd: result.nextEnd });
      readDraft();
    }
    window.requestAnimationFrame(() => {
      current.focus();
      adapter.setSelectionRange(result.nextStart, result.nextEnd);
      emitSelection();
      scheduleFileLinkPopupRefresh();
    });
    return true;
  }

  useLayoutEffect(() => {
    handlersRef.current.key = (event) => handleSourceKey(event, {
      citation: (key) => !!citationPopupRef.current && !!citationPopupHandleRef.current?.handleKey(key),
      fileLink: (key) => {
        if (!fileLinkPopupRef.current) return false;
        const action = fileLinkPopupKey(key, linkOptionCount);
        if (action === "close") closeFileLinkPopup();
        else if (action === "next") setActiveFileLinkIndex((current) => (current + 1) % linkOptionCount);
        else if (action === "previous") setActiveFileLinkIndex((current) => (current - 1 + linkOptionCount) % linkOptionCount);
        else if (action === "choose") {
          if (headingLinkOptions) insertHeadingLink(headingLinkOptions[selectedFileLinkIndex]);
          else insertFileLink(fileLinkOptions[selectedFileLinkIndex]);
        }
        return action !== null;
      },
      format: (format) => {
        setContextMenu(null); closeFileLinkPopup();
        applyEdit(sourceFormatEdit(adapter.value, adapter.selectionStart, adapter.selectionEnd, format));
        readDraft();
        window.requestAnimationFrame(() => { emitSelection(); scheduleFileLinkPopupRefresh(); });
      },
      heading: applyHeadingLevelChange,
      find: find.openFind,
    });
  });

  // Citation popup -------------------------------------------------------------

  function insertCitation(key: string, { locator, narrative, pageLocator }: { locator: boolean; narrative?: boolean; pageLocator?: string }) {
    const current = viewRef.current;
    const popup = citationPopupRef.current;
    if (!current || !popup) return;
    // `[@key]` replaces `@query`; inside a citation, or narrative (Shift+Enter), `@key` does. One undo step.
    const insertion = citationInsertion(key, popup.insideCitation, locator, { narrative, before: popup.before, pageLocator });
    // An inserted `@key` (inside brackets or narrative) must not reopen the popup.
    citationInsertedRef.current = insertion.text.startsWith("@") ? { from: popup.from, query: key } : null;
    closeCitationPopup();
    applyEdit({ selectionStart: popup.from, selectionEnd: popup.to, replacement: insertion.text,
      nextSelectionStart: popup.from + insertion.caret, nextSelectionEnd: popup.from + insertion.caret });
    readDraft();
    window.requestAnimationFrame(emitSelection);
  }

  // Context menu ---------------------------------------------------------------

  /** Paste or Paste with Peer Heading Level, from the right-click menu. */
  async function pasteFromMenu(menu: SourceContextMenuState, mode: MenuPasteMode) {
    const options = { insertPlain: true, mathMarkers: latest.current.mathMarkers, smartPaste: sourcePasteMode(latest.current.smartPaste, mode) };
    const clipboard = await readClipboardText();
    const current = viewRef.current;
    if (!current) return;
    const edit = sourcePasteEdit(current.state.doc.toString(), { start: menu.start, end: menu.end }, clipboard, options);
    if (!edit) return;
    closeFileLinkPopup();
    applyEdit(edit);
    readDraft();
    window.requestAnimationFrame(() => { emitSelection(); scheduleFileLinkPopupRefresh(); });
  }

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
          activeIndex={find.active}
          findInputRef={find.findInputRef}
          matchCount={matches.length}
          query={find.query}
          replacement={find.replacement}
          wildcards={find.wildcards}
          onClose={find.closeFind}
          onNext={find.next}
          onPrevious={find.previous}
          onQueryChange={find.updateQuery}
          onReplace={find.replace}
          onReplaceAll={find.replaceAll}
          onReplacementChange={find.setReplacement}
          onWildcardsChange={find.updateWildcards}
        />
      ) : null}

      {draggingImage ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-input bg-white/70 text-sm font-medium text-foreground">
          Drop image to insert
        </div>
      ) : null}

      {contextMenu ? (
        <MarkdownSourceContextMenu
          aiWorking={aiWorking}
          documentPath={activeFilePath}
          formatting={formatting}
          imageConverting={imageConverting}
          menu={contextMenu}
          text={findText}
          onClose={() => setContextMenu(null)}
          onPaste={(mode) => runMenuAction((menu) => { void pasteFromMenu(menu, mode); })}
          onFormat={() => runMenuAction((menu) => { if (!aiWorking) void onAiFormatSelection({ start: menu.start, end: menu.end }); })}
          onHeadingLevels={(direction) => applyHeadingLevelChange(direction, contextMenu)}
          onRewrite={(prompt) => runMenuAction((menu) => { void onAiRewriteSelection({ start: menu.start, end: menu.end }, prompt); })}
          onWrite={(prompt) => runMenuAction((menu) => { void onAiWriteAt(menu.end, prompt); })}
          onImageToMarkdown={() => runMenuAction((menu) => { if (menu.image && !aiWorking) void onAiImageToMarkdown(menu.image); })}
          onReadAloud={() => runMenuAction((menu) => {
            const text = viewRef.current?.state.sliceDoc(menu.start, menu.end) ?? "";
            if (text.trim()) speakMarkdown(text, { label: "Selection" });
          })}
        />
      ) : null}

      {citationPopup ? (
        <CitationPopup
          ref={citationPopupHandleRef}
          query={citationPopup.query}
          citedKeys={citationPopup.citedKeys}
          x={citationPopup.x}
          y={citationPopup.y}
          narrativeAllowed={narrativeInsertionAllowed(citationPopup.insideCitation, citationPopup.before)}
          onInsert={insertCitation}
          onClose={closeCitationPopup}
        />
      ) : null}
      {citationHover.element}
      {citationTooltips.map((tooltip) => createPortal(<CitationTooltipContent citation={tooltip.citation} />, tooltip.dom, String(tooltip.id)))}

      {fileLinkPopup && headingLinkOptions ? (
        <MarkdownHeadingLinkPopup activeIndex={selectedFileLinkIndex} headings={headingLinkOptions} x={fileLinkPopup.x} y={fileLinkPopup.y} onSelect={insertHeadingLink} />
      ) : fileLinkPopup ? (
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
