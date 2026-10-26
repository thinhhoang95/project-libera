"use client";

import {
  changeSelectedHeadingLevels, getChangedTextRange, sourceClipboardContents, sourceDragKind,
  getDroppedImageFiles, SELECTION_CHANGE_DEBOUNCE_MS,
  SOURCE_EDITOR_LABEL, SOURCE_PANE_PADDING, SOURCE_SPELLCHECK, SOURCE_TAB_SIZE, sourcePasteEdit, sourcePasteMode, sourceFormatEdit, handleSourceKey, fileLinkPopupKey, refreshSourcePopupOnKeyUp,
  sourceFileLinkContext, sameFileLinkPopup, sourceHeadingLinkEdit, sourceCitationContext, sameCitationPopup, sourceCitationHit, sourceSelectionAfterChange,
  type FileLinkPopupContext, type CitationPopupContext, type HeadingLevelChangeDirection, type MarkdownFormat,
} from "@/lib/markdown-source";
export { changeSelectedHeadingLevels, findMarkdownImageInText, getChangedTextRange, getClipboardImageFiles, getDroppedImageFiles, hasImageDragItem, MARKDOWN_SHORTCUT_FORMATS, SOURCE_DRAFT_DELAY_MS } from "@/lib/markdown-source";
export type { HeadingLevelChangeDirection, MarkdownFormat } from "@/lib/markdown-source";

import { MarkdownSourceContextMenu, sourceContextMenuState, type SourceContextMenuState } from "./markdown-source/markdown-source-context-menu";
import { MarkdownSourceFindBar } from "./markdown-source/markdown-source-find-bar";
import type { MarkdownSourceEditorProps } from "./markdown-source/types";
import { useMarkdownSourceDraft } from "./markdown-source/use-markdown-source-draft";
import { useMarkdownSourceFind } from "./markdown-source/use-markdown-source-find";

import { beginAiActivity } from "@/lib/ai-activity";

import { useSourceReview } from "./use-editor-review";
import { speakMarkdown } from "@/lib/tts/player";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  UIEvent,
} from "react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MarkdownFileLinkPopup,
  MarkdownHeadingLinkPopup,
  buildMarkdownFileLinkSections,
  flattenMarkdownFileLinkSections,
} from "@/components/libera/markdown-file-link-popup";
import type {
  MarkdownFileLinkSelection,
} from "@/components/libera/types";
import {
  getTextareaClientPointForOffset,
  getTextareaOffsetAtPoint,
} from "@/lib/textarea-position";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { DOCUMENT_STYLE_REQUEST_EVENT, textChange, writeDocumentStyleForPath, type DocumentStyleRequestDetail } from "@/lib/references/document-style";
import {
  filterMarkdownHeadingAnchors,
  type MarkdownHeadingAnchor,
} from "@/lib/markdown-heading-anchors";
import {
  createMarkdownEditorLineIndex,
} from "@/lib/markdown-editor-highlighting";
import type {
  MarkdownEditorCachedLine,
  MarkdownEditorLineTone,
} from "@/lib/markdown-editor-highlighting";
import type { TextMatch } from "@/lib/text-find";
import type { SmartPasteMode } from "@/lib/markdown-smart-paste";
import {
  applyTextChanges,
  detectMarkdownHeadingNumbering,
  getMarkdownHeadingNumberingChanges,
  mapOffsetThroughTextChanges,
} from "@/lib/markdown-heading-numbering";
import { useHeadingNumbering } from "@/components/libera/heading-numbering-state";
import { readClipboardText, type ClipboardText, type MenuPasteMode } from "@/components/libera/paste-menu-items";
import { citationAt } from "@/lib/references/citation-syntax";
import { citationInsertion, narrativeInsertionAllowed } from "@/lib/references/reference-suggestions";
import {
  CitationPopup,
  openCitationAttachment,
  useEditorCitationHover,
  type CitationPopupHandle,
} from "@/components/libera/references/citation-popup";
import { referenceKeyResolver, useReferenceRender } from "@/components/libera/references/reference-render-context";
import { droppedQuoteMarkdown, hasPdfQuoteDrag, pdfQuoteFromDrop } from "@/components/libera/references/pdf-quote-cite";
import { quoteBlockInsertion, type PdfQuoteSource } from "@/lib/references/pdf-quote";

type MarkdownEditorProps = Omit<MarkdownSourceEditorProps, "extensions" | "documentSource" | "onViewChange">;

const EMPTY_EDITOR_LINE = "\u200b";
const FIND_MATCH_CLASS_NAME = "markdown-editor-find-match";
const ACTIVE_FIND_MATCH_CLASS_NAME = "markdown-editor-find-match-active";

type HighlightChunk = {
  className?: string;
  text: string;
};

function getHighlightClassName(tone: MarkdownEditorLineTone | undefined) {
  return tone ? `markdown-editor-highlight-tone-${tone}` : undefined;
}

function appendHighlightChunk(
  chunks: HighlightChunk[],
  className: string | undefined,
  text: string,
) {
  if (!text) {
    return;
  }

  const previousChunk = chunks.at(-1);

  if (previousChunk && previousChunk.className === className) {
    previousChunk.text += text;
    return;
  }

  chunks.push({ className, text });
}

