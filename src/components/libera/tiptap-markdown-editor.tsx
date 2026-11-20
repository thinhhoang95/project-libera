"use client";

import { useTranslations } from "next-intl";
import { sourceRangeForTiptapTextSelection, tiptapSelectionForSourceRange, TiptapReview } from "@/lib/tiptap-review";
import { TiptapChanges } from "@/lib/tiptap-changes";
import { TiptapChangeBar } from "./tiptap-change-bar";
import { useTiptapDraft, TIPTAP_DRAFT_DELAY_MS } from "./use-tiptap-draft";
import { useTiptapReview } from "./use-editor-review";
import { useTiptapAgentReview } from "./use-tiptap-agent-review";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MarkdownSelectionLinkOption, MarkdownTabViewState, PendingVisualInsertion } from "@/components/libera/types";
import { convertClipboardHtmlToMarkdown, isSourceWrapperHtml, writeMarkdownClipboard } from "@/lib/markdown-clipboard";
import { changeTiptapHeadingLevels, getTiptapBlockInsertionRange, pasteMarkdownTableIntoCells, replaceTiptapRangeWithMarkdown, smartPasteTiptapMarkdown } from "@/lib/tiptap-editor-actions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createMathExtensions } from "@/lib/tiptap-math";
import { TiptapMarkdownMacros } from "@/lib/tiptap-macros";
import { ExpandMacrosButton } from "./expand-macros-button";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { Braces, Bold, Italic, Underline, Strikethrough, Superscript, Subscript, Asterisk, List, ListOrdered, ListIndentDecrease, ListIndentIncrease, Code2, ChartColumn, Workflow, CodeXml, Quote, Undo2, Redo2, ImagePlus, Images, Sigma, Link2, Highlighter, RemoveFormatting, Save, Sparkles, Scissors, ScanText, PenLine } from "lucide-react";
import katex from "katex";
import { Selection, type Transaction } from "@tiptap/pm/state";
import { captureVisualScrollAnchor, startVisualScrollRestore, type VisualScrollAnchor, type VisualScrollRestore } from "@/lib/tiptap-scroll-anchor";
import { keepScrollOnReflow, proseMirrorReflowAdapter } from "@/lib/reflow-scroll-anchor";
import { useCanvasViewStateCapture } from "./canvas-view-state";
import { closeHistory, redoDepth, undoDepth } from "@tiptap/pm/history";
import { createMarkdownExtensions } from "@/lib/tiptap-markdown";
import { TiptapCitationLayer, useTiptapCitations } from "@/components/libera/references/tiptap-citation-view";
import { useReferenceRender } from "@/components/libera/references/reference-render-context";
import { droppedQuoteMarkdown, pdfQuoteFromDrop } from "@/components/libera/references/pdf-quote-cite";
import type { PdfQuoteSource } from "@/lib/references/pdf-quote";
import { MARKDOWN_OUTLINE_NAVIGATE_EVENT, markdownLineForTiptapPosition, navigateTiptapToMarkdownHeading, revealTiptapMarkdownRange, type MarkdownOutlineNavigateDetail } from "@/lib/markdown-outline-navigation";
import { useMarkdownHeadingIndex } from "./use-markdown-heading-index";
import { HighlightTool, highlightToolKey, defaultHighlightToolState } from "@/lib/tiptap-highlight-tool";
import { TiptapFind, tiptapFindMatchRun, tiptapFindPluginKey, updateTiptapFind } from "@/lib/tiptap-find";
import { replaceAllTiptapFindInTransaction, replaceTiptapFindMatches } from "@/lib/tiptap-find-replace";
import { compileFind, compileFindReplacement } from "@/lib/find";
import type { FindRecipeStep } from "@/lib/find/presets";
import { recipeStepOptions } from "@/lib/find/recipe";
import { describeMatch } from "@/lib/find";
import type { FindPreset } from "@/lib/find/presets";
import { FindReplaceBar } from "@/components/libera/find/find-replace-bar";
import { useFindQuery } from "@/components/libera/find/use-find-query";
import { MARKDOWN_HIGHLIGHT_COLORS, MARKDOWN_TEXT_COLORS } from "@/lib/markdown-colors";
import { apiRequest } from "@/components/libera/api-client";
import { LatexExportButton } from "@/components/libera/latex-export-button";
import { FactCheckButton } from "@/components/libera/markdown-toolbar";
import { TiptapSelectionStatusBar } from "@/components/libera/tiptap-selection-status-bar";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { MarkdownDisplayZoom } from "@/components/libera/markdown-display-zoom";
import { MarkdownTextWidth } from "./markdown-text-width";
import { useHorizontalToolbarScroll } from "./use-horizontal-toolbar-scroll";
import { TiptapEditorActions } from "@/components/libera/tiptap-editor-actions";
import { MarkdownLinkInput } from "./markdown-link-input";
import { GalleryPhotoPicker, galleryPhotoFile } from "./gallery-photo-picker";
import type { LiberaFileNode, MarkdownImageAssetPayload } from "@/lib/types";
import { NoteLinksButton } from "./note-links-dialog";
import { TiptapCollabHistory } from "@/lib/collab/bindings/tiptap-history";
import type { SharedVisualHandle, SharedVisualSource } from "@/lib/collab/bindings/react-visual";
import { TableInsertButton } from "./table-grid-picker";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import { tableSizeMenu, useAppMenuEditor } from "./app-menu";
import { setTiptapHeadingNumbering, TiptapHeadingNumbering } from "@/lib/tiptap-heading-numbering";
import { TiptapBoldLeadIns } from "@/lib/tiptap-bold-lead-ins";
import type { EditorRange } from "@/lib/tiptap-editor-actions";
import { detectMarkdownHeadingNumbering, type HeadingNumberingSettings } from "@/lib/markdown-heading-numbering";
import type { SmartPasteMode } from "@/lib/markdown-smart-paste";
import { useHeadingNumbering } from "./heading-numbering-state";
import { LIVE_BLOCK_TEMPLATES, createLiveCodeBlockNodeView } from "./tiptap-live-code-block-view";
import { PYTHON_FIGURE_OPEN_CODE_EVENT, createPythonFigureNodeView } from "./tiptap-python-figure-view";
import { createInkImageNodeView } from "./ink/tiptap-ink-block";
import { inkBlockSource } from "@/lib/ink/block";
import { createInkId } from "@/lib/ink/types";
import type { ClipboardText, MenuPasteMode } from "./paste-menu-items";

