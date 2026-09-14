"use client";

import { TiptapReview } from "@/lib/tiptap-review";
import { useTiptapDraft, TIPTAP_DRAFT_DELAY_MS } from "./use-tiptap-draft";
import { useTiptapReview } from "./use-editor-review";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MarkdownTabViewState } from "@/components/libera/types";
import { writeMarkdownClipboard } from "@/lib/markdown-clipboard";
import { replaceTiptapRangeWithMarkdown } from "@/lib/tiptap-editor-actions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { createMathExtensions } from "@/lib/tiptap-math";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { Bold, Italic, Underline, List, ListOrdered, Code2, Quote, Undo2, Redo2, ImagePlus, Sigma, Link2, Highlighter, RemoveFormatting, Save, Sparkles, Search, ChevronUp, ChevronDown, X } from "lucide-react";
import katex from "katex";
import { closeHistory } from "@tiptap/pm/history";
import { createMarkdownExtensions } from "@/lib/tiptap-markdown";
import { MARKDOWN_OUTLINE_NAVIGATE_EVENT, markdownLineForTiptapPosition, navigateTiptapToMarkdownHeading, type MarkdownOutlineNavigateDetail } from "@/lib/markdown-outline-navigation";
import { useMarkdownHeadingIndex } from "./use-markdown-heading-index";
import { HighlightTool, highlightToolKey, defaultHighlightToolState } from "@/lib/tiptap-highlight-tool";
import { TiptapFind, tiptapFindPluginKey, updateTiptapFind } from "@/lib/tiptap-find";
import { MARKDOWN_HIGHLIGHT_COLORS, MARKDOWN_TEXT_COLORS } from "@/lib/markdown-colors";
import { apiRequest } from "@/components/libera/api-client";
import { LatexExportButton } from "@/components/libera/latex-export-button";
import { MarkdownStatusBar } from "@/components/libera/markdown-status-bar";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { MarkdownDisplayZoom } from "@/components/libera/markdown-display-zoom";
import { TiptapEditorActions } from "@/components/libera/tiptap-editor-actions";
import { MarkdownLinkInput } from "./markdown-link-input";
import type { LiberaFileNode, MarkdownImageAssetPayload } from "@/lib/types";

type Props = {
  files?: LiberaFileNode[];
  documentPath: string;
  untitled?: boolean;
  mathMarkers?: MathMarkerSettings;
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
};

type MathDraft = { latex: string; display: boolean; from: number; to: number; existing: boolean };
const buttonClass = "rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground";
const selectClass = "rounded-md border border-border bg-card px-2 py-1.5 text-xs";
const VISUAL_SCROLL_OUTLINE_ANCHOR_PROGRESS = 0.6;
const isImage = (file: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);