function getFindMatchClassName(
  baseClassName: string | undefined,
  matchIndex: number,
  activeMatchIndex: number,
) {
  return [
    baseClassName,
    FIND_MATCH_CLASS_NAME,
    matchIndex === activeMatchIndex ? ACTIVE_FIND_MATCH_CLASS_NAME : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function appendTextWithFindMatches({
  activeMatchIndex,
  baseClassName,
  chunks,
  matchCursor,
  matches,
  sourceStart,
  text,
}: {
  activeMatchIndex: number;
  baseClassName: string | undefined;
  chunks: HighlightChunk[];
  matchCursor: { index: number };
  matches: TextMatch[];
  sourceStart: number;
  text: string;
}) {
  const sourceEnd = sourceStart + text.length;
  let textIndex = 0;

  while (
    matchCursor.index < matches.length &&
    matches[matchCursor.index].end <= sourceStart
  ) {
    matchCursor.index += 1;
  }

  let currentMatchIndex = matchCursor.index;

  while (currentMatchIndex < matches.length) {
    const match = matches[currentMatchIndex];

    if (match.start >= sourceEnd) {
      break;
    }

    const matchStartInText = Math.max(0, match.start - sourceStart);
    const matchEndInText = Math.min(text.length, match.end - sourceStart);

    if (textIndex < matchStartInText) {
      appendHighlightChunk(chunks, baseClassName, text.slice(textIndex, matchStartInText));
    }

    if (matchEndInText > matchStartInText) {
      appendHighlightChunk(
        chunks,
        getFindMatchClassName(baseClassName, currentMatchIndex, activeMatchIndex),
        text.slice(matchStartInText, matchEndInText),
      );
      textIndex = matchEndInText;
    }

    if (match.end > sourceEnd) {
      break;
    }

    currentMatchIndex += 1;
    matchCursor.index = currentMatchIndex;
  }

  if (textIndex < text.length) {
    appendHighlightChunk(chunks, baseClassName, text.slice(textIndex));
  }
}

const plainLineChunks = new WeakMap<MarkdownEditorCachedLine, Map<boolean, HighlightChunk[]>>();

function renderHighlightedMarkdown(
  lines: MarkdownEditorCachedLine[],
  matches: TextMatch[] = [],
  activeMatchIndex = 0,
  reviewRanges: { start: number; end: number }[] = [],
) {
  const matchCursor = { index: 0 };
  const normalizedActiveMatchIndex = matches.length
    ? (activeMatchIndex + matches.length) % matches.length
    : -1;
  let lineOffset = 0;
  const ranges = reviewRanges.slice().sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  let reviewIndex = 0;

  return lines.map((entry, index) => {
    const line = entry.text;
    while (reviewIndex < merged.length && merged[reviewIndex].end <= lineOffset) reviewIndex++;
    const reviewed = merged[reviewIndex]?.start < lineOffset + line.length;
    const lineClassName = [getHighlightClassName(entry.tone), reviewed ? "review-source-highlight" : ""].filter(Boolean).join(" ");
    const hasTrailingNewline = index < lines.length - 1;
    const plain = !matches.length && !reviewed;
    const cached = plain ? plainLineChunks.get(entry)?.get(hasTrailingNewline) : undefined;
    if (cached) {
      lineOffset += line.length + (hasTrailingNewline ? 1 : 0);
      return cached;
    }
    const chunks: HighlightChunk[] = [];

    if (line) {
      appendTextWithFindMatches({
        activeMatchIndex: normalizedActiveMatchIndex,
        baseClassName: lineClassName,
        chunks,
        matchCursor,
        matches,
        sourceStart: lineOffset,
        text: line,
      });
    } else {
      appendHighlightChunk(chunks, lineClassName, EMPTY_EDITOR_LINE);
    }

    if (hasTrailingNewline) {
      appendTextWithFindMatches({
        activeMatchIndex: normalizedActiveMatchIndex,
        baseClassName: lineClassName,
        chunks,
        matchCursor,
        matches,
        sourceStart: lineOffset + line.length,
        text: "\n",
      });
    }

    lineOffset += line.length + (hasTrailingNewline ? 1 : 0);
    if (plain) {
      const cache = plainLineChunks.get(entry) ?? new Map();
      cache.set(hasTrailingNewline, chunks);
      plainLineChunks.set(entry, cache);
    }
    return chunks;
  });
}

export function MarkdownEditor({
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
  textareaRef,
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
}: MarkdownEditorProps) {
  const [editorValue, setEditorValue] = useState(value);
  const [initialValue] = useState(value);
  const [contextMenu, setContextMenu] = useState<SourceContextMenuState | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const [fileLinkPopup, setFileLinkPopup] = useState<FileLinkPopupContext | null>(null);
  const [activeFileLinkIndex, setActiveFileLinkIndex] = useState(0);
  const highlightLayerRef = useRef<HTMLPreElement>(null);
  const editorValueRef = useRef(value);
  const highlightedLinesRef = useRef<HighlightChunk[][]>([]);
  const highlightIndexRef = useRef<ReturnType<typeof createMarkdownEditorLineIndex> | null>(null);
  highlightIndexRef.current ??= createMarkdownEditorLineIndex();
  const fileLinkPopupFrameRef = useRef<number | null>(null);
  const fileLinkPopupRef = useRef<FileLinkPopupContext | null>(null);
  // The `@` citation popup, refreshed in the file-link popup's frame.
  const [citationPopup, setCitationPopup] = useState<CitationPopupContext | null>(null);
  const citationPopupRef = useRef<CitationPopupContext | null>(null);
  /** The `@key` the popup just inserted: it must not reopen the popup. */
  const citationInsertedRef = useRef<{ from: number; query: string } | null>(null);
  const citationPopupHandleRef = useRef<CitationPopupHandle>(null);
  const referenceRender = useReferenceRender();
  const citationHover = useEditorCitationHover();
  const composingRef = useRef(false);
  const headingNumbering = useHeadingNumbering(activeFilePath, () => detectMarkdownHeadingNumbering(value));
  const headingNumberingRef = useRef(headingNumbering);
  const renumberingRef = useRef(false);
  // Switching numbering on (or changing its title setting) renumbers now;
  // opening a document never edits it.
  useEffect(() => {
    const previous = headingNumberingRef.current;
    headingNumberingRef.current = headingNumbering;
    if (previous === headingNumbering || !headingNumbering.enabled) return;
    const textarea = textareaRef.current;
    if (textarea) renumberHeadings(textarea, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on settings changes only
  }, [headingNumbering]);
  const previousActiveFilePathRef = useRef(activeFilePath);
  const selectionChangeTimeoutRef = useRef<number | null>(null);
  const selectionCallbackRef = useRef(onSelectionChange);
  useLayoutEffect(() => { selectionCallbackRef.current = onSelectionChange; }, [onSelectionChange]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    return () => {
      if (textarea) selectionCallbackRef.current?.({ start: textarea.selectionStart, end: textarea.selectionEnd });
    };
  }, [textareaRef]);

  const { readDraft, schedulePublish, lastPublishedRef, publishedDraftsRef, draftTimerRef } = useMarkdownSourceDraft(value, {
    readText: () => editorValueRef.current, isComposing: () => composingRef.current,
    onChange, onPublish: setEditorValue, onRegisterDraft,
  });
  const review = useSourceReview(textareaRef, (text) => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    lastPublishedRef.current = text;
    editorValueRef.current = text;
    if (textareaRef.current) textareaRef.current.value = text;
    setEditorValue(text);
  });
  const reviewEnabled = review?.enabled;
  const reviewDocument = review?.doc;
  const reviewSelection = review?.selection;
  const reviewRanges = useMemo(() => reviewEnabled ? [
    ...(reviewDocument?.threads.filter((t) => t.anchor.state === "attached" && t.status === "open").map((t) => t.anchor) ?? []),
    ...(reviewDocument?.session?.suggestions.filter((s) => s.status === "pending").flatMap((s) => s.edits) ?? []),
    ...(reviewSelection ? [reviewSelection.range] : []),
  ] : [], [reviewEnabled, reviewDocument, reviewSelection]);
  const aiWorking = formatting || imageConverting;
  useEffect(() => (aiWorking ? beginAiActivity() : undefined), [aiWorking]);
  const find = useMarkdownSourceFind({
    text: editorValue, textareaRef, readText: () => editorValueRef.current, updateText: setEditorValue,
    commitText: commitEditorValue, readDraft, closeContextMenu: () => setContextMenu(null), syncScroll: syncHighlightLayerScroll,
  });
  const { open: findOpen, query: findQuery, wildcards: wildcardMatches, active: activeMatchIndex, matches: textMatches, findMatches } = find;
  const refreshHighlightLayer = useCallback(() => {
    // This layer is intentionally owned by the input handler, not React.
    // Stable line nodes isolate layout and avoid allocating thousands of React
    // elements (and periodic garbage-collection pauses) for each character.
    const layer = highlightLayerRef.current;
    if (!layer) return;
    const text = editorValueRef.current;
    const matches = findOpen ? findMatches(text, findQuery, { wildcards: wildcardMatches }) : [];
    const next = renderHighlightedMarkdown(highlightIndexRef.current!.update(text), matches, activeMatchIndex, reviewRanges);
    const previous = highlightedLinesRef.current.slice();
    const equal = (old: HighlightChunk[] | undefined, chunks: HighlightChunk[]) => old === chunks ||
      !!old && old.length === chunks.length && old.every((chunk, i) => chunk.text === chunks[i].text && chunk.className === chunks[i].className);
    // Splice the changed line interval, retaining the suffix's DOM nodes even
    // when a newline near the start shifts every subsequent line index.
    let prefix = 0, suffix = 0;
    while (prefix < previous.length && prefix < next.length && equal(previous[prefix], next[prefix])) prefix++;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && equal(previous[previous.length - 1 - suffix], next[next.length - 1 - suffix])) suffix++;
    const oldMiddle = previous.length - prefix - suffix;
    const newMiddle = next.length - prefix - suffix;
    if (oldMiddle > newMiddle) {
      for (let i = newMiddle; i < oldMiddle; i++) layer.children[prefix + newMiddle]?.remove();
      previous.splice(prefix + newMiddle, oldMiddle - newMiddle);
    } else if (newMiddle > oldMiddle) {
      const before = layer.children[prefix + oldMiddle] ?? null;
      for (let i = oldMiddle; i < newMiddle; i++) {
        layer.insertBefore(document.createElement("span"), before);
        previous.splice(prefix + i, 0, []);
      }
    }
    const fragment = document.createDocumentFragment();
    next.forEach((chunks, index) => {
      const old = previous[index];
      if (equal(old, chunks)) return;
      const line = layer.children[index] ?? document.createElement("span");
      line.className = "markdown-editor-highlight-line";
      line.replaceChildren(...chunks.map((chunk) => {
        const span = document.createElement("span");
        span.className = chunk.className ?? "";
        span.textContent = chunk.text;
        return span;
      }));
      if (!line.parentNode) fragment.appendChild(line);
    });
    if (fragment.childNodes.length) layer.appendChild(fragment);
    while (layer.children.length > next.length) layer.lastElementChild!.remove();
    highlightedLinesRef.current = next;
    // The gutter width tracks the digit count of the last line number.
    const digits = String(Math.max(next.length, 1)).length;
    if (layer.parentElement && layer.parentElement.dataset.lineDigits !== String(digits)) {
      layer.parentElement.dataset.lineDigits = String(digits);
      layer.parentElement.style.setProperty("--markdown-line-digits", String(Math.max(digits, 2)));
    }
    const textarea = textareaRef.current;
    if (textarea) { layer.scrollTop = textarea.scrollTop; layer.scrollLeft = textarea.scrollLeft; }
  }, [activeMatchIndex, findOpen, findQuery, wildcardMatches, reviewRanges, textareaRef, findMatches]);
  const headingLinkOptions = useMemo(
    () =>
      fileLinkPopup?.headings
        ? filterMarkdownHeadingAnchors(fileLinkPopup.headings, fileLinkPopup.query)
        : null,
    [fileLinkPopup],
  );
  const fileLinkSections = useMemo(
    () =>
      fileLinkPopup && !fileLinkPopup.headings
        ? buildMarkdownFileLinkSections({
            activeFilePath,
            files,
            openTabs: readOpenTabs?.() ?? openTabs ?? [],
            query: fileLinkPopup.query,
            recentFiles,
          })
        : [],
    [activeFilePath, fileLinkPopup, files, openTabs, readOpenTabs, recentFiles],
  );
  const fileLinkOptions = useMemo(
    () => flattenMarkdownFileLinkSections(fileLinkSections),
    [fileLinkSections],
  );
  const linkOptionCount = headingLinkOptions ? headingLinkOptions.length : fileLinkOptions.length;
  const selectedFileLinkIndex = linkOptionCount
    ? Math.min(activeFileLinkIndex, linkOptionCount - 1)
    : 0;
  useLayoutEffect(() => {
    const fileChanged = previousActiveFilePathRef.current !== activeFilePath;
    previousActiveFilePathRef.current = activeFilePath;
    const echoIndex = publishedDraftsRef.current.indexOf(value);
    if (!fileChanged && echoIndex >= 0) {
      // A delayed parent echo must never replace characters typed since publish.
      publishedDraftsRef.current.splice(0, echoIndex + 1);
      return;
    }
    publishedDraftsRef.current = [];
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    lastPublishedRef.current = value;
    if (fileChanged || value !== editorValueRef.current) {
      editorValueRef.current = value;
      if (textareaRef.current) textareaRef.current.value = value;
      setEditorValue(value);
    }
  }, [activeFilePath, value, textareaRef, draftTimerRef, lastPublishedRef, publishedDraftsRef]);

  useLayoutEffect(() => { refreshHighlightLayer(); }, [editorValue, refreshHighlightLayer]);

  useEffect(() => {
    fileLinkPopupRef.current = fileLinkPopup;
  }, [fileLinkPopup]);

  useEffect(() => {
    return () => {
      if (fileLinkPopupFrameRef.current !== null) {
        window.cancelAnimationFrame(fileLinkPopupFrameRef.current);
      }

      if (selectionChangeTimeoutRef.current !== null) {
        window.clearTimeout(selectionChangeTimeoutRef.current);
      }
    };
  }, []);

  const getFileLinkPopupContext = useCallback(
    (
      textarea: HTMLTextAreaElement,
      nextValue = editorValueRef.current,
    ): FileLinkPopupContext | null => {
      return sourceFileLinkContext(nextValue, textarea.selectionStart, textarea.selectionEnd, fileLinkPopupRef.current,
        () => getTextareaClientPointForOffset(textarea, textarea.selectionStart));
    },
    [],
  );

  const refreshFileLinkPopup = useCallback(
    (textarea: HTMLTextAreaElement, nextValue = editorValueRef.current) => {
      const nextPopup = getFileLinkPopupContext(textarea, nextValue);
      const currentPopup = fileLinkPopupRef.current;

      if (nextPopup?.query !== currentPopup?.query) {
        setActiveFileLinkIndex(0);
      }

      if (sameFileLinkPopup(currentPopup, nextPopup)) {
        return;
      }

      fileLinkPopupRef.current = nextPopup;
      setFileLinkPopup(nextPopup);
    },
    [getFileLinkPopupContext],
  );

  const scheduleFileLinkPopupRefresh = useCallback(
    (textarea: HTMLTextAreaElement, nextValue = editorValueRef.current) => {
      if (fileLinkPopupFrameRef.current !== null) {
        window.cancelAnimationFrame(fileLinkPopupFrameRef.current);
      }

      fileLinkPopupFrameRef.current = window.requestAnimationFrame(() => {
        fileLinkPopupFrameRef.current = null;
        refreshFileLinkPopup(textarea, nextValue);
        refreshCitationPopupRef.current(textarea, nextValue);
      });
    },
    [refreshFileLinkPopup],
  );

  function closeFileLinkPopup() {
    if (fileLinkPopupFrameRef.current !== null) {
      window.cancelAnimationFrame(fileLinkPopupFrameRef.current);
      fileLinkPopupFrameRef.current = null;
    }

    fileLinkPopupRef.current = null;
    setFileLinkPopup(null);
    closeCitationPopup();
  }

  function closeCitationPopup() {
    if (!citationPopupRef.current) return;
    citationPopupRef.current = null;
    setCitationPopup(null);
  }

  /** Opens, moves or closes the citation popup for the caret. `citationTriggerAt`
   * analyses the whole document, so it only runs right after `@` and key characters. */
  function refreshCitationPopup(textarea: HTMLTextAreaElement, nextValue = editorValueRef.current) {
    const previous = citationPopupRef.current;
    const result = sourceCitationContext(nextValue, textarea.selectionStart, textarea.selectionEnd, {
      fileLinkOpen: !!fileLinkPopupRef.current, previous, inserted: citationInsertedRef.current, mathMarkers,
      resolves: referenceKeyResolver(referenceRender), point: (offset) => getTextareaClientPointForOffset(textarea, offset),
    });
    citationInsertedRef.current = result.inserted;
    if (sameCitationPopup(previous, result.popup)) return;
    citationPopupRef.current = result.popup;
    setCitationPopup(result.popup);
  }
  const refreshCitationPopupRef = useRef(refreshCitationPopup);
  useLayoutEffect(() => { refreshCitationPopupRef.current = refreshCitationPopup; });

  function insertCitation(key: string, { locator, narrative, pageLocator }: { locator: boolean; narrative?: boolean; pageLocator?: string }) {
    const textarea = textareaRef.current;
    const popup = citationPopupRef.current;
    if (!textarea || !popup) return;
    // `[@key]` replaces `@query`; inside a citation, or narrative (Shift+Enter), `@key` does.
    const insertion = citationInsertion(key, popup.insideCitation, locator, { narrative, before: popup.before, pageLocator });
    citationInsertedRef.current = insertion.text.startsWith("@") ? { from: popup.from, query: key } : null;
    const currentValue = editorValueRef.current;
    const nextValue = `${currentValue.slice(0, popup.from)}${insertion.text}${currentValue.slice(popup.to)}`;
    const caret = popup.from + insertion.caret;
    closeCitationPopup();
    if (!replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: popup.from,
      selectionEnd: popup.to,
      replacement: insertion.text,
      nextSelectionStart: caret,
      nextSelectionEnd: caret,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    })) {
      commitEditorValue(textarea, nextValue);
    }
    readDraft();
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(caret, caret);
      emitSelectionChange(nextTextarea);
      syncHighlightLayerScroll(nextTextarea);
    });
  }

  /** The citation under the pointer, for the hover card and Ctrl/Cmd+click. */
  function citationAtPointer(textarea: HTMLTextAreaElement, clientX: number, clientY: number) {
    const text = editorValueRef.current;
    if (!text.includes("@")) return null;
    const offset = getTextareaOffsetAtPoint(textarea, clientX, clientY);
    return sourceCitationHit(offset, clientX, (at) => citationAt(text, at, { mathMarkers }),
      (at) => getTextareaClientPointForOffset(textarea, at), referenceKeyResolver(referenceRender));
  }

  function handleCitationPointer(event: MouseEvent<HTMLTextAreaElement>) {
    const found = citationAtPointer(event.currentTarget, event.clientX, event.clientY);
    if (!found) {
      citationHover.show(null);
      return;
    }
    citationHover.show({
      citation: found.citation,
      rect: () => {
        const current = textareaRef.current;
        if (!current) return null;
        const start = getTextareaClientPointForOffset(current, found.start);
        const end = getTextareaClientPointForOffset(current, found.end);
        const left = start.y === end.y ? start.x : current.getBoundingClientRect().left;
        const right = start.y === end.y ? end.x : left + 1;
        return new DOMRect(left, start.y - lineHeightPx, Math.max(1, right - left), end.y - start.y + lineHeightPx);
      },
    });
  }

  /** The Document style control's request (references/document-style.ts): one undoable edit of the front matter. */
  function applyDocumentStyle(detail: DocumentStyleRequestDetail) {
    const textarea = textareaRef.current;
    if (!textarea || !activeFilePath || detail.path !== activeFilePath || detail.handled) return;
    detail.handled = true;
    // The textarea holds the latest text, even before React has seen its last input.
    const currentValue = textarea.value;
    const nextValue = writeDocumentStyleForPath(activeFilePath, currentValue, detail.style);
    if (nextValue === currentValue) return;
    const change = textChange(currentValue, nextValue);
    if (!replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: change.from,
      selectionEnd: change.to,
      replacement: change.insert,
      ...sourceSelectionAfterChange(textarea.selectionStart, textarea.selectionEnd, change),
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    })) {
      commitEditorValue(textarea, nextValue);
    }
    readDraft();
  }
  const applyDocumentStyleRef = useRef(applyDocumentStyle);
  useLayoutEffect(() => { applyDocumentStyleRef.current = applyDocumentStyle; });
  useEffect(() => {
    const onRequest = (event: Event) => applyDocumentStyleRef.current((event as CustomEvent<DocumentStyleRequestDetail>).detail);
    window.addEventListener(DOCUMENT_STYLE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(DOCUMENT_STYLE_REQUEST_EVENT, onRequest);
  }, []);

  function insertFileLink(selection: MarkdownFileLinkSelection) {
    const range = fileLinkPopup
      ? {
          start: fileLinkPopup.destinationStart,
          end: fileLinkPopup.destinationEnd,
        }
      : undefined;

    closeFileLinkPopup();
    onInsertFileLink(selection, range);
  }

  function insertHeadingLink(heading: MarkdownHeadingAnchor) {
    const popup = fileLinkPopup;
    const textarea = textareaRef.current;

    closeFileLinkPopup();

    if (!popup || !textarea) {
      return;
    }

    const value = editorValueRef.current;
    const edit = sourceHeadingLinkEdit(value, popup, heading);
    const { replacement, nextSelectionStart: caret } = edit;
    const usedNativeUndo = replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: popup.destinationStart,
      selectionEnd: popup.destinationEnd,
      replacement,
      nextSelectionStart: caret,
      nextSelectionEnd: caret,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    });

    if (!usedNativeUndo) {
      commitEditorValue(
        textarea,
        `${value.slice(0, popup.destinationStart)}${replacement}${value.slice(popup.destinationEnd)}`,
      );
      textarea.setSelectionRange(caret, caret);
    }
    readDraft();
    textarea.focus();
  }

  function openContextMenu(event: MouseEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setEditorValue(textarea.value);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    event.preventDefault();
    setContextMenu(sourceContextMenuState(editorValueRef.current, start, end, event.clientX, event.clientY));
  }

  function applyHeadingLevelChange(
    direction: HeadingLevelChangeDirection,
    selection?: { end: number; start: number },
  ) {
    const textarea = textareaRef.current;
    const currentValue = editorValueRef.current;
    const selectionStart = selection?.start ?? textarea?.selectionStart ?? 0;
    const selectionEnd = selection?.end ?? textarea?.selectionEnd ?? 0;
    const result = changeSelectedHeadingLevels(
      currentValue,
      selectionStart,
      selectionEnd,
      direction,
    );

    if (!result.hasHeading) {
      return false;
    }

    setContextMenu(null);
    closeFileLinkPopup();

    if (textarea && result.changed) {
      replaceTextareaSelectionWithUndo(textarea, {
        ...getChangedTextRange(currentValue, result.nextValue),
        nextSelectionEnd: result.nextEnd,
        nextSelectionStart: result.nextStart,
        scrollLeft: textarea.scrollLeft,
        scrollTop: textarea.scrollTop,
      });
      // Synchronize the editor's live draft even when the browser's native
      // insertText event is deferred. The value write is skipped after a
      // successful native edit, preserving its undo entry.
      commitEditorValue(textarea, result.nextValue);
      readDraft();
    }

    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(result.nextStart, result.nextEnd);
      emitSelectionChange(nextTextarea);
      syncHighlightLayerScroll(nextTextarea);
      scheduleFileLinkPopupRefresh(nextTextarea, result.nextValue);
    });

    return true;
  }

  function handleDragOver(event: DragEvent<HTMLTextAreaElement>) {
    const kind = sourceDragKind(event.dataTransfer, hasPdfQuoteDrag(event.dataTransfer));
    if (kind === "quote") {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      return;
    }

    if (kind !== "image") {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingImage(true);
  }

  function handleDragLeave() {
    setDraggingImage(false);
  }

  /** A quote dragged from a PDF: quote and cite it as a block at the drop point. */
  async function insertDroppedQuote(source: PdfQuoteSource, offset: number) {
    const markdown = await droppedQuoteMarkdown(source, referenceRender?.notebook ?? null);
    const textarea = textareaRef.current;
    if (!markdown || !textarea) return;
    const currentValue = editorValueRef.current;
    const insertion = quoteBlockInsertion(currentValue, offset, markdown);
    if (!replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: insertion.from,
      selectionEnd: insertion.from,
      replacement: insertion.text,
      nextSelectionStart: insertion.caret,
      nextSelectionEnd: insertion.caret,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    })) {
      commitEditorValue(textarea, insertion.value);
    }
    readDraft();
  }

  async function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    const quote = pdfQuoteFromDrop(event.dataTransfer);
    if (quote) {
      event.preventDefault();
      setDraggingImage(false);
      void insertDroppedQuote(quote, getTextareaOffsetAtPoint(event.currentTarget, event.clientX, event.clientY));
      return;
    }

    const imageFiles = getDroppedImageFiles(event.dataTransfer);

    if (!imageFiles.length) {
      setDraggingImage(false);
      return;
    }

    event.preventDefault();
    setDraggingImage(false);
    const textarea = event.currentTarget;
    const dropOffset = getTextareaOffsetAtPoint(textarea, event.clientX, event.clientY);
    textarea.focus();
    textarea.setSelectionRange(dropOffset, dropOffset);

    await onInsertImageFile(imageFiles[0], { start: dropOffset, end: dropOffset });
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const contents = sourceClipboardContents(event.clipboardData);

    if (contents.kind === "image") {
      event.preventDefault();
      setContextMenu(null);
      closeFileLinkPopup();

      const textarea = event.currentTarget;
      const selection = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };

      await onInsertImageFile(contents.image, selection);
      return;
    }

    const textarea = event.currentTarget;
    const pasted = pasteClipboardText(textarea, {
      end: textarea.selectionEnd,
      start: textarea.selectionStart,
    }, contents.clipboard, sourcePasteMode(smartPaste));

    if (pasted) event.preventDefault();
  }

  /** Paste clipboard text the way Ctrl+V does: rich HTML becomes Markdown and
   * Smart Paste places pasted headings. False leaves the paste to the browser
   * (unless `insertPlain`, used by the right-click menu, which has no browser
   * paste to fall back on). */
  function pasteClipboardText(
    textarea: HTMLTextAreaElement,
    { end: selectionEnd, start: selectionStart }: { end: number; start: number },
    clipboard: ClipboardText,
    smartMode: SmartPasteMode | false,
    insertPlain = false,
  ) {
    const currentValue = editorValueRef.current;
    const edit = sourcePasteEdit(currentValue, { start: selectionStart, end: selectionEnd }, clipboard, {
      mathMarkers, smartPaste: smartMode, insertPlain,
    });
    if (!edit) return false;
    setContextMenu(null);
    closeFileLinkPopup();

    const nextSelection = edit.nextSelectionStart;
    const nextValue = currentValue.slice(0, edit.selectionStart) + edit.replacement + currentValue.slice(edit.selectionEnd);

    if (!replaceTextareaSelectionWithUndo(textarea, {
      ...edit,
      nextSelectionEnd: nextSelection,
      nextSelectionStart: nextSelection,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    })) {
      commitEditorValue(textarea, nextValue);
      textarea.setSelectionRange(nextSelection, nextSelection);
    }

    readDraft();
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      emitSelectionChange(nextTextarea);
      syncHighlightLayerScroll(nextTextarea);
      scheduleFileLinkPopupRefresh(nextTextarea, editorValueRef.current);
    });
    return true;
  }

  async function pasteFromContextMenu(mode: MenuPasteMode) {
    const menu = contextMenu;
    setContextMenu(null);
    if (!menu) return;
    const clipboard = await readClipboardText();
    const textarea = textareaRef.current;
    if (!textarea) return;
    pasteClipboardText(
      textarea,
      { end: menu.end, start: menu.start },
      clipboard,
      sourcePasteMode(smartPaste, mode),
      true,
    );
  }

  /** Structural heading numbering: bring every heading's number in line with
   * the document, as its own undo step after the edit that changed it. */
  function renumberHeadings(textarea: HTMLTextAreaElement, shrunk: boolean) {
    const settings = headingNumberingRef.current;
    if (!settings.enabled || renumberingRef.current || composingRef.current) return;
    const currentValue = editorValueRef.current;
    const caret = textarea.selectionStart === textarea.selectionEnd ? textarea.selectionStart : undefined;
    const changes = getMarkdownHeadingNumberingChanges(currentValue, settings, shrunk ? caret : undefined);
    if (!changes.length) return;
    const nextValue = applyTextChanges(currentValue, changes);
    const nextSelectionStart = mapOffsetThroughTextChanges(textarea.selectionStart, changes);
    const nextSelectionEnd = mapOffsetThroughTextChanges(textarea.selectionEnd, changes);
    renumberingRef.current = true;
    try {
      if (!replaceTextareaSelectionWithUndo(textarea, {
        ...getChangedTextRange(currentValue, nextValue),
        nextSelectionEnd,
        nextSelectionStart,
        scrollLeft: textarea.scrollLeft,
        scrollTop: textarea.scrollTop,
      })) {
        commitEditorValue(textarea, nextValue);
        textarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);
      }
    } finally {
      renumberingRef.current = false;
    }
  }

  function applyMarkdownFormat(
    textarea: HTMLTextAreaElement,
    { after, before, placeholder = "text" }: MarkdownFormat,
  ) {
    const currentValue = editorValueRef.current;
    const edit = sourceFormatEdit(currentValue, textarea.selectionStart, textarea.selectionEnd, { after, before, placeholder });
    const { nextSelectionStart, nextSelectionEnd } = edit;
    const nextValue = currentValue.slice(0, edit.selectionStart) + edit.replacement + currentValue.slice(edit.selectionEnd);

    setContextMenu(null);
    closeFileLinkPopup();

    if (
      !replaceTextareaSelectionWithUndo(textarea, {
        ...edit,
        scrollLeft: textarea.scrollLeft,
        scrollTop: textarea.scrollTop,
      })
    ) {
      commitEditorValue(textarea, nextValue);
    }

    readDraft();
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);
      emitSelectionChange(nextTextarea);
      syncHighlightLayerScroll(nextTextarea);
      scheduleFileLinkPopupRefresh(nextTextarea, nextValue);
    });
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (handleSourceKey(event, {
      citation: (key) => !!citationPopupRef.current && !!citationPopupHandleRef.current?.handleKey(key),
      fileLink: (key) => {
        if (!fileLinkPopup) return false;
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
      format: (format) => applyMarkdownFormat(event.currentTarget, format),
      heading: applyHeadingLevelChange,
      find: find.openFind,
    })) event.preventDefault();
  }

  function handleEditorKeyUp(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Escape") {
      scheduleSelectionChange(event.currentTarget);
    }

    if (!refreshSourcePopupOnKeyUp(event.key)) return;

    scheduleFileLinkPopupRefresh(event.currentTarget);
  }

  function commitEditorValue(textarea: HTMLTextAreaElement, nextValue: string) {
    editorValueRef.current = nextValue;
    if (textarea.value !== nextValue) textarea.value = nextValue;
    refreshHighlightLayer();
    if (findOpen) setEditorValue(nextValue);
    // Keep workspace/outline/review renders out of the continuous typing path.
    // Save, tab closing, review and export can still read the exact live draft.
    schedulePublish();
    scheduleFileLinkPopupRefresh(textarea, nextValue);
    scheduleSelectionChange(textarea);
  }

  function handleEditorChange(textarea: HTMLTextAreaElement, inputType?: string) {
    const previousLength = editorValueRef.current.length;
    commitEditorValue(textarea, textarea.value);
    // Undo and redo restore exactly what was there; renumbering them would
    // put back the number the user just undid.
    if (!inputType?.startsWith("history")) renumberHeadings(textarea, textarea.value.length < previousLength);
  }

  function emitSelectionChange(textarea: HTMLTextAreaElement) {
    const selection = {
      end: textarea.selectionEnd,
      start: textarea.selectionStart,
    };

    startTransition(() => onSelectionChange?.(selection));
  }

  function flushSelectionChange(textarea: HTMLTextAreaElement) {
    if (selectionChangeTimeoutRef.current !== null) {
      window.clearTimeout(selectionChangeTimeoutRef.current);
      selectionChangeTimeoutRef.current = null;
    }

    emitSelectionChange(textarea);
  }

  function scheduleSelectionChange(textarea: HTMLTextAreaElement) {
    if (!onSelectionChange) {
      return;
    }

    if (selectionChangeTimeoutRef.current !== null) {
      window.clearTimeout(selectionChangeTimeoutRef.current);
    }

    selectionChangeTimeoutRef.current = window.setTimeout(() => {
      selectionChangeTimeoutRef.current = null;
      emitSelectionChange(textarea);
    }, SELECTION_CHANGE_DEBOUNCE_MS);
  }

  function syncHighlightLayerScroll(textarea: HTMLTextAreaElement) {
    const highlightLayer = highlightLayerRef.current;

    if (!highlightLayer) {
      return;
    }

    highlightLayer.scrollLeft = textarea.scrollLeft;
    highlightLayer.scrollTop = textarea.scrollTop;
  }

  function handleEditorScroll(event: UIEvent<HTMLTextAreaElement>) {
    syncHighlightLayerScroll(event.currentTarget);
  }

  return (
    <div className="markdown-editor-source relative min-h-0 min-w-0 overflow-hidden bg-card">
      <pre
        ref={highlightLayerRef}
        aria-hidden="true"
        className="markdown-editor-highlight-layer pointer-events-none absolute inset-0 z-0 h-full w-full overflow-auto border-b border-transparent p-5 font-mono text-sm leading-6 lg:border-b-0 lg:border-r"
        style={{
          fontFamily,
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
          paddingLeft: "var(--markdown-line-text-start)",
          paddingBlock: SOURCE_PANE_PADDING,
          tabSize: SOURCE_TAB_SIZE,
        }}
      />
      <textarea
        ref={textareaRef}
        aria-label={SOURCE_EDITOR_LABEL}
        readOnly={review?.locked}
        className="markdown-editor-input relative z-10 block h-full min-h-0 w-full resize-none overflow-auto border-b border-border p-5 font-mono text-sm leading-6 outline-none lg:border-b-0 lg:border-r"
        style={{
          fontFamily,
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
          paddingLeft: "var(--markdown-line-text-start)",
          paddingBlock: SOURCE_PANE_PADDING,
          tabSize: SOURCE_TAB_SIZE,
        }}
        defaultValue={initialValue}
        onBlur={(event) => { readDraft(); flushSelectionChange(event.currentTarget); }}
        onChange={(event) => handleEditorChange(event.currentTarget, (event.nativeEvent as InputEvent).inputType)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onContextMenu={openContextMenu}
        onClick={(event) => {
          scheduleFileLinkPopupRefresh(event.currentTarget);
          scheduleSelectionChange(event.currentTarget);
        }}
        onMouseDown={(event) => {
          // Ctrl/Cmd+click on a citation opens its attachment at the cited page.
          if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
          const found = citationAtPointer(event.currentTarget, event.clientX, event.clientY);
          if (found && openCitationAttachment(referenceRender, found.citation)) event.preventDefault();
        }}
        onMouseMove={handleCitationPointer}
        onMouseLeave={() => citationHover.show(null)}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onKeyDown={handleEditorKeyDown}
        onKeyUp={handleEditorKeyUp}
        onDrop={(event) => void handleDrop(event)}
        onPaste={(event) => void handlePaste(event)}
        onFocus={(event) => scheduleFileLinkPopupRefresh(event.currentTarget)}
        onSelect={(event) => scheduleSelectionChange(event.currentTarget)}
        onScroll={handleEditorScroll}
        spellCheck={SOURCE_SPELLCHECK}
      />

      {findOpen ? (
        <MarkdownSourceFindBar
          activeIndex={activeMatchIndex} findInputRef={find.findInputRef} matchCount={textMatches.length}
          query={findQuery} replacement={find.replacement} wildcards={wildcardMatches}
          onClose={find.closeFind} onNext={find.next} onPrevious={find.previous} onQueryChange={find.updateQuery}
          onReplace={find.replace} onReplaceAll={find.replaceAll} onReplacementChange={find.setReplacement} onWildcardsChange={find.updateWildcards}
        />
      ) : null}

      {draggingImage ? (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-lg border-2 border-dashed border-input bg-white/70 text-sm font-medium text-foreground">
          Drop image to insert
        </div>
      ) : null}

      {contextMenu ? (
        <MarkdownSourceContextMenu
          aiWorking={aiWorking} documentPath={activeFilePath} formatting={formatting} imageConverting={imageConverting} menu={contextMenu} text={editorValue}
          onClose={() => setContextMenu(null)} onPaste={(mode) => void pasteFromContextMenu(mode)}
          onFormat={() => { if (!aiWorking) { setContextMenu(null); void onAiFormatSelection({ start: contextMenu.start, end: contextMenu.end }); } }}
          onHeadingLevels={(direction) => applyHeadingLevelChange(direction, contextMenu)}
          onRewrite={(prompt) => { setContextMenu(null); void onAiRewriteSelection({ start: contextMenu.start, end: contextMenu.end }, prompt); }}
          onWrite={(prompt) => { setContextMenu(null); void onAiWriteAt(contextMenu.end, prompt); }}
          onImageToMarkdown={() => { if (!aiWorking && contextMenu.image) { setContextMenu(null); void onAiImageToMarkdown(contextMenu.image); } }}
          onReadAloud={() => { speakMarkdown(editorValueRef.current.slice(contextMenu.start, contextMenu.end), { label: "Selection" }); setContextMenu(null); }}
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

      {fileLinkPopup && headingLinkOptions ? (
        <MarkdownHeadingLinkPopup
          activeIndex={selectedFileLinkIndex}
          headings={headingLinkOptions}
          x={fileLinkPopup.x}
          y={fileLinkPopup.y}
          onSelect={insertHeadingLink}
        />
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