type Props = {
  files?: LiberaFileNode[];
  documentPath: string;
  untitled?: boolean;
  mathMarkers?: MathMarkerSettings;
  smartPaste?: boolean;
  value: string;
  fontFamily?: string;
  fontSizePx: number;
  lineHeight: number;
  markdownZoom: number;
  initialViewState?: MarkdownTabViewState;
  onViewStateChange?: (patch: MarkdownTabViewState) => void;
  onMarkdownZoomChange: (zoom: number) => void;
  onChange: (value: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onSave: () => Promise<void>;
  onOpenFileLink: (href: string) => Promise<boolean>;
  /** Snip from an image or PDF tab, as a picture or read into Markdown. */
  canStartScreenshotSnip?: boolean;
  onStartScreenshotSnip?: (mode: "image" | "markdown") => void;
  /** Markdown to insert at the saved selection once, e.g. a finished snip. */
  pendingInsertion?: PendingVisualInsertion;
  onPendingInsertionHandled?: (id: string) => void;
  /**
   * Shared tab: the editor starts empty and the Visual bridge builds and
   * syncs it from the shared Y.Text (decision D1). `value` and `onChange`
   * are unused; undo goes through the bridge. Fixed for the editor's
   * lifetime; key the editor on its generation.
   */
  collab?: SharedVisualSource;
  /** A shared note's sync status and people, shown in the status bar. */
  sharedStatus?: ReactNode;
  readSelectionLinks?: () => MarkdownSelectionLinkOption[];
  /** Opens the document with its macros expanded in a new tab (markdown-macros.ts). */
  onExpandMacros?: (markdown: string) => void;
};

/** Smart Paste takes over only when the clipboard holds headings; rich HTML
 * is read through the editor's Markdown schema to find them. */
function smartPasteClipboard(editor: Editor, range: { from: number; to: number }, clipboard: DataTransfer | null, markdown: string | undefined, mathMarkers?: MathMarkerSettings, mode: SmartPasteMode = "child") {
  let text = markdown;
  if (!text) {
    const html = clipboard?.getData("text/html");
    try {
      text = html && !isSourceWrapperHtml(html) ? convertClipboardHtmlToMarkdown(html, mathMarkers) : clipboard?.getData("text/plain");
    } catch {
      return false;
    }
  }
  return Boolean(text?.trim()) && smartPasteTiptapMarkdown(editor, range, text!, mode);
}

type MathDraft = { latex: string; display: boolean; from: number; to: number; existing: boolean };
const buttonClass = "rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground";
const selectClass = "rounded-md border border-border bg-card px-2 py-1.5 text-xs";
const VISUAL_SCROLL_OUTLINE_ANCHOR_PROGRESS = 0.6;
const isImage = (file: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);

/** While a restore is still following late layout, report its target so an
 * early, clamped or half-laid-out position never replaces the saved one. */
function getVisualScrollState(editor: Editor, container: HTMLDivElement, restore: VisualScrollRestore | null): MarkdownTabViewState {
  if (restore?.active()) {
    const { left, top, anchor } = restore.target;
    return { visualScrollLeft: left, visualScrollTop: top, visualScrollAnchorPos: anchor?.pos, visualScrollAnchorOffset: anchor?.offset };
  }
  let anchor: VisualScrollAnchor | null = null;
  try {
    anchor = captureVisualScrollAnchor(editor.view, container);
  } catch {
    // The view can disappear between a queued scroll frame and unmount.
  }
  return {
    visualScrollLeft: container.scrollLeft, visualScrollTop: container.scrollTop,
    visualScrollAnchorPos: anchor?.pos, visualScrollAnchorOffset: anchor?.offset,
  };
}

function getVisualViewportViewState(
  editor: Editor,
  markdown: string,
  container: HTMLDivElement,
  headingOffsets: number[] | null,
  scrollState: MarkdownTabViewState,
): MarkdownTabViewState {
  if (headingOffsets === null) return scrollState;
  const containerRect = container.getBoundingClientRect();
  const editorRect = editor.view.dom.getBoundingClientRect();
  const visibleHeight = container.clientHeight || containerRect.height;
  const top = containerRect.top + Math.max(1, visibleHeight * VISUAL_SCROLL_OUTLINE_ANCHOR_PROGRESS);
  const left = Math.max(containerRect.left + 1, editorRect.left + 1);
  let position: number | null = null;

  try {
    position = editor.view.posAtCoords({ left, top })?.pos ?? null;
  } catch {
    // The view can disappear between a queued scroll frame and unmount.
  }

  const line = position === null
    ? null
    : markdownLineForTiptapPosition(editor, markdown, position, headingOffsets);

  return {
    ...(line === null ? {} : { line }),
    ...scrollState,
  };
}

export type ToolbarListHistoryState = { canSinkListItem: boolean; canLiftListItem: boolean; undo: boolean; redo: boolean };

/** The original computation: four dry-runs of list commands and two of history, on every transaction. */
export function legacyListHistoryState(current: Editor): ToolbarListHistoryState {
  return {
    canSinkListItem: current.can().sinkListItem("listItem") || current.can().sinkListItem("taskItem"),
    canLiftListItem: current.can().liftListItem("listItem") || current.can().liftListItem("taskItem"),
    undo: current.can().undo(), redo: current.can().redo(),
  };
}

/**
 * Same answers as {@link legacyListHistoryState} without the dry-runs where the
 * answer is known. Sinking and lifting both start from the block range of the
 * selection's list items and return false when there is none, which is what
 * typing in an ordinary paragraph sees. Local history is the history plugin's
 * stack depth; a shared tab undoes through a Y.UndoManager, so it asks the command.
 */
export function listHistoryState(current: Editor, shared: boolean): ToolbarListHistoryState {
  const { $from, $to } = current.state.selection;
  const inListItems = !!$from.blockRange($to, (node) => node.childCount > 0 && (node.firstChild!.type.name === "listItem" || node.firstChild!.type.name === "taskItem"));
  const history = shared
    ? { undo: current.can().undo(), redo: current.can().redo() }
    : { undo: undoDepth(current.state) > 0, redo: redoDepth(current.state) > 0 };
  if (!inListItems) return { canSinkListItem: false, canLiftListItem: false, ...history };
  return {
    canSinkListItem: current.can().sinkListItem("listItem") || current.can().sinkListItem("taskItem"),
    canLiftListItem: current.can().liftListItem("listItem") || current.can().liftListItem("taskItem"),
    ...history,
  };
}

// Transactions that leave the editor state untouched (a selector re-run by
// the subscription itself) read the previous answer.
const listHistoryCache = new WeakMap<Editor, { state: Editor["state"]; value: ToolbarListHistoryState }>();
function cachedListHistoryState(current: Editor, shared: boolean): ToolbarListHistoryState {
  // A shared tab's undo stack lives outside the editor state: always ask.
  if (shared) return listHistoryState(current, shared);
  const cached = listHistoryCache.get(current);
  if (cached && cached.state === current.state) return cached.value;
  const value = listHistoryState(current, shared);
  listHistoryCache.set(current, { state: current.state, value });
  return value;
}

export function TiptapMarkdownEditor({ files = [], mathMarkers, smartPaste = false, untitled = false, documentPath, value, fontFamily = "system-ui, sans-serif", fontSizePx, lineHeight, markdownZoom, initialViewState, onViewStateChange, onMarkdownZoomChange, onChange, onRegisterDraft, onSave, onOpenFileLink, readSelectionLinks, canStartScreenshotSnip = false, onStartScreenshotSnip, pendingInsertion, onPendingInsertionHandled, collab, sharedStatus, onExpandMacros }: Props) {
  const t = useTranslations("tiptapMarkdownEditor");
  const tPython = useTranslations("tiptapPythonFigureView");
  const frontMatterTitle = useTranslations("lib.tiptapFrontMatter")("frontMatterTitle");
  const tColor = useTranslations("lib.markdownColors.color");
  const tAppMenu = useTranslations("appMenu");
  const colorName = (color: { label: string }) => tColor(color.label.toLowerCase());
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ href: string; label?: string; from: number; to: number; markdown: string; selectionLinks?: MarkdownSelectionLinkOption[] } | null>(null);
  const [error, setError] = useState("");
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const find = useFindQuery("rich", "markdown");
  const tFind = useTranslations("find");
  const [findInSelection, setFindInSelection] = useState(false);
  // Selections In selection can use: the one find opened with, and the last
  // one moving between matches made (which is not the reader's own).
  // Whether find is open, for handlers that run twice before a render (Escape in the bar).
  const findOpenRef = useRef(false);
  const findSelectionRef = useRef<{ opening: { from: number; to: number; doc: ProseMirrorNode } | null; selectedMatch: { from: number; to: number } | null }>({ opening: null, selectedMatch: null });
  const [markdownReplacement, setMarkdownReplacement] = useState(false);
  // Replace All's counts, shown until the query or replacement changes.
  const [replaceSummary, setReplaceSummary] = useState<{ replaced: number; skipped: number; key: string } | null>(null);
  const replaceSummaryKey = `${find.finder?.key ?? ""}\u0000${find.replacement}`;
  const imageInput = useRef<HTMLInputElement>(null);
  const toolbarRef = useHorizontalToolbarScroll();
  const rootRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const visualScrollFrameRef = useRef<number | null>(null);
  const scrollRestoreRef = useRef<VisualScrollRestore | null>(null);
  const headingIndexRef = useRef<{ markdown: string; offsets: number[] } | null>(null);
  const initialViewStateRef = useRef(initialViewState);
  const onViewStateChangeRef = useRef(onViewStateChange);
  useLayoutEffect(() => { onViewStateChangeRef.current = onViewStateChange; }, [onViewStateChange]);
  const lastValue = useRef(value);
  const visualPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReportedLineRef = useRef<number | null>(null);
  const reportVisualPosition = useCallback((current: Editor, markdown: string, position: number) => {
    const index = headingIndexRef.current;
    if (!index || index.markdown !== markdown) return;
    const line = markdownLineForTiptapPosition(
      current,
      markdown,
      position,
      index.offsets,
    );
    if (line !== null && line !== lastReportedLineRef.current) {
      lastReportedLineRef.current = line;
      onViewStateChange?.({ line });
    }
  }, [onViewStateChange]);
  // Remembers the highlighted passage as source offsets, so another tab can
  // link to it after this editor has unmounted.
  const lastLinkSelectionRef = useRef<string | null>(null);
  const reportLinkSelection = useCallback((current: Editor, markdown: string) => {
    const { from, to, empty } = current.state.selection;
    const range = empty ? null : sourceRangeForTiptapTextSelection(current, markdown, from, to);
    const key = range ? `${range.start}:${range.end}` : null;
    if (key === lastLinkSelectionRef.current) return;
    lastLinkSelectionRef.current = key;
    onViewStateChangeRef.current?.({ linkSelection: range ?? undefined });
  }, []);
  const uploads = useRef(new Set<{ pos: number; controller: AbortController }>());
  // The bound bridge on a shared tab (set once the editor exists).
  const sharedRef = useRef<SharedVisualHandle | null>(null);
  const shared = !!collab;
  const markPaste = useCallback(() => sharedRef.current?.setNextProvenance({ source: "paste" }), []);
  // Structural heading numbering, handed to the TiptapHeadingNumbering plugin.
  const headingNumbering = useHeadingNumbering(documentPath, (maxDepth) => shared ? null : detectMarkdownHeadingNumbering(value, maxDepth));
  const appliedNumberingRef = useRef<{ editor: Editor; settings: HeadingNumberingSettings } | null>(null);
  // Citation nodes, the `@` popup and the citation popover (references lane).
  const citations = useTiptapCitations();
  // ```chart and ```html live blocks draw under their code, as in the preview.
  const codeBlockNodeView = useMemo(() => createLiveCodeBlockNodeView(documentPath), [documentPath]);
  // Figures made by the note's Python get Re-run and Code (lib/python/sidecar.ts).
  // Ink blocks draw as ink surfaces; other images, Python figures included, as before.
  const imageNodeView = useMemo(() => createInkImageNodeView(documentPath, createPythonFigureNodeView(documentPath, tPython)), [documentPath, tPython]);
  // A quote dragged from a PDF is quoted and cited at the drop point (set below, once the editor exists).
  const referenceNotebook = useReferenceRender()?.notebook ?? null;
  const dropQuoteRef = useRef<(source: PdfQuoteSource, pos: number) => void>(() => undefined);
  const extensions = useMemo(() => {
    const [InlineMath, BlockMath] = createMathExtensions(mathMarkers);
    return [
    // Column widths go to the front matter, which a slide deck cannot have (`---` separates its slides).
    ...createMarkdownExtensions(documentPath, { citationNodeView: citations.nodeView, codeBlockNodeView, imageNodeView, frontMatterTitle, resizableTables: !isMarkdownSlidesPath(documentPath) }),
    ...citations.extensions,
    // Routes undo to the bridge's Y.UndoManager and keeps ProseMirror history
    // from recording remote edits (shared tabs only).
    ...(shared ? [TiptapCollabHistory] : []),
    HighlightTool,
    TiptapFind.configure({ mathMarkers }),
    TiptapReview,
    TiptapChanges.configure({ documentPath }),
    TiptapHeadingNumbering,
    TiptapBoldLeadIns,
    // Shows ```libera-macro macros and counters expanded where they are used.
    TiptapMarkdownMacros.configure({ mathMarkers }),
    InlineMath.configure({
      katexOptions: { displayMode: false, throwOnError: false, trust: false },
      onClick: (node, pos) => setMathDraft({ latex: node.attrs.latex, display: false, from: pos, to: pos + node.nodeSize, existing: true }),
    }),
    BlockMath.configure({
      // KaTeX requires display mode for equation tags; the combined Mathematics
      // extension passes the same rendering options to both kinds of node.
      katexOptions: { displayMode: true, throwOnError: false, trust: false },
      onClick: (node, pos) => setMathDraft({ latex: node.attrs.latex, display: true, from: pos, to: pos + node.nodeSize, existing: true }),
    }),
  ]; }, [documentPath, mathMarkers, shared, citations, codeBlockNodeView, imageNodeView, frontMatterTitle]);

  const editor = useEditor({
    extensions,
    // A shared note starts empty: the bridge builds the document block by
    // block, which is linear where a whole-note parse is not.
    content: shared ? "" : value,
    contentType: "markdown",
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "libera-tiptap", role: "textbox", "aria-label": t("visualMarkdownEditor"), "aria-multiline": "true" },
      handleDOMEvents: {
        copy(view, event): boolean {
          if (!editor || view.state.selection.empty) return false;
          // Selection.content retains heading/list ancestors and respects
          // rectangular table selections as well as text and node selections.
          const content = view.state.selection.content().content.toJSON();
          const markdown = editor.markdown?.serialize({ type: "doc", content: content ?? [] }) ?? "";
          return writeMarkdownClipboard(event, markdown);
        },
      },
      handleDrop(view, event, _slice, moved) {
        const quote = moved ? null : pdfQuoteFromDrop(event.dataTransfer);
        if (quote) {
          event.preventDefault();
          setDragging(false);
          let pos = view.state.selection.from;
          try {
            pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? pos;
          } catch {
            // No layout (a hidden pane): the quote goes after the caret's block.
          }
          dropQuoteRef.current(quote, pos);
          return true;
        }
        if (moved || !event.dataTransfer?.files.length) return false;
        event.preventDefault();
        setDragging(false);
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        void insertImages(Array.from(event.dataTransfer.files), pos);
        return true;
      },
      handlePaste(view, event): boolean {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.some(isImage)) {
          event.preventDefault();
          void insertImages(files, view.state.selection.from);
          return true;
        }
        if (!editor || editor.isActive("codeBlock") || editor.isActive("code")) return false;
        // Libera's own paste handlers dispatch ordinary transactions; tag
        // them so the shared history records a paste.
        markPaste();
        const markdown = event.clipboardData?.getData("text/markdown");
        // A throw here would skip preventDefault and leave the paste to the
        // browser, which drops the source (or its colour spans) in unparsed;
        // returning false hands it to ProseMirror's own paste instead.
        try {
          if (smartPaste && smartPasteClipboard(editor, view.state.selection, event.clipboardData, markdown, mathMarkers)) {
            event.preventDefault();
            return true;
          }
          // Keep native rich-text paste, while plain source (including Libera's
          // Copy as Markdown, and code editors' styled source) is parsed into
          // editable document content.
          const html = event.clipboardData?.getData("text/html");
          if (!markdown && html && !isSourceWrapperHtml(html)) return false;
          const text = markdown || event.clipboardData?.getData("text/plain");
          if (!text?.trim()) return false;
          if (pasteMarkdownTableIntoCells(editor, text)) { event.preventDefault(); return true; }
          const inserted = replaceTiptapRangeWithMarkdown(editor, view.state.selection, text);
          if (inserted) event.preventDefault();
          return inserted;
        } catch {
          return false;
        }
      },
      handleKeyDown(view, event): boolean {
        if (
          !editor ||
          event.key !== "Tab" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return false;
        }

        return changeTiptapHeadingLevels(
          editor,
          view.state.selection,
          event.shiftKey ? "unindent" : "indent",
        );
      },
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor || !(event.metaKey || event.ctrlKey)) return false;
        const href = anchor.getAttribute("href");
        if (href) {
          event.preventDefault();
          void onOpenFileLink(href).then((opened) => {
            if (!opened && /^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
          });
        }
        return true;
      },
    },
    onUpdate({ editor: current }) {
      scheduleVisualPosition(current);
    },
    onSelectionUpdate({ editor: current }) {
      scheduleVisualPosition(current);
    },
    onTransaction({ transaction }) {
      for (const upload of uploads.current) upload.pos = transaction.mapping.map(upload.pos);
    },
  });

  // A Python figure's Code button opens the note's sidecar like a link to it.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const open = (event: Event) => void onOpenFileLink((event as CustomEvent<{ href: string }>).detail.href);
    dom.addEventListener(PYTHON_FIGURE_OPEN_CODE_EVENT, open);
    return () => dom.removeEventListener(PYTHON_FIGURE_OPEN_CODE_EVENT, open);
  }, [editor, onOpenFileLink]);

  useLayoutEffect(() => {
    if (!editor || !collab) return;
    const handle = collab.attach(editor);
    sharedRef.current = handle;
    return () => {
      if (sharedRef.current === handle) sharedRef.current = null;
      handle.destroy();
    };
  }, [editor, collab]);
  const sharedDraft = useMemo(() => (collab ? { text: () => sharedRef.current?.text() ?? lastValue.current } : null), [collab]);
  // Shared tab: AI results and "Suggest edit" go to the document's suggestions.
  const sharedSuggestions = useCallback(() => sharedRef.current?.suggestions ?? null, []);
  const { read: readMarkdown, replace: replaceMarkdown, pending: pendingDraftRef } = useTiptapDraft(editor, value, lastValue, onChange, onRegisterDraft, sharedDraft);
  useTiptapReview(editor, lastValue, readMarkdown, replaceMarkdown);
  // Shared tabs review the agent's changes as suggestions instead.
  useTiptapAgentReview(editor, collab || untitled ? null : documentPath, lastValue);

  useMarkdownHeadingIndex(value, (markdown, offsets) => {
    headingIndexRef.current = { markdown, offsets };
    // Catch up when background parsing finishes, but never apply positions
    // against newer, unpublished edits or an active IME composition.
    if (editor && !editor.isDestroyed && !pendingDraftRef.current && !editor.view.composing) {
      const container = scrollContainerRef.current;
      if (!container || markdown !== lastValue.current) return;
      const viewState = getVisualViewportViewState(editor, markdown, container, offsets, getVisualScrollState(editor, container, scrollRestoreRef.current));
      lastReportedLineRef.current = viewState.line ?? null;
      onViewStateChange?.(viewState);
    }
  });

  const state = useEditorState({ editor, selector: ({ editor: observedEditor }) => {
    // With deferred rendering, TipTap's state subscription can still hold its
    // initial null snapshot until the first transaction. Read the new editor
    // directly so EditorContent can mount without waiting for that transaction.
    const current = observedEditor ?? editor;
    return current ? {
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"), strike: current.isActive("strike"),
    superscript: current.isActive("superscript"), subscript: current.isActive("subscript"),
    bulletList: current.isActive("bulletList"), orderedList: current.isActive("orderedList"),
    ...cachedListHistoryState(current, shared),
    blockquote: current.isActive("blockquote"), codeBlock: current.isActive("codeBlock"),
    table: current.isActive("table"),
    boxColor: current.isActive("blockquote") ? current.getAttributes("blockquote").color ?? "default" : "",
    highlightTool: highlightToolKey.getState(current.state) ?? defaultHighlightToolState,
    highlight: current.isActive("highlight"),
    // Subscribe only to UI data, never a DecorationSet containing document nodes.
    find: (() => {
      const find = tiptapFindPluginKey.getState(current.state);
      return find ? { matches: find.matches, activeMatchIndex: find.activeMatchIndex, incomplete: find.incomplete } : undefined;
    })(),
    heading: current.isActive("heading") ? String(current.getAttributes("heading").level) : "0",
    fontSize: current.getAttributes("textStyle").fontSize ?? "",
    lineHeight: current.getAttributes("textStyle").lineHeight ?? "",
    color: current.getAttributes("textStyle").color ?? "",
    } : null;
  } });

  function captureVisualState() {
    const container = scrollContainerRef.current;
    if (!editor || editor.isDestroyed || !container) return;
    readMarkdown();
    onViewStateChangeRef.current?.({
      ...getVisualScrollState(editor, container, scrollRestoreRef.current),
      visualSelection: editor.state.selection.toJSON(),
    });
  }
  useCanvasViewStateCapture(captureVisualState);

  // While the bar is open, the compiled query drives the find plugin.
  const activeFinder = findOpen && find.query ? find.finder : null;
  useEffect(() => {
    if (!editor || editor.isDestroyed || !findOpen) return;
    updateTiptapFind(editor, { finder: activeFinder, activeMatchIndex: 0 });
    if (!activeFinder) return;
    scrollRestoreRef.current?.cancel();
    requestAnimationFrame(() => {
      scrollContainerRef.current
        ?.querySelector<HTMLElement>(".markdown-editor-find-match-active")
        ?.scrollIntoView?.({ block: "center", inline: "nearest" });
    });
  }, [editor, findOpen, activeFinder]);

  useLayoutEffect(() => {
    dropQuoteRef.current = (source, pos) => {
      void droppedQuoteMarkdown(source, referenceNotebook).then((markdown) => {
        if (!markdown || !editor || editor.isDestroyed) return;
        markPaste();
        replaceTiptapRangeWithMarkdown(editor, getTiptapBlockInsertionRange(editor, Math.min(pos, editor.state.doc.content.size)), markdown);
        editor.commands.focus();
      });
    };
  }, [editor, markPaste, referenceNotebook]);

  // Switching numbering on (or changing its title setting) renumbers now;
  // opening a document never edits it.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const previous = appliedNumberingRef.current;
    appliedNumberingRef.current = { editor, settings: headingNumbering };
    if (previous?.editor === editor && previous.settings === headingNumbering) return;
    setTiptapHeadingNumbering(editor, headingNumbering, previous?.editor === editor);
  }, [editor, headingNumbering]);

  /** Paste or Paste with Peer Heading Level from the right-click menu: the
   * clipboard as Markdown, with Smart Paste placing its headings. */
  function pasteFromMenu(range: EditorRange, clipboard: ClipboardText, mode: MenuPasteMode) {
    if (!editor || editor.isDestroyed) return;
    markPaste();
    if (editor.isActive("codeBlock") || editor.isActive("code")) {
      if (clipboard.plain) editor.view.dispatch(editor.state.tr.insertText(clipboard.plain, range.from, range.to).scrollIntoView());
      return;
    }
    let text = clipboard.markdown;
    if (!text && clipboard.html && !isSourceWrapperHtml(clipboard.html)) {
      try {
        text = convertClipboardHtmlToMarkdown(clipboard.html, mathMarkers);
      } catch {
        text = "";
      }
    }
    text ||= clipboard.plain;
    if (!text.trim()) return;
    const smartMode: SmartPasteMode | null = mode === "peer" ? "peer" : smartPaste ? "child" : null;
    if (smartMode && smartPasteTiptapMarkdown(editor, range, text, smartMode)) return;
    if (pasteMarkdownTableIntoCells(editor, text)) return;
    replaceTiptapRangeWithMarkdown(editor, range, text);
  }

  // Runs after the saved selection is restored (a layout effect below), so a
  // snip lands where the caret was when it started.
  const handledInsertionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !pendingInsertion || handledInsertionRef.current === pendingInsertion.id) return;
    handledInsertionRef.current = pendingInsertion.id;
    const insertion = pendingInsertion;
    // After this commit: inserted citations mount React node views, which
    // React cannot flush while it is still committing this effect.
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      const range = insertion.inline
        ? { from: editor.state.selection.from, to: editor.state.selection.to }
        : getTiptapBlockInsertionRange(editor, editor.state.selection.to);
      markPaste();
      replaceTiptapRangeWithMarkdown(editor, range, insertion.markdown);
      editor.commands.focus();
      onPendingInsertionHandled?.(insertion.id);
    });
  }, [editor, pendingInsertion, onPendingInsertionHandled, markPaste]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) return;
    // TipTap renders asynchronously. Restore after EditorContent mounts, once
    // per editor mount, so scrolling and edits never reapply an old position.
    const initial = initialViewStateRef.current;
    const selection = initial?.visualSelection;
    if (selection) {
      try {
        editor.view.dispatch(editor.state.tr.setSelection(Selection.fromJSON(editor.state.doc, selection)));
      } catch { /* A reload may have replaced the document since this selection. */ }
    }
    // Images, diagrams, charts and live HTML reach their height after this
    // mount, so the restore keeps the anchored block in place while they do.
    const anchorPos = initial?.visualScrollAnchorPos;
    const anchorOffset = initial?.visualScrollAnchorOffset;
    const restore = startVisualScrollRestore(editor.view, container, {
      left: initial?.visualScrollLeft ?? 0, top: initial?.visualScrollTop ?? 0,
      anchor: anchorPos !== undefined && anchorOffset !== undefined ? { pos: anchorPos, offset: anchorOffset } : undefined,
    });
    scrollRestoreRef.current = restore;
    // Caret moves, insertions and navigation scroll on purpose; stop following.
    // Detaches once the restore is over, so typing pays nothing afterwards.
    const stopOnScrollIntoView = ({ transaction }: { transaction: Transaction }) => {
      if (restore.active() && !transaction.scrolledIntoView) return;
      restore.cancel();
      editor.off("transaction", stopOnScrollIntoView);
    };
    editor.on("transaction", stopOnScrollIntoView);
    const frame = window.requestAnimationFrame(() => {
      if (visualScrollFrameRef.current === frame) visualScrollFrameRef.current = null;
      if (!editor.isDestroyed) {
        const markdown = lastValue.current;
        const viewState = getVisualViewportViewState(
          editor,
          markdown,
          container,
          headingIndexRef.current?.markdown === markdown ? headingIndexRef.current.offsets : null,
          getVisualScrollState(editor, container, restore),
        );
        lastReportedLineRef.current = viewState.line ?? null;
        onViewStateChangeRef.current?.(viewState);
      }
    });
    visualScrollFrameRef.current = frame;
    return () => {
      // A tab/mode switch can unmount before the next scroll frame runs.
      if (!editor.isDestroyed) onViewStateChangeRef.current?.({
        ...getVisualScrollState(editor, container, restore),
        visualSelection: editor.state.selection.toJSON(),
      });
      editor.off("transaction", stopOnScrollIntoView);
      restore.cancel();
      if (scrollRestoreRef.current === restore) scrollRestoreRef.current = null;
      window.cancelAnimationFrame(frame);
      if (visualScrollFrameRef.current === frame) visualScrollFrameRef.current = null;
    };
  }, [editor]);

  // Side panels and window resizes rewrap the page; hold the reader's place.
  // The tab-switch restore above owns the position while it is still active.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) return;
    return keepScrollOnReflow(container, proseMirrorReflowAdapter(editor.view, container, () => scrollRestoreRef.current?.active() ?? false));
  }, [editor]);

  useEffect(() => {
    const pending = uploads.current;
    return () => {
      for (const upload of pending) upload.controller.abort();
      if (visualPositionTimerRef.current !== null) clearTimeout(visualPositionTimerRef.current);
      if (visualScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(visualScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    function navigate(event: Event) {
      const detail = (event as CustomEvent<MarkdownOutlineNavigateDetail>).detail;
      if (detail.documentPath !== documentPath || detail.markdown !== readMarkdown()) return;
      scrollRestoreRef.current?.cancel();
      if (detail.end !== undefined) {
        const range = tiptapSelectionForSourceRange(editor!, detail.markdown, { start: detail.offset, end: detail.end });
        if (range) {
          editor!.commands.setTextSelection(range);
          editor!.view.dom.focus({ preventScroll: true });
          const { node } = editor!.view.domAtPos(range.from);
          (node instanceof HTMLElement ? node : node.parentElement)?.scrollIntoView({ block: "center", inline: "nearest" });
        }
      } else navigateTiptapToMarkdownHeading(editor!, detail.markdown, detail.offset);
      // Explicit outline navigation should report its destination immediately.
      reportVisualPosition(editor!, detail.markdown, editor!.state.selection.from);
    }
    window.addEventListener(MARKDOWN_OUTLINE_NAVIGATE_EVENT, navigate);
    return () => window.removeEventListener(MARKDOWN_OUTLINE_NAVIGATE_EVENT, navigate);
  }, [documentPath, editor, readMarkdown, reportVisualPosition]);

  // A one-shot request (Global Search) to select a passage, once the restored
  // scroll position has been applied.
  const reveal = initialViewState?.reveal;
  useEffect(() => {
    if (!editor || !reveal) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        scrollRestoreRef.current?.cancel();
        const markdown = readMarkdown();
        revealTiptapMarkdownRange(editor, markdown, reveal.start, reveal.end);
        reportVisualPosition(editor, markdown, editor.state.selection.from);
        const container = scrollContainerRef.current;
        onViewStateChangeRef.current?.({
          reveal: undefined,
          visualSelection: editor.state.selection.toJSON(),
          ...(container ? getVisualScrollState(editor, container, null) : {}),
        });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor, readMarkdown, reportVisualPosition, reveal]);

  function scheduleVisualPosition(current: Editor) {
    if (!onViewStateChange) return;
    if (visualPositionTimerRef.current !== null) clearTimeout(visualPositionTimerRef.current);
    visualPositionTimerRef.current = setTimeout(() => {
      visualPositionTimerRef.current = null;
      if (current.isDestroyed) return;
      if (current.view.composing) { scheduleVisualPosition(current); return; }
      const markdown = readMarkdown();
      reportVisualPosition(current, markdown, current.state.selection.from);
      reportLinkSelection(current, markdown);
    }, TIPTAP_DRAFT_DELAY_MS);
  }


  function handleVisualScroll(container: HTMLDivElement) {
    if (visualScrollFrameRef.current !== null) return;

    visualScrollFrameRef.current = window.requestAnimationFrame(() => {
      visualScrollFrameRef.current = null;
      const currentEditor = editor;
      if (!currentEditor || currentEditor.isDestroyed) return;
      // Typing can scroll the caret. Keep scroll persistence cheap while the
      // Markdown snapshot is pending; outline tracking runs after the pause.
      // Clear the anchor so a stale block never overrides these pixels.
      if (pendingDraftRef.current) {
        onViewStateChange?.({
          visualScrollLeft: container.scrollLeft, visualScrollTop: container.scrollTop,
          visualScrollAnchorPos: undefined, visualScrollAnchorOffset: undefined,
        });
        return;
      }
      const markdown = lastValue.current;
      const viewState = getVisualViewportViewState(
        currentEditor,
        markdown,
        container,
        headingIndexRef.current?.markdown === markdown ? headingIndexRef.current.offsets : null,
        getVisualScrollState(currentEditor, container, scrollRestoreRef.current),
      );
      lastReportedLineRef.current = viewState.line ?? null;
      onViewStateChange?.(viewState);
    });
  }

  async function insertImages(files: File[], pos: number) {
    if (!editor || editor.isDestroyed) return;
    const images = files.filter(isImage);
    if (!images.length) { setError(t("chooseImageFormats")); return; }
    setError("");
    const upload = { pos, controller: new AbortController() };
    uploads.current.add(upload);
    setUploadCount((count) => count + 1);
    try {
      for (const file of images) {
        const formData = new FormData();
        formData.append("documentPath", documentPath);
        formData.append("file", file);
        const payload = untitled
          ? { assetPath: await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error(t("couldNotReadImage")));
              reader.readAsDataURL(file);
            }) }
          : await apiRequest<MarkdownImageAssetPayload>("/api/markdown-assets", { method: "POST", body: formData, signal: upload.controller.signal });
        if (editor.isDestroyed || upload.controller.signal.aborted) return;
        // The position is mapped through edits made while the upload is pending.
        markPaste();
        editor.chain().insertContentAt(upload.pos, { type: "image", attrs: { src: payload.assetPath, alt: file.name.replace(/\.[^.]+$/, "") } }).run();
      }
    } catch (cause) {
      if (!upload.controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("couldNotInsertImage"));
    } finally {
      uploads.current.delete(upload);
      if (!editor.isDestroyed) setUploadCount((count) => count - 1);
    }
  }

  const mathPreview = useMemo(() => {
    if (!mathDraft?.latex.trim()) return { html: "", error: t("enterLatexExpression") };
    try {
      return { html: katex.renderToString(mathDraft.latex, { displayMode: mathDraft.display, throwOnError: true, trust: false }), error: "" };
    } catch (cause) {
      return { html: "", error: cause instanceof Error ? cause.message : t("invalidEquation") };
    }
  }, [mathDraft, t]);

  // The macOS menu bar's Format and Insert menus, running the toolbar's commands.
  useAppMenuEditor(rootRef, () => {
    if (!editor || !state) return {};
    const listItem = () => editor.isActive("taskItem") ? "taskItem" : "listItem";
    const setBox = (color: string | null) => {
      const chain = editor.chain().focus();
      if (editor.isActive("blockquote")) chain.updateAttributes("blockquote", { color }).run();
      else chain.wrapIn("blockquote", { color }).run();
    };
    return {
      format: [
        { id: "bold", label: t("menuBold"), type: "checkbox", checked: state.bold, onSelect: () => editor.chain().focus().toggleBold().run() },
        { id: "italic", label: t("menuItalic"), type: "checkbox", checked: state.italic, onSelect: () => editor.chain().focus().toggleItalic().run() },
        { id: "underline", label: t("menuUnderline"), type: "checkbox", checked: state.underline, onSelect: () => editor.chain().focus().toggleUnderline().run() },
        { id: "strikethrough", label: t("menuStrikethrough"), type: "checkbox", checked: state.strike, onSelect: () => editor.chain().focus().toggleStrike().run() },
        { id: "superscript", label: t("menuSuperscript"), type: "checkbox", checked: state.superscript, onSelect: () => editor.chain().focus().toggleSuperscript().run() },
        { id: "subscript", label: t("menuSubscript"), type: "checkbox", checked: state.subscript, onSelect: () => editor.chain().focus().toggleSubscript().run() },
        { type: "separator" },
        { id: "highlight", label: t("menuHighlight"), type: "checkbox", checked: state.highlightTool.active || state.highlight, onSelect: () => editor.chain().focus().toggleHighlightTool().run() },
        {
          id: "highlight-color",
          label: t("menuHighlightColor"),
          submenu: MARKDOWN_HIGHLIGHT_COLORS.map((color) => ({ id: `highlight-${color.shortcut}`, label: colorName(color), type: "radio", checked: state.highlightTool.color === color.value, onSelect: () => editor.commands.setHighlightToolColor(color.value) })),
        },
        {
          id: "text-color",
          label: t("menuTextColor"),
          submenu: [
            { id: "text-color-default", label: t("menuDefault"), type: "radio", checked: !state.color, onSelect: () => editor.chain().focus().unsetColor().run() },
            { type: "separator" },
            ...MARKDOWN_TEXT_COLORS.map((color) => ({ id: `text-color-${color.value}`, label: colorName(color), type: "radio" as const, checked: state.color === color.value, onSelect: () => editor.chain().focus().setColor(color.value).run() })),
          ],
        },
        {
          id: "font-size",
          label: t("menuFontSize"),
          submenu: [
            { id: "font-size-default", label: t("menuDefault"), type: "radio", checked: !state.fontSize, onSelect: () => editor.chain().focus().unsetFontSize().run() },
            { type: "separator" },
            ...[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map((size) => ({ id: `font-size-${size}`, label: t("fontSizeValue", { size }), type: "radio" as const, checked: state.fontSize === `${size}px`, onSelect: () => editor.chain().focus().setFontSize(`${size}px`).run() })),
          ],
        },
        { type: "separator" },
        {
          id: "text-style",
          label: t("menuTextStyle"),
          submenu: [
            { id: "paragraph", label: t("menuParagraph"), type: "radio", checked: state.heading === "0", onSelect: () => editor.chain().focus().setParagraph().run() },
            ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ id: `heading-${level}`, label: t("headingLevel", { level }), type: "radio" as const, checked: state.heading === String(level), onSelect: () => editor.chain().focus().setHeading({ level }).run() })),
          ],
        },
        {
          id: "list",
          label: t("menuList"),
          submenu: [
            { id: "bulleted", label: t("menuBulletedList"), type: "checkbox", checked: state.bulletList, onSelect: () => editor.chain().focus().toggleBulletList().run() },
            { id: "numbered", label: t("menuNumberedList"), type: "checkbox", checked: state.orderedList, onSelect: () => editor.chain().focus().toggleOrderedList().run() },
            { type: "separator" },
            { id: "indent", label: t("menuIndentListItem"), enabled: state.canSinkListItem, onSelect: () => editor.chain().focus().sinkListItem(listItem()).run() },
            { id: "outdent", label: t("menuOutdentListItem"), enabled: state.canLiftListItem, onSelect: () => editor.chain().focus().liftListItem(listItem()).run() },
          ],
        },
        { id: "quote", label: t("menuQuote"), type: "checkbox", checked: state.blockquote, onSelect: () => editor.chain().focus().toggleBlockquote().run() },
        {
          id: "box",
          label: t("menuBox"),
          submenu: [
            { id: "box-default", label: t("menuDefaultGreyBox"), type: "radio", checked: state.boxColor === "default", onSelect: () => setBox(null) },
            ...MARKDOWN_HIGHLIGHT_COLORS.map((color) => ({ id: `box-${color.shortcut}`, label: t("colorBox", { color: colorName(color) }), type: "radio" as const, checked: state.boxColor === color.shortcut, onSelect: () => setBox(color.shortcut) })),
          ],
        },
        { id: "code-block", label: t("menuCodeBlock"), type: "checkbox", checked: state.codeBlock, onSelect: () => editor.chain().focus().toggleCodeBlock().run() },
        { type: "separator" },
        { id: "clear-formatting", label: t("menuClearFormatting"), onSelect: () => editor.chain().focus().unsetAllMarks().clearNodes().run() },
        { id: "fix-chatgpt-equations", label: t("menuFixChatGptEquations"), onSelect: fixChatGptEquations },
      ],
      insert: [
        { id: "link", label: t("menuLink"), onSelect: () => setLinkDraft({ href: editor.getAttributes("link").href ?? "", from: editor.state.selection.from, to: editor.state.selection.to, markdown: readMarkdown(), selectionLinks: readSelectionLinks?.() }) },
        {
          id: "image",
          label: t("menuImage"),
          submenu: [
            { id: "image-file", label: t("menuFromFile"), onSelect: () => imageInput.current?.click() },
            { id: "image-gallery", label: t("menuFromGallery"), onSelect: () => setGalleryPickerOpen(true) },
            ...(onStartScreenshotSnip ? [
              { type: "separator" as const },
              { id: "snip-image", label: t("menuSnipFromImage"), enabled: canStartScreenshotSnip, onSelect: () => { captureVisualState(); onStartScreenshotSnip("image"); } },
              { id: "snip-markdown", label: t("menuSnipAsMarkdown"), enabled: canStartScreenshotSnip, onSelect: () => { captureVisualState(); onStartScreenshotSnip("markdown"); } },
            ] : []),
          ],
        },
        tableSizeMenu((rows, cols) => editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run(), tAppMenu),
        { id: "equation", label: t("menuEquation"), onSelect: openMath },
        { id: "footnote", label: t("menuFootnote"), onSelect: () => editor.chain().focus().insertFootnote().run() },
        { id: "ink", label: t("menuInkBlock"), enabled: !untitled, onSelect: () => editor.chain().focus().insertContent([{ type: "image", attrs: { src: inkBlockSource(documentPath, createInkId()), alt: "Ink" } }, { type: "paragraph" }]).run() },
        { type: "separator" },
        { id: "chart", label: t("menuChart"), onSelect: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.chart).run() },
        { id: "diagram", label: t("menuDiagram"), onSelect: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.diagram).run() },
        { id: "macro-block", label: t("menuMacroBlock"), onSelect: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.macro).run() },
        { id: "interactive-html", label: t("menuInteractiveHtml"), onSelect: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.html).run() },
      ],
    };
  });

  if (!editor || !state) return <div className="p-6 text-sm text-muted-foreground">{t("loadingVisualEditor")}</div>;

  function scrollToActiveFindMatch() {
    scrollRestoreRef.current?.cancel();
    requestAnimationFrame(() => {
      scrollContainerRef.current
        ?.querySelector<HTMLElement>(".markdown-editor-find-match-active")
        ?.scrollIntoView?.({ block: "center", inline: "nearest" });
    });
  }

  function selectFindMatch(matchIndex: number, matches = state?.find?.matches ?? []) {
    if (!editor || !matches.length) return;
    const normalizedIndex = (matchIndex + matches.length) % matches.length;
    const match = matches[normalizedIndex];
    editor.commands.setTextSelection({ from: match.from, to: match.to });
    findSelectionRef.current.selectedMatch = { from: match.from, to: match.to };
    updateTiptapFind(editor, { activeMatchIndex: normalizedIndex });
    scrollToActiveFindMatch();
  }

  function openFind() {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, "\n", "\n");
    if (selectedText && !selectedText.includes("\n")) find.setQuery(selectedText);
    // In selection uses this selection, unless the reader selects something else.
    findSelectionRef.current.opening = empty ? null : { from, to, doc: editor.state.doc };
    findSelectionRef.current.selectedMatch = null;
    findOpenRef.current = true;
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
      scrollToActiveFindMatch();
    });
  }

  function closeFind() {
    if (!editor || !findOpenRef.current) return;
    findOpenRef.current = false;
    const container = scrollContainerRef.current;
    const scrollLeft = container?.scrollLeft ?? 0;
    const scrollTop = container?.scrollTop ?? 0;
    setFindOpen(false);
    setFindInSelection(false);
    setReplaceSummary(null);
    updateTiptapFind(editor, { finder: null, within: null, activeMatchIndex: 0 });
    editor.commands.focus(undefined, { scrollIntoView: false });
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollLeft = scrollLeft;
      container.scrollTop = scrollTop;
    });
  }

  function toggleFindInSelection() {
    if (!editor) return;
    if (findInSelection) {
      setFindInSelection(false);
      updateTiptapFind(editor, { within: null, activeMatchIndex: 0 });
      return;
    }
    // The reader's selection; not one that moving between matches made.
    const { from, to, empty } = editor.state.selection;
    const picked = findSelectionRef.current.selectedMatch;
    const own = !empty && !(picked && picked.from === from && picked.to === to) ? { from, to } : null;
    const opening = findSelectionRef.current.opening?.doc === editor.state.doc ? findSelectionRef.current.opening : null;
    const range = own ?? (opening ? { from: opening.from, to: opening.to } : null);
    if (!range) return;
    setFindInSelection(true);
    updateTiptapFind(editor, { within: [range], activeMatchIndex: 0 });
    scrollToActiveFindMatch();
  }

  /** Runs a recipe's steps in order in one transaction (one undo step). */
  function runFindRecipe(steps: FindRecipeStep[]) {
    if (!editor) return;
    const tr = closeHistory(editor.state.tr);
    let replaced = 0, skipped = 0;
    for (const step of steps) {
      const compiled = compileFind(step.query, recipeStepOptions(step, "markdown"));
      if (!compiled.ok) continue;
      const replacement = compileFindReplacement(compiled.finder, step.replacement, step.preserveCase ?? false);
      if (!replacement.ok) continue;
      const result = replaceAllTiptapFindInTransaction(editor, tr, compiled.finder, {
        replacer: replacement.replacer, markdown: step.markdownReplacement ?? markdownReplacement, firstCounter: 1,
      });
      replaced += result.replaced;
      skipped += result.skipped;
    }
    if (tr.docChanged) {
      tr.setMeta(tiptapFindPluginKey, { activeMatchIndex: 0 });
      editor.view.dispatch(tr);
    }
    setReplaceSummary({ replaced, skipped, key: replaceSummaryKey });
  }

  function replaceFindMatches(replaceAll: boolean) {
    if (!editor || !find.replacer) return;
    const current = tiptapFindPluginKey.getState(editor.state);
    if (!current?.matches.length) return;
    const index = current.activeMatchIndex;
    const matches = replaceAll ? current.matches : [current.matches[index]];
    const result = replaceTiptapFindMatches(editor, matches, { replacer: find.replacer, markdown: markdownReplacement, firstCounter: replaceAll ? 1 : index + 1 });
    if (replaceAll) setReplaceSummary({ replaced: result.replaced, skipped: result.skipped, key: replaceSummaryKey });
    else {
      const end = result.end;
      const next = tiptapFindPluginKey.getState(editor.state);
      // After a replacement, the match that follows it; a skipped match just moves on.
      const followingIndex = end === null ? index + 1 : next?.matches.findIndex((match) => match.from >= end) ?? -1;
      updateTiptapFind(editor, { activeMatchIndex: followingIndex < 0 ? 0 : followingIndex });
    }
    scrollToActiveFindMatch();
  }

  function fixChatGptEquations() {
    if (!editor) return;
      // Pasted plain text is escaped during Markdown serialization. Read its
      // literal delimiters from text blocks and replace only the math ranges.
      const replacements: { from: number; to: number; type: string; latex: string }[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (!node.isTextblock || node.type.spec.code) return;
        const text = node.textBetween(0, node.content.size, "\n", "\n");
        for (const match of text.matchAll(/\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g)) {
          const from = pos + 1 + match.index;
          const to = from + match[0].length;
          let protectedText = false;
          editor!.state.doc.nodesBetween(from, to, (child) => {
            if (child.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")) protectedText = true;
          });
          if (!protectedText) replacements.push({ from, to, type: match[1] !== undefined ? "blockMath" : "inlineMath", latex: (match[1] ?? match[2]).trim() });
        }
        return false;
      });
      if (!replacements.length) return;
      const chain = editor.chain().command(({ tr }) => { closeHistory(tr); return true; });
      for (const { from, to, type, latex } of replacements.reverse()) {
        chain.insertContentAt({ from, to }, { type, attrs: { latex } });
      }
      chain.run();
  }

  function openMath() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const node = editor.state.doc.nodeAt(from);
    const existing = node?.type.name === "inlineMath" || node?.type.name === "blockMath";
    setMathDraft({ from, to: existing ? from + node!.nodeSize : to, existing, display: node?.type.name === "blockMath", latex: existing ? node!.attrs.latex : editor.state.doc.textBetween(from, to) });
  }

  const findMatches = state.find?.matches ?? [];
  const activeFindIndex = state.find?.activeMatchIndex ?? 0;
  const activeFindMatch = findOpen && find.finder ? findMatches[activeFindIndex] : undefined;
  const activeFindRun = activeFindMatch ? tiptapFindMatchRun(editor.state.doc, activeFindMatch, tiptapFindPluginKey.getState(editor.state)?.reading) : null;
  const findPreview = activeFindMatch && activeFindRun && find.finder
    ? describeMatch(activeFindRun.text, activeFindMatch.reading, find.finder, find.replacer, activeFindIndex + 1)
    : null;

  return (
    <div ref={rootRef} className="libera-visual-editor flex min-h-0 min-w-0 flex-1 flex-col bg-card" onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === "Escape" && state.highlightTool.active) {
        // Claimed, so Review mode's Escape waits for the next press.
        event.preventDefault();
        editor.commands.setHighlightToolActive(false);
      }
    }}>
      <div ref={toolbarRef} aria-label={t("formattingToolbar")} role="toolbar" tabIndex={0}
        className="libera-editor-toolbar libera-horizontal-toolbar flex min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-border px-3 py-1.5 [&>*]:shrink-0">
        <select aria-label={t("textStyle")} className={selectClass} value={state.heading} onChange={(event) => {
          const level = Number(event.target.value) as 1 | 2 | 3 | 4 | 5 | 6;
          if (level) editor.chain().focus().setHeading({ level }).run(); else editor.chain().focus().setParagraph().run();
        }}>
          <option value="0">{t("paragraph")}</option>
          {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{t("headingLevel", { level })}</option>)}
        </select>
        <select aria-label={t("fontSize")} className={selectClass} value={state.fontSize} onChange={(event) => event.target.value ? editor.chain().focus().setFontSize(event.target.value).run() : editor.chain().focus().unsetFontSize().run()}>
          <option value="">{t("fontSize")}</option>
          {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map((size) => <option key={size} value={`${size}px`}>{t("fontSizeValue", { size })}</option>)}
        </select>
        <select aria-label={t("lineSpacing")} className={selectClass} value={state.lineHeight} onChange={(event) => {
          const chain = editor.chain().focus();
          // Without a selection, format the current paragraph's text.
          if (editor.state.selection.empty) {
            const { $from } = editor.state.selection;
            chain.setTextSelection({ from: $from.start(), to: $from.end() });
          }
          if (event.target.value) chain.setLineHeight(event.target.value).run(); else chain.unsetLineHeight().run();
        }}>
          <option value="">{t("lineSpacing")}</option>
          {[1, 1.15, 1.5, 1.75, 2, 2.5, 3].map((spacing) => <option key={spacing} value={spacing}>{t("lineSpacingValue", { spacing })}</option>)}
        </select>
        <TiptapEditorActions editor={editor} documentPath={documentPath} onError={setError} onPaste={pasteFromMenu} shared={collab ? sharedSuggestions : undefined} />
        {[
          { title: t("bold"), icon: Bold, active: state.bold, run: () => editor.chain().focus().toggleBold().run() },
          { title: t("italic"), icon: Italic, active: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
          { title: t("underline"), icon: Underline, active: state.underline, run: () => editor.chain().focus().toggleUnderline().run() },
          { title: t("strikethrough"), icon: Strikethrough, active: state.strike, run: () => editor.chain().focus().toggleStrike().run() },
          { title: t("superscript"), icon: Superscript, active: state.superscript, run: () => editor.chain().focus().toggleSuperscript().run() },
          { title: t("subscript"), icon: Subscript, active: state.subscript, run: () => editor.chain().focus().toggleSubscript().run() },
          { title: t("highlight"), icon: Highlighter, active: state.highlightTool.active || state.highlight, run: () => editor.chain().focus().toggleHighlightTool().run() },
        ].map(({ title, icon: Icon, active, run }) => <button key={title} type="button" title={title} aria-label={title} aria-pressed={active} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></button>)}
        <select aria-label={t("highlightColorSelect")} className={selectClass} value={state.highlightTool.color} onChange={(event) => editor.commands.setHighlightToolColor(event.target.value)}>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => <option key={color.value} value={color.value}>{t("highlightColorOption", { color: colorName(color) })}</option>)}
        </select>
        {[
          { title: t("bulletList"), icon: List, active: state.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
          { title: t("numberedListTitle"), icon: ListOrdered, active: state.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
          { title: t("outdentListItemTitle"), icon: ListIndentDecrease, active: false, disabled: !state.canLiftListItem, run: () => editor.chain().focus().liftListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run() },
          { title: t("indentListItemTitle"), icon: ListIndentIncrease, active: false, disabled: !state.canSinkListItem, run: () => editor.chain().focus().sinkListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run() },
          { title: t("codeBlockLower"), icon: Code2, active: state.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
          { title: t("insertChart"), icon: ChartColumn, active: false, run: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.chart).run() },
          { title: t("insertDiagram"), icon: Workflow, active: false, run: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.diagram).run() },
          { title: t("insertMacroBlock"), icon: Braces, active: false, run: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.macro).run() },
          { title: t("insertInteractiveHtml"), icon: CodeXml, active: false, run: () => editor.chain().focus().insertContent(LIVE_BLOCK_TEMPLATES.html).run() },
        ].map(({ title, icon: Icon, active, disabled, run }: { title: string; icon: typeof List; active: boolean; disabled?: boolean; run: () => void }) => <button key={title} type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} className={`${buttonClass} disabled:opacity-40`} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></button>)}
        <button type="button" title={t("quote")} aria-label={t("quote")} aria-pressed={state.blockquote} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></button>
        <select aria-label={t("boxColor")} className={selectClass} value={state.boxColor} onChange={(event) => {
          const chain = editor.chain().focus();
          const color = event.target.value === "default" ? null : event.target.value;
          if (state.blockquote) chain.updateAttributes("blockquote", { color }).run();
          else chain.wrapIn("blockquote", { color }).run();
        }}>
          <option value="" disabled>{t("boxColor")}</option>
          <option value="default">{t("defaultGreyBoxLower")}</option>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => <option key={color.shortcut} value={color.shortcut}>{t("colorBoxOption", { color: colorName(color) })}</option>)}
        </select>
        <select aria-label={t("textColorSelect")} className={selectClass} value={state.color} onChange={(event) => event.target.value ? editor.chain().focus().setColor(event.target.value).run() : editor.chain().focus().unsetColor().run()}>
          <option value="">{t("textColorSelect")}</option>
          {MARKDOWN_TEXT_COLORS.map((color) => <option key={color.value} value={color.value}>{colorName(color)}</option>)}
        </select>
        <button type="button" aria-label={t("insertOrEditLink")} title={t("insertOrEditLink")} className={buttonClass} onClick={() => setLinkDraft({ href: editor.getAttributes("link").href ?? "", from: editor.state.selection.from, to: editor.state.selection.to, markdown: readMarkdown(), selectionLinks: readSelectionLinks?.() })}><Link2 className="h-4 w-4" /></button>
        <NoteLinksButton className={buttonClass} documentPath={documentPath} files={files} getContent={() => editor.getMarkdown()} onOpenLink={onOpenFileLink} />
        <button type="button" aria-label={t("insertImageFromFile")} title={t("insertImageFromFileTitle")} className={buttonClass} onClick={() => imageInput.current?.click()}><ImagePlus className="h-4 w-4" /></button>
        <button type="button" aria-label={t("insertImageFromGallery")} title={t("insertImagesFromGalleryTitle")} className={buttonClass} onClick={() => setGalleryPickerOpen(true)}><Images className="h-4 w-4" /></button>
        {onStartScreenshotSnip ? (
          <>
            <button type="button" aria-label={t("snipFromImageOrPdfTabButton")} title={canStartScreenshotSnip ? t("snipFromImageOrPdfTabButton") : t("openImageOrPdfToSnip")} disabled={!canStartScreenshotSnip} className={`${buttonClass} disabled:opacity-40`} onMouseDown={(event) => event.preventDefault()} onClick={() => { captureVisualState(); onStartScreenshotSnip("image"); }}><Scissors className="h-4 w-4" /></button>
            <button type="button" aria-label={t("snipAsMarkdown")} title={canStartScreenshotSnip ? t("snipAsMarkdownTitle") : t("openImageOrPdfToSnip")} disabled={!canStartScreenshotSnip} className={`${buttonClass} disabled:opacity-40`} onMouseDown={(event) => event.preventDefault()} onClick={() => { captureVisualState(); onStartScreenshotSnip("markdown"); }}><ScanText className="h-4 w-4" /></button>
          </>
        ) : null}
        <button type="button" aria-label={t("insertInkBlock")} title={untitled ? t("saveNoteToDrawTitle") : t("insertInkBlockTitle")} disabled={untitled} className={`${buttonClass} disabled:opacity-40`} onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().insertContent([{ type: "image", attrs: { src: inkBlockSource(documentPath, createInkId()), alt: "Ink" } }, { type: "paragraph" }]).run()}><PenLine className="h-4 w-4" /></button>
        <TableInsertButton className={buttonClass} disabled={state.table} title={state.table ? t("tablesCannotNest") : undefined}
          onPick={(rows, cols) => editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()} />
        <button type="button" aria-label={t("insertOrEditEquation")} title={t("insertOrEditEquation")} className={buttonClass} onClick={openMath}><Sigma className="h-4 w-4" /></button>
        <button type="button" aria-label={t("insertFootnote")} title={t("insertFootnote")} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().insertFootnote().run()}><Asterisk className="h-4 w-4" /></button>
        <button type="button" aria-label={t("clearFormattingButton")} title={t("clearFormattingButton")} className={buttonClass} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting className="h-4 w-4" /></button>
        <button type="button" aria-label={t("undo")} title={t("undo")} disabled={!state.undo} className={buttonClass} onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-4 w-4" /></button>
        <button type="button" aria-label={t("redo")} title={t("redo")} disabled={!state.redo} className={buttonClass} onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-4 w-4" /></button>
        <button type="button" aria-label={t("saveDocument")} title={t("saveDocument")} className={buttonClass} onClick={() => { readMarkdown(); void onSave(); }}><Save className="h-4 w-4" /></button>
        <button type="button" aria-label={t("fixChatGptEquationsButton")} title={t("fixChatGptEquationsButton")} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={fixChatGptEquations}><Sparkles aria-hidden className="h-4 w-4" /></button>
        <FactCheckButton className={buttonClass} documentPath={documentPath} markdown={value} disabled={untitled} />
        <ExpandMacrosButton className={buttonClass} markdown={value} getMarkdown={readMarkdown} onExpand={onExpandMacros} />
        <LatexExportButton documentPath={documentPath} getMarkdown={() => editor.getMarkdown()} />
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" aria-label={t("chooseImages")} onChange={(event) => { void insertImages(Array.from(event.target.files ?? []), editor.state.selection.from); event.target.value = ""; }} />
      </div>
      <GalleryPhotoPicker open={galleryPickerOpen} onClose={() => setGalleryPickerOpen(false)} onInsert={async (photos) => {
        // Read the selection first: the photos download before they are placed.
        const pos = editor.state.selection.from;
        const files = await Promise.all(photos.map(galleryPhotoFile));
        setGalleryPickerOpen(false);
        await insertImages(files, pos);
      }} />
      {error ? <div role="alert" className="flex items-center justify-between bg-destructive-muted px-4 py-2 text-sm text-destructive">{error}<button type="button" onClick={() => setError("")}>{t("dismiss")}</button></div> : null}
      <MarkdownTextWidth canvasRef={scrollContainerRef} />
      <div className="relative min-h-0 flex-1">
        <div ref={scrollContainerRef} className={`libera-visual-page libera-text-width-page h-full overflow-auto p-6 ${dragging ? "ring-2 ring-inset ring-primary" : ""}`} style={{ fontFamily, fontSize: fontSizePx, lineHeight }}
          onScroll={(event) => handleVisualScroll(event.currentTarget)}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
          onDrop={(event) => {
            setDragging(false);
            // Also accept drops on the empty space below the editable document.
            if (!event.defaultPrevented && event.dataTransfer.files.length) {
              event.preventDefault();
              const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.doc.content.size;
              void insertImages(Array.from(event.dataTransfer.files), pos);
            }
          }}>
          <TiptapCitationLayer editor={editor} citations={citations}>
            <EditorContent className="libera-text-width-content" editor={editor} />
          </TiptapCitationLayer>
        </div>
        {findOpen ? (
          <FindReplaceBar
            className="absolute right-3 top-3 z-20"
            find={find}
            matchCount={find.finder ? findMatches.length : 0}
            activeIndex={activeFindIndex}
            incomplete={!!state.find?.incomplete}
            preview={findPreview}
            summary={replaceSummary?.key === replaceSummaryKey ? replaceSummary : null}
            placeholder={tFind("findInNote")}
            findInputRef={findInputRef}
            onNext={() => selectFindMatch(activeFindIndex + 1)}
            onPrevious={() => selectFindMatch(activeFindIndex - 1)}
            onClose={closeFind}
            onReplace={() => replaceFindMatches(false)}
            onReplaceAll={() => replaceFindMatches(true)}
            showScopes
            inSelection={{ active: findInSelection, onToggle: toggleFindInSelection }}
            markdownReplacement={{ active: markdownReplacement, onToggle: () => setMarkdownReplacement((active) => !active) }}
            onPresetApplied={(preset: FindPreset) => setMarkdownReplacement(!!preset.markdownReplacement)}
            onRunRecipe={runFindRecipe}
          />
        ) : null}
        <TiptapChangeBar editor={editor} />
      </div>
      <TiptapSelectionStatusBar editor={editor} content={value} uploading={uploadCount > 0} trailing={<MarkdownDisplayZoom compact markdownBaseFontSize={fontSizePx / (markdownZoom / 100)} markdownZoom={markdownZoom} onMarkdownZoomChange={onMarkdownZoomChange} />} collab={sharedStatus} />
      <ModalDialog open={!!mathDraft} title={mathDraft?.existing ? t("editEquation") : t("insertEquation")} description={t("equationDescription")} panelClassName="max-w-xl" onClose={() => setMathDraft(null)} footer={<>
        <button type="button" className={selectClass} onClick={() => setMathDraft(null)}>{t("cancel")}</button>
        <button type="button" disabled={!!mathPreview.error} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" onClick={() => {
          if (!mathDraft) return;
          const type = mathDraft.display ? "blockMath" : "inlineMath";
          const original = mathDraft.existing ? editor.state.doc.nodeAt(mathDraft.from) : null;
          // The equation is where the reader clicked it: applying must not scroll to the caret.
          editor.chain().focus(undefined, { scrollIntoView: false }).insertContentAt({ from: mathDraft.from, to: mathDraft.to }, { type, attrs: { ...(original?.type.name === type ? original.attrs : {}), latex: mathDraft.latex.trim() } }).run();
          setMathDraft(null);
        }}>{t("applyEquation")}</button>
      </>}>
        <textarea autoFocus aria-label={t("latexEquation")} className="min-h-28 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" value={mathDraft?.latex ?? ""} onChange={(event) => setMathDraft((current) => current ? { ...current, latex: event.target.value } : null)} />
        <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={mathDraft?.display ?? false} onChange={(event) => setMathDraft((current) => current ? { ...current, display: event.target.checked } : null)} />{t("displayEquationOnOwnLine")}</label>
        {mathPreview.error ? <p role="status" className="text-sm text-destructive">{mathPreview.error}</p> : <div aria-label={t("equationPreview")} className="overflow-auto rounded-md bg-muted p-4" dangerouslySetInnerHTML={{ __html: mathPreview.html }} />}
      </ModalDialog>
      <ModalDialog open={!!linkDraft} title={t("insertOrEditLink")} onClose={() => setLinkDraft(null)} footer={<button type="button" className={selectClass} onClick={() => {
        if (!linkDraft) return;
        const chain = editor.chain().focus().setTextSelection({ from: linkDraft.from, to: linkDraft.to }).extendMarkRange("link");
        if (linkDraft.href.trim()) {
          if (linkDraft.from === linkDraft.to && !editor.isActive("link")) chain.insertContent({ type: "text", text: linkDraft.label ?? linkDraft.href.trim(), marks: [{ type: "link", attrs: { href: linkDraft.href.trim() } }] }).run();
          else chain.setLink({ href: linkDraft.href.trim() }).run();
        } else chain.unsetLink().run();
        setLinkDraft(null);
      }}>{t("applyLink")}</button>}>
        <MarkdownLinkInput files={files} markdown={linkDraft?.markdown} selectionLinks={linkDraft?.selectionLinks} sourcePath={documentPath} value={linkDraft?.href ?? ""} onChange={(href, label) => setLinkDraft((current) => current ? { ...current, href, label } : null)} />
      </ModalDialog>
    </div>
  );
}