function getVisualViewportViewState(
  editor: Editor,
  markdown: string,
  container: HTMLDivElement,
  headingOffsets: number[] | null,
): MarkdownTabViewState {
  const scrollState = { visualScrollLeft: container.scrollLeft, visualScrollTop: container.scrollTop };
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

export function TiptapMarkdownEditor({ files = [], mathMarkers, untitled = false, documentPath, value, fontFamily = "system-ui, sans-serif", fontSizePx, lineHeight, markdownZoom, initialViewState, onViewStateChange, onMarkdownZoomChange, onChange, onRegisterDraft, onSave, onOpenFileLink }: Props) {
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ href: string; label?: string; from: number; to: number } | null>(null);
  const [error, setError] = useState("");
  const [uploadCount, setUploadCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [wildcardMatches, setWildcardMatches] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const visualScrollFrameRef = useRef<number | null>(null);
  const headingIndexRef = useRef<{ markdown: string; offsets: number[] } | null>(null);
  const initialViewStateRef = useRef(initialViewState);
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
  const uploads = useRef(new Set<{ pos: number; controller: AbortController }>());
  const extensions = useMemo(() => {
    const [InlineMath, BlockMath] = createMathExtensions(mathMarkers);
    return [
    ...createMarkdownExtensions(documentPath),
    HighlightTool,
    TiptapFind,
    TiptapReview,
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
  ]; }, [documentPath, mathMarkers]);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "libera-tiptap", role: "textbox", "aria-label": "Visual Markdown editor", "aria-multiline": "true" },
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
        const markdown = event.clipboardData?.getData("text/markdown");
        // Keep native rich-text paste, while plain source (including Libera's
        // Copy as Markdown) is parsed into editable document content.
        if (!markdown && event.clipboardData?.getData("text/html")) return false;
        const text = markdown || event.clipboardData?.getData("text/plain");
        if (!text?.trim()) return false;
        const inserted = replaceTiptapRangeWithMarkdown(editor, view.state.selection, text);
        if (inserted) event.preventDefault();
        return inserted;
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

  const { read: readMarkdown, replace: replaceMarkdown, pending: pendingDraftRef } = useTiptapDraft(editor, value, lastValue, onChange, onRegisterDraft);
  useTiptapReview(editor, lastValue, readMarkdown, replaceMarkdown);

  useMarkdownHeadingIndex(value, (markdown, offsets) => {
    headingIndexRef.current = { markdown, offsets };
    // Catch up when background parsing finishes, but never apply positions
    // against newer, unpublished edits or an active IME composition.
    if (editor && !editor.isDestroyed && !pendingDraftRef.current && !editor.view.composing) {
      const container = scrollContainerRef.current;
      if (!container || markdown !== lastValue.current) return;
      const viewState = getVisualViewportViewState(editor, markdown, container, offsets);
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
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"),
    bulletList: current.isActive("bulletList"), orderedList: current.isActive("orderedList"),
    blockquote: current.isActive("blockquote"), codeBlock: current.isActive("codeBlock"),
    boxColor: current.isActive("blockquote") ? current.getAttributes("blockquote").color ?? "default" : "",
    highlightTool: highlightToolKey.getState(current.state) ?? defaultHighlightToolState,
    // Subscribe only to UI data, never a DecorationSet containing document nodes.
    find: (() => {
      const find = tiptapFindPluginKey.getState(current.state);
      return find ? { matches: find.matches, activeMatchIndex: find.activeMatchIndex } : undefined;
    })(),
    heading: current.isActive("heading") ? String(current.getAttributes("heading").level) : "0",
    fontSize: current.getAttributes("textStyle").fontSize ?? "",
    lineHeight: current.getAttributes("textStyle").lineHeight ?? "",
    color: current.getAttributes("textStyle").color ?? "",
    undo: current.can().undo(), redo: current.can().redo(),
    } : null;
  } });

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) return;
    // TipTap renders asynchronously. Restore after EditorContent mounts, once
    // per editor mount, so scrolling and edits never reapply an old position.
    container.scrollLeft = initialViewStateRef.current?.visualScrollLeft ?? 0;
    container.scrollTop = initialViewStateRef.current?.visualScrollTop ?? 0;
    const frame = window.requestAnimationFrame(() => {
      if (visualScrollFrameRef.current === frame) visualScrollFrameRef.current = null;
      if (!editor.isDestroyed) {
        const markdown = lastValue.current;
        const viewState = getVisualViewportViewState(
          editor,
          markdown,
          container,
          headingIndexRef.current?.markdown === markdown ? headingIndexRef.current.offsets : null,
        );
        lastReportedLineRef.current = viewState.line ?? null;
        onViewStateChange?.(viewState);
      }
    });
    visualScrollFrameRef.current = frame;
    return () => {
      // A tab/mode switch can unmount before the next scroll frame runs.
      onViewStateChange?.({ visualScrollLeft: container.scrollLeft, visualScrollTop: container.scrollTop });
      window.cancelAnimationFrame(frame);
      if (visualScrollFrameRef.current === frame) visualScrollFrameRef.current = null;
    };
  }, [editor, onViewStateChange]);

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
      navigateTiptapToMarkdownHeading(editor!, detail.markdown, detail.offset);
      // Explicit outline navigation should report its destination immediately.
      reportVisualPosition(editor!, detail.markdown, editor!.state.selection.from);
    }
    window.addEventListener(MARKDOWN_OUTLINE_NAVIGATE_EVENT, navigate);
    return () => window.removeEventListener(MARKDOWN_OUTLINE_NAVIGATE_EVENT, navigate);
  }, [documentPath, editor, readMarkdown, reportVisualPosition]);

  function scheduleVisualPosition(current: Editor) {
    if (!onViewStateChange) return;
    if (visualPositionTimerRef.current !== null) clearTimeout(visualPositionTimerRef.current);
    visualPositionTimerRef.current = setTimeout(() => {
      visualPositionTimerRef.current = null;
      if (current.isDestroyed) return;
      if (current.view.composing) { scheduleVisualPosition(current); return; }
      reportVisualPosition(current, readMarkdown(), current.state.selection.from);
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
      if (pendingDraftRef.current) {
        onViewStateChange?.({ visualScrollLeft: container.scrollLeft, visualScrollTop: container.scrollTop });
        return;
      }
      const markdown = lastValue.current;
      const viewState = getVisualViewportViewState(
        currentEditor,
        markdown,
        container,
        headingIndexRef.current?.markdown === markdown ? headingIndexRef.current.offsets : null,
      );
      lastReportedLineRef.current = viewState.line ?? null;
      onViewStateChange?.(viewState);
    });
  }

  async function insertImages(files: File[], pos: number) {
    if (!editor || editor.isDestroyed) return;
    const images = files.filter(isImage);
    if (!images.length) { setError("Choose a PNG, JPEG, GIF, or WebP image."); return; }
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
              reader.onerror = () => reject(new Error("Could not read image."));
              reader.readAsDataURL(file);
            }) }
          : await apiRequest<MarkdownImageAssetPayload>("/api/markdown-assets", { method: "POST", body: formData, signal: upload.controller.signal });
        if (editor.isDestroyed || upload.controller.signal.aborted) return;
        // The position is mapped through edits made while the upload is pending.
        editor.chain().insertContentAt(upload.pos, { type: "image", attrs: { src: payload.assetPath, alt: file.name.replace(/\.[^.]+$/, "") } }).run();
      }
    } catch (cause) {
      if (!upload.controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not insert image.");
    } finally {
      uploads.current.delete(upload);
      if (!editor.isDestroyed) setUploadCount((count) => count - 1);
    }
  }

  const mathPreview = useMemo(() => {
    if (!mathDraft?.latex.trim()) return { html: "", error: "Enter a LaTeX expression." };
    try {
      return { html: katex.renderToString(mathDraft.latex, { displayMode: mathDraft.display, throwOnError: true, trust: false }), error: "" };
    } catch (cause) {
      return { html: "", error: cause instanceof Error ? cause.message : "Invalid equation." };
    }
  }, [mathDraft]);

  if (!editor || !state) return <div className="p-6 text-sm text-muted-foreground">Loading visual editor…</div>;

  function scrollToActiveFindMatch() {
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
    editor.commands.setTextSelection(match);
    updateTiptapFind(editor, { activeMatchIndex: normalizedIndex });
    scrollToActiveFindMatch();
  }

  function openFind() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, "\n", "\n");
    const query = selectedText && !selectedText.includes("\n") ? selectedText : findQuery;
    setFindOpen(true);
    if (query !== findQuery) setFindQuery(query);
    updateTiptapFind(editor, { query, wildcards: wildcardMatches, activeMatchIndex: 0 });
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
      scrollToActiveFindMatch();
    });
  }

  function closeFind() {
    if (!editor) return;
    const container = scrollContainerRef.current;
    const scrollLeft = container?.scrollLeft ?? 0;
    const scrollTop = container?.scrollTop ?? 0;
    setFindOpen(false);
    updateTiptapFind(editor, { query: "", activeMatchIndex: 0 });
    editor.commands.focus(undefined, { scrollIntoView: false });
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollLeft = scrollLeft;
      container.scrollTop = scrollTop;
    });
  }

  function updateFindQuery(query: string) {
    if (!editor) return;
    setFindQuery(query);
    updateTiptapFind(editor, { query, wildcards: wildcardMatches, activeMatchIndex: 0 });
    if (query) scrollToActiveFindMatch();
  }

  function updateWildcardMatches(enabled: boolean) {
    if (!editor) return;
    setWildcardMatches(enabled);
    updateTiptapFind(editor, { query: findQuery, wildcards: enabled, activeMatchIndex: 0 });
    if (findQuery) scrollToActiveFindMatch();
  }

  function replaceMatches(replaceAll: boolean) {
    if (!editor) return;
    const find = tiptapFindPluginKey.getState(editor.state);
    if (!find?.matches.length) return;
    const matches = replaceAll ? find.matches : [find.matches[find.activeMatchIndex]];
    let transaction = editor.state.tr;
    for (const match of matches.toReversed()) {
      transaction = transaction.insertText(replaceQuery, match.from, match.to);
    }
    transaction.setMeta(tiptapFindPluginKey, { activeMatchIndex: 0 });
    editor.view.dispatch(transaction);
    if (!replaceAll) {
      const nextFind = tiptapFindPluginKey.getState(editor.state);
      const nextOffset = matches[0].from + replaceQuery.length;
      const followingIndex = nextFind?.matches.findIndex((match) => match.from >= nextOffset) ?? -1;
      updateTiptapFind(editor, { activeMatchIndex: followingIndex < 0 ? 0 : followingIndex });
    }
    scrollToActiveFindMatch();
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!editor) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const activeMatchIndex = tiptapFindPluginKey.getState(editor.state)?.activeMatchIndex ?? 0;
      selectFindMatch(activeMatchIndex + (event.shiftKey ? -1 : 1));
    }
  }

  function handleReplaceKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      replaceMatches(false);
    }
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
  const currentFindMatchNumber = findMatches.length
    ? (state.find?.activeMatchIndex ?? 0) + 1
    : 0;

  return (
    <div className="libera-visual-editor flex min-h-0 min-w-0 flex-1 flex-col bg-card" onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === "Escape" && state.highlightTool.active) editor.commands.setHighlightToolActive(false);
    }}>
      <div aria-label="Visual editor formatting" role="toolbar" tabIndex={0}
        className="libera-editor-toolbar flex min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-border px-3 py-1.5 [scrollbar-width:thin] [&>*]:shrink-0">
        <select aria-label="Text style" className={selectClass} value={state.heading} onChange={(event) => {
          const level = Number(event.target.value) as 1 | 2 | 3 | 4 | 5 | 6;
          if (level) editor.chain().focus().setHeading({ level }).run(); else editor.chain().focus().setParagraph().run();
        }}>
          <option value="0">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>Heading {level}</option>)}
        </select>
        <select aria-label="Font size" className={selectClass} value={state.fontSize} onChange={(event) => event.target.value ? editor.chain().focus().setFontSize(event.target.value).run() : editor.chain().focus().unsetFontSize().run()}>
          <option value="">Font size</option>
          {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map((size) => <option key={size} value={`${size}px`}>{size} px</option>)}
        </select>
        <select aria-label="Line spacing" className={selectClass} value={state.lineHeight} onChange={(event) => {
          const chain = editor.chain().focus();
          // Without a selection, format the current paragraph's text.
          if (editor.state.selection.empty) {
            const { $from } = editor.state.selection;
            chain.setTextSelection({ from: $from.start(), to: $from.end() });
          }
          if (event.target.value) chain.setLineHeight(event.target.value).run(); else chain.unsetLineHeight().run();
        }}>
          <option value="">Line spacing</option>
          {[1, 1.15, 1.5, 1.75, 2, 2.5, 3].map((spacing) => <option key={spacing} value={spacing}>{spacing}×</option>)}
        </select>
        <TiptapEditorActions editor={editor} documentPath={documentPath} onError={setError} />
        {[
          { title: "Bold", icon: Bold, active: state.bold, run: () => editor.chain().focus().toggleBold().run() },
          { title: "Italic", icon: Italic, active: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
          { title: "Underline", icon: Underline, active: state.underline, run: () => editor.chain().focus().toggleUnderline().run() },
          { title: "Highlight", icon: Highlighter, active: state.highlightTool.active, run: () => editor.chain().focus().setHighlightToolActive(!state.highlightTool.active).run() },
        ].map(({ title, icon: Icon, active, run }) => <button key={title} type="button" title={title} aria-label={title} aria-pressed={active} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></button>)}
        <select aria-label="Highlight color" className={selectClass} value={state.highlightTool.color} onChange={(event) => editor.commands.setHighlightToolColor(event.target.value)}>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => <option key={color.value} value={color.value}>{color.label} highlight</option>)}
        </select>
        {[
          { title: "Bullet list", icon: List, active: state.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
          { title: "Numbered list", icon: ListOrdered, active: state.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
          { title: "Quote", icon: Quote, active: state.blockquote, run: () => editor.chain().focus().toggleBlockquote().run() },
          { title: "Code block", icon: Code2, active: state.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
        ].map(({ title, icon: Icon, active, run }) => <button key={title} type="button" title={title} aria-label={title} aria-pressed={active} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></button>)}
        <select aria-label="Box color" className={selectClass} value={state.boxColor} onChange={(event) => {
          const chain = editor.chain().focus();
          const color = event.target.value === "default" ? null : event.target.value;
          if (state.blockquote) chain.updateAttributes("blockquote", { color }).run();
          else chain.wrapIn("blockquote", { color }).run();
        }}>
          <option value="" disabled>Box color</option>
          <option value="default">Default grey box</option>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => <option key={color.shortcut} value={color.shortcut}>{color.label} box</option>)}
        </select>
        <select aria-label="Text color" className={selectClass} value={state.color} onChange={(event) => event.target.value ? editor.chain().focus().setColor(event.target.value).run() : editor.chain().focus().unsetColor().run()}>
          <option value="">Text color</option>
          {MARKDOWN_TEXT_COLORS.map((color) => <option key={color.value} value={color.value}>{color.label}</option>)}
        </select>
        <button type="button" aria-label="Insert or edit link" title="Insert or edit link" className={buttonClass} onClick={() => setLinkDraft({ href: editor.getAttributes("link").href ?? "", from: editor.state.selection.from, to: editor.state.selection.to })}><Link2 className="h-4 w-4" /></button>
        <button type="button" aria-label="Insert image" title="Insert image (or drop/paste a photo)" className={buttonClass} onClick={() => imageInput.current?.click()}><ImagePlus className="h-4 w-4" /></button>
        <button type="button" aria-label="Insert or edit equation" title="Insert or edit equation" className={buttonClass} onClick={openMath}><Sigma className="h-4 w-4" /></button>
        <button type="button" aria-label="Clear formatting" title="Clear formatting" className={buttonClass} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting className="h-4 w-4" /></button>
        <button type="button" aria-label="Undo" title="Undo" disabled={!state.undo} className={buttonClass} onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-4 w-4" /></button>
        <button type="button" aria-label="Redo" title="Redo" disabled={!state.redo} className={buttonClass} onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-4 w-4" /></button>
        <button type="button" aria-label="Save document" title="Save document" className={buttonClass} onClick={() => { readMarkdown(); void onSave(); }}><Save className="h-4 w-4" /></button>
        <button type="button" aria-label="Fix ChatGPT equations" title="Fix ChatGPT equations" className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={fixChatGptEquations}><Sparkles aria-hidden className="h-4 w-4" /></button>
        <LatexExportButton documentPath={documentPath} getMarkdown={() => editor.getMarkdown()} />
        <MarkdownDisplayZoom markdownBaseFontSize={fontSizePx / (markdownZoom / 100)} markdownZoom={markdownZoom} onMarkdownZoomChange={onMarkdownZoomChange} />
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" aria-label="Choose images" onChange={(event) => { void insertImages(Array.from(event.target.files ?? []), editor.state.selection.from); event.target.value = ""; }} />
      </div>
      {error ? <div role="alert" className="flex items-center justify-between bg-destructive-muted px-4 py-2 text-sm text-destructive">{error}<button type="button" onClick={() => setError("")}>Dismiss</button></div> : null}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollContainerRef} className={`libera-visual-page h-full overflow-auto p-6 ${dragging ? "ring-2 ring-inset ring-primary" : ""}`} style={{ fontFamily, fontSize: fontSizePx, lineHeight }}
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
          <EditorContent editor={editor} />
        </div>
        {findOpen ? (
          <div className="absolute right-3 top-3 z-20 flex w-[30rem] max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
            <div className="flex min-w-0 items-center gap-1">
              <Search aria-hidden className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
              <input ref={findInputRef} aria-label="Find in note" className="h-8 min-w-24 flex-1 border-0 px-1 text-sm outline-none"
                value={findQuery} placeholder="Find in note" onChange={(event) => updateFindQuery(event.target.value)} onKeyDown={handleFindKeyDown} />
              <span className="min-w-16 text-center text-xs text-muted-foreground">
                {findQuery ? `${currentFindMatchNumber}/${findMatches.length}` : "0/0"}
              </span>
              <button type="button" aria-label="Previous match" title="Previous match" disabled={!findMatches.length}
                className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => selectFindMatch((state.find?.activeMatchIndex ?? 0) - 1)}>
                <ChevronUp aria-hidden className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Next match" title="Next match" disabled={!findMatches.length}
                className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => selectFindMatch((state.find?.activeMatchIndex ?? 0) + 1)}>
                <ChevronDown aria-hidden className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Close find" title="Close" className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted" onClick={closeFind}>
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-1 pl-7">
              <input aria-label="Replace with" className="h-8 min-w-20 flex-1 rounded border border-border bg-background px-2 text-sm outline-none"
                value={replaceQuery} placeholder="Replace with" onChange={(event) => setReplaceQuery(event.target.value)} onKeyDown={handleReplaceKeyDown} />
              <button type="button" className="h-8 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40" disabled={!findMatches.length} onClick={() => replaceMatches(false)}>Replace</button>
              <button type="button" className="h-8 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40" disabled={!findMatches.length} onClick={() => replaceMatches(true)}>Replace all</button>
              <label className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground" title="Use * for any text and ? for one character">
                <input type="checkbox" aria-label="Wildcard matches" checked={wildcardMatches} onChange={(event) => updateWildcardMatches(event.target.checked)} />
                Wildcards
              </label>
            </div>
          </div>
        ) : null}
      </div>
      <MarkdownStatusBar content={value} uploading={uploadCount > 0} />
      <ModalDialog open={!!mathDraft} title={mathDraft?.existing ? "Edit equation" : "Insert equation"} description="Write LaTeX without the surrounding equation markers." panelClassName="max-w-xl" onClose={() => setMathDraft(null)} footer={<>
        <button type="button" className={selectClass} onClick={() => setMathDraft(null)}>Cancel</button>
        <button type="button" disabled={!!mathPreview.error} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" onClick={() => {
          if (!mathDraft) return;
          const type = mathDraft.display ? "blockMath" : "inlineMath";
          const original = mathDraft.existing ? editor.state.doc.nodeAt(mathDraft.from) : null;
          editor.chain().focus().insertContentAt({ from: mathDraft.from, to: mathDraft.to }, { type, attrs: { ...(original?.type.name === type ? original.attrs : {}), latex: mathDraft.latex.trim() } }).run();
          setMathDraft(null);
        }}>Apply equation</button>
      </>}>
        <textarea autoFocus aria-label="LaTeX equation" className="min-h-28 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" value={mathDraft?.latex ?? ""} onChange={(event) => setMathDraft((current) => current ? { ...current, latex: event.target.value } : null)} />
        <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={mathDraft?.display ?? false} onChange={(event) => setMathDraft((current) => current ? { ...current, display: event.target.checked } : null)} />Display equation on its own line</label>
        {mathPreview.error ? <p role="status" className="text-sm text-destructive">{mathPreview.error}</p> : <div aria-label="Equation preview" className="overflow-auto rounded-md bg-muted p-4" dangerouslySetInnerHTML={{ __html: mathPreview.html }} />}
      </ModalDialog>
      <ModalDialog open={!!linkDraft} title="Insert or edit link" onClose={() => setLinkDraft(null)} footer={<button type="button" className={selectClass} onClick={() => {
        if (!linkDraft) return;
        const chain = editor.chain().focus().setTextSelection({ from: linkDraft.from, to: linkDraft.to }).extendMarkRange("link");
        if (linkDraft.href.trim()) {
          if (linkDraft.from === linkDraft.to && !editor.isActive("link")) chain.insertContent({ type: "text", text: linkDraft.label ?? linkDraft.href.trim(), marks: [{ type: "link", attrs: { href: linkDraft.href.trim() } }] }).run();
          else chain.setLink({ href: linkDraft.href.trim() }).run();
        } else chain.unsetLink().run();
        setLinkDraft(null);
      }}>Apply link</button>}>
        <MarkdownLinkInput files={files} sourcePath={documentPath} value={linkDraft?.href ?? ""} onChange={(href, label) => setLinkDraft((current) => current ? { ...current, href, label } : null)} />
      </ModalDialog>
    </div>
  );
}
