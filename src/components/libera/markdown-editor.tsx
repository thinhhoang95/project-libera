"use client";

import { useSourceReview } from "./use-editor-review";
import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  ListIndentDecrease,
  ListIndentIncrease,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  RefObject,
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
  buildMarkdownFileLinkSections,
  flattenMarkdownFileLinkSections,
} from "@/components/libera/markdown-file-link-popup";
import type {
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownImageSelection,
  OpenTab,
} from "@/components/libera/types";
import {
  getTextareaClientPointForOffset,
  getTextareaOffsetAtPoint,
  scrollTextareaToOffset,
} from "@/lib/textarea-position";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import {
  createMarkdownEditorLineIndex,
  getMarkdownEditorLineHighlight,
  initialMarkdownEditorHighlightState,
} from "@/lib/markdown-editor-highlighting";
import type {
  MarkdownEditorCachedLine,
  MarkdownEditorHighlightState,
  MarkdownEditorLineTone,
} from "@/lib/markdown-editor-highlighting";
import type { LiberaFileNode } from "@/lib/types";
import { findTextMatches, replaceTextMatches, type TextMatch } from "@/lib/text-find";

type EditorContextMenuState = {
  image?: MarkdownImageSelection;
  x: number;
  y: number;
  start: number;
  end: number;
};

type FileLinkPopupContext = {
  destinationEnd: number;
  destinationStart: number;
  query: string;
  x: number;
  y: number;
};

type MarkdownEditorProps = {
  activeFilePath?: string;
  files: LiberaFileNode[];
  formatting: boolean;
  fontFamily: string;
  fontSizePx: number;
  imageConverting: boolean;
  lineHeightPx: number;
  openTabs: OpenTab[];
  recentFiles: LiberaFileNode[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: MarkdownImageSelection) => Promise<void>;
  onAiRewriteSelection: (
    selection: { start: number; end: number },
    prompt: string,
  ) => Promise<void>;
  onChange: (value: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onInsertFileLink: (
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) => void;
  onInsertImageFile: (
    file: File,
    selection?: { end: number; start: number },
  ) => Promise<void>;
  onSelectionChange?: (selection: { end: number; start: number }) => void;
};

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;
const CLIPBOARD_IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MARKDOWN_HEADING_REGEX = /^( {0,3})(#{1,6})(?=\s|$)/;
const EMPTY_EDITOR_LINE = "\u200b";
const SELECTION_CHANGE_DEBOUNCE_MS = 120;
export const SOURCE_DRAFT_DELAY_MS = 250;
const FIND_MATCH_CLASS_NAME = "markdown-editor-find-match";
const ACTIVE_FIND_MATCH_CLASS_NAME = "markdown-editor-find-match-active";

type HeadingLevelChangeDirection = "indent" | "unindent";

type HighlightChunk = {
  className?: string;
  text: string;
};

type TextMutation = {
  inserted: number;
  offset: number;
  removed: number;
};

type HeadingLevelChangeResult = {
  changed: boolean;
  hasHeading: boolean;
  nextEnd: number;
  nextStart: number;
  nextValue: string;
};

type MarkdownFormat = {
  after: string;
  before: string;
  placeholder?: string;
};

const MARKDOWN_SHORTCUT_FORMATS: Record<string, MarkdownFormat> = {
  b: { before: "**", after: "**" },
  i: { before: "_", after: "_" },
  u: { before: "<u>", after: "</u>" },
};

function findMarkdownImageInText(
  value: string,
  start: number,
  end: number,
): MarkdownImageSelection | undefined {
  const selection = value.slice(start, end);
  const selectedMatch = Array.from(selection.matchAll(MARKDOWN_IMAGE_REGEX))[0];

  if (selectedMatch?.index !== undefined) {
    return {
      alt: selectedMatch[1] ?? "",
      src: selectedMatch[2] ?? "",
      start: start + selectedMatch.index,
      end: start + selectedMatch.index + selectedMatch[0].length,
    };
  }

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextLineBreak = value.indexOf("\n", end);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  const line = value.slice(lineStart, lineEnd);

  for (const match of line.matchAll(MARKDOWN_IMAGE_REGEX)) {
    if (match.index === undefined) {
      continue;
    }

    const imageStart = lineStart + match.index;
    const imageEnd = imageStart + match[0].length;

    if (start >= imageStart && start <= imageEnd) {
      return {
        alt: match[1] ?? "",
        src: match[2] ?? "",
        start: imageStart,
        end: imageEnd,
      };
    }
  }
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION_REGEX.test(file.name);
}

function hasImageDragItem(dataTransfer: DataTransfer) {
  if (dataTransfer.files.length) {
    return Array.from(dataTransfer.files).some(isImageFile);
  }

  return Array.from(dataTransfer.items).some(
    (item) =>
      item.kind === "file" &&
      (item.type.startsWith("image/") || !item.type),
  );
}

function getDroppedImageFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files).filter(isImageFile);
}

function timestampForPastedImageName() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
}

function normalizeClipboardImageFile(file: File) {
  if (IMAGE_FILE_EXTENSION_REGEX.test(file.name)) {
    return file;
  }

  const extension = CLIPBOARD_IMAGE_TYPE_EXTENSIONS[file.type.toLowerCase()];

  if (!extension) {
    return null;
  }

  return new File([file], `pasted-image-${timestampForPastedImageName()}.${extension}`, {
    lastModified: file.lastModified || Date.now(),
    type: file.type,
  });
}

function getClipboardImageFiles(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files)
    .filter(isImageFile)
    .map(normalizeClipboardImageFile)
    .filter((file): file is File => Boolean(file));

  if (files.length) {
    return files;
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .map(normalizeClipboardImageFile)
    .filter((file): file is File => Boolean(file));
}

function getHighlightClassName(tone: MarkdownEditorLineTone | undefined) {
  return tone ? `markdown-editor-highlight-tone-${tone}` : undefined;
}

function isHeadingTone(tone: MarkdownEditorLineTone | undefined) {
  return tone?.startsWith("heading-") ?? false;
}

function transformSelectionOffset(
  offset: number,
  mutations: TextMutation[],
  insertAffinity: "after" | "before",
) {
  let delta = 0;

  for (const mutation of mutations) {
    if (mutation.removed === 0) {
      if (
        offset > mutation.offset ||
        (offset === mutation.offset && insertAffinity === "after")
      ) {
        delta += mutation.inserted;
      }

      continue;
    }

    if (offset <= mutation.offset) {
      continue;
    }

    if (offset <= mutation.offset + mutation.removed) {
      return mutation.offset + delta + mutation.inserted;
    }

    delta += mutation.inserted - mutation.removed;
  }

  return offset + delta;
}

function changeSelectedHeadingLevels(
  value: string,
  start: number,
  end: number,
  direction: HeadingLevelChangeDirection,
): HeadingLevelChangeResult {
  const selectionStart = Math.max(0, Math.min(start, end, value.length));
  const selectionEnd = Math.max(0, Math.min(Math.max(start, end), value.length));

  if (selectionStart === selectionEnd) {
    return {
      changed: false,
      hasHeading: false,
      nextEnd: selectionEnd,
      nextStart: selectionStart,
      nextValue: value,
    };
  }

  const lines = value.split("\n");
  const mutations: TextMutation[] = [];
  const nextLines: string[] = [];
  let hasHeading = false;
  let lineOffset = 0;
  let state: MarkdownEditorHighlightState = initialMarkdownEditorHighlightState();

  for (const line of lines) {
    const lineEnd = lineOffset + line.length;
    const lineSelected = selectionStart < lineEnd && selectionEnd > lineOffset;
    const highlight = getMarkdownEditorLineHighlight(line, state);
    const headingMatch = line.match(MARKDOWN_HEADING_REGEX);
    let nextLine = line;

    state = highlight.nextState;

    if (lineSelected && isHeadingTone(highlight.tone) && headingMatch) {
      const leadingSpaces = headingMatch[1] ?? "";
      const headingMarkers = headingMatch[2] ?? "";
      const markerOffset = lineOffset + leadingSpaces.length;

      hasHeading = true;

      if (direction === "indent" && headingMarkers.length < 6) {
        nextLine = `${line.slice(0, leadingSpaces.length)}#${line.slice(
          leadingSpaces.length,
        )}`;
        mutations.push({
          inserted: 1,
          offset: markerOffset,
          removed: 0,
        });
      }

      if (direction === "unindent" && headingMarkers.length > 1) {
        nextLine = `${line.slice(0, leadingSpaces.length)}${line.slice(
          leadingSpaces.length + 1,
        )}`;
        mutations.push({
          inserted: 0,
          offset: markerOffset,
          removed: 1,
        });
      }
    }

    nextLines.push(nextLine);
    lineOffset = lineEnd + 1;
  }

  if (!mutations.length) {
    return {
      changed: false,
      hasHeading,
      nextEnd: selectionEnd,
      nextStart: selectionStart,
      nextValue: value,
    };
  }

  return {
    changed: true,
    hasHeading,
    nextEnd: transformSelectionOffset(selectionEnd, mutations, "after"),
    nextStart: transformSelectionOffset(selectionStart, mutations, "before"),
    nextValue: nextLines.join("\n"),
  };
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

function isSameFileLinkPopupContext(
  left: FileLinkPopupContext | null,
  right: FileLinkPopupContext | null,
) {
  return (
    left?.destinationEnd === right?.destinationEnd &&
    left?.destinationStart === right?.destinationStart &&
    left?.query === right?.query &&
    left?.x === right?.x &&
    left?.y === right?.y
  );
}

export function MarkdownEditor({
  activeFilePath,
  files,
  formatting,
  fontFamily,
  fontSizePx,
  imageConverting,
  lineHeightPx,
  openTabs,
  recentFiles,
  textareaRef,
  value,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onAiRewriteSelection,
  onChange,
  onRegisterDraft,
  onInsertFileLink,
  onInsertImageFile,
  onSelectionChange,
}: MarkdownEditorProps) {
  const [editorValue, setEditorValue] = useState(value);
  const [initialValue] = useState(value);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [draggingImage, setDraggingImage] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [wildcardMatches, setWildcardMatches] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [fileLinkPopup, setFileLinkPopup] = useState<FileLinkPopupContext | null>(null);
  const [activeFileLinkIndex, setActiveFileLinkIndex] = useState(0);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const rewriteInputRef = useRef<HTMLInputElement>(null);
  const highlightLayerRef = useRef<HTMLPreElement>(null);
  const editorValueRef = useRef(value);
  const highlightedLinesRef = useRef<HighlightChunk[][]>([]);
  const highlightIndexRef = useRef<ReturnType<typeof createMarkdownEditorLineIndex> | null>(null);
  highlightIndexRef.current ??= createMarkdownEditorLineIndex();
  const fileLinkPopupFrameRef = useRef<number | null>(null);
  const fileLinkPopupRef = useRef<FileLinkPopupContext | null>(null);
  const publishedDraftsRef = useRef<string[]>([]);
  const composingRef = useRef(false);
  const previousActiveFilePathRef = useRef(activeFilePath);
  const selectionChangeTimeoutRef = useRef<number | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRef = useRef(onChange);
  const lastPublishedRef = useRef(value);
  useLayoutEffect(() => { publishRef.current = onChange; }, [onChange]);
  const readDraft = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const text = editorValueRef.current;
    if (lastPublishedRef.current !== text) {
      setEditorValue(text);
      lastPublishedRef.current = text;
      publishedDraftsRef.current.push(text);
      publishRef.current(text);
    }
    return text;
  }, []);
  useLayoutEffect(() => {
    const unregister = onRegisterDraft?.(readDraft);
    window.addEventListener("pagehide", readDraft);
    return () => { readDraft(); unregister?.(); window.removeEventListener("pagehide", readDraft); };
  }, [onRegisterDraft, readDraft]);
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
    ...(reviewDocument?.threads.filter((t) => t.anchor.state === "attached" && t.status !== "resolved").map((t) => t.anchor) ?? []),
    ...(reviewDocument?.session?.suggestions.filter((s) => s.status === "pending").flatMap((s) => s.edits) ?? []),
    ...(reviewSelection ? [reviewSelection.range] : []),
  ] : [], [reviewEnabled, reviewDocument, reviewSelection]);
  const aiWorking = formatting || imageConverting;
  const findMatches = useMemo(() => {
    let cached: { text: string; query: string; wildcards: boolean; matches: TextMatch[] } | undefined;
    return (text: string, query: string, options: { wildcards: boolean }) => {
      if (cached?.text === text && cached.query === query && cached.wildcards === options.wildcards) return cached.matches;
      const matches = findTextMatches(text, query, options);
      cached = { text, query, wildcards: options.wildcards, matches };
      return matches;
    };
  }, []);
  const textMatches = useMemo(
    () => findOpen ? findMatches(editorValue, findQuery, { wildcards: wildcardMatches }) : [],
    [findOpen, findQuery, editorValue, wildcardMatches, findMatches],
  );
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
    const textarea = textareaRef.current;
    if (textarea) { layer.scrollTop = textarea.scrollTop; layer.scrollLeft = textarea.scrollLeft; }
  }, [activeMatchIndex, findOpen, findQuery, wildcardMatches, reviewRanges, textareaRef, findMatches]);
  const fileLinkSections = useMemo(
    () =>
      fileLinkPopup
        ? buildMarkdownFileLinkSections({
            activeFilePath,
            files,
            openTabs,
            query: fileLinkPopup.query,
            recentFiles,
          })
        : [],
    [activeFilePath, fileLinkPopup, files, openTabs, recentFiles],
  );
  const fileLinkOptions = useMemo(
    () => flattenMarkdownFileLinkSections(fileLinkSections),
    [fileLinkSections],
  );
  const selectedFileLinkIndex = fileLinkOptions.length
    ? Math.min(activeFileLinkIndex, fileLinkOptions.length - 1)
    : 0;
  const contextMenuHeadingLevels = useMemo(() => {
    if (!contextMenu || contextMenu.start === contextMenu.end) {
      return {
        canIndent: false,
        canUnindent: false,
      };
    }

    return {
      canIndent: changeSelectedHeadingLevels(
        editorValue,
        contextMenu.start,
        contextMenu.end,
        "indent",
      ).changed,
      canUnindent: changeSelectedHeadingLevels(
        editorValue,
        contextMenu.start,
        contextMenu.end,
        "unindent",
      ).changed,
    };
  }, [contextMenu, editorValue]);

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
  }, [activeFilePath, value, textareaRef]);

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

  function selectMatch(matchIndex: number, matches = textMatches) {
    if (!matches.length) {
      return;
    }

    const normalizedIndex = (matchIndex + matches.length) % matches.length;
    const match = matches[normalizedIndex];
    setActiveMatchIndex(normalizedIndex);

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.setSelectionRange(match.start, match.end);
      scrollTextareaToOffset(textarea, match.start);
    });
  }

  function openFind(nextQuery?: string) {
    setEditorValue(editorValueRef.current);
    const textarea = textareaRef.current;
    const selectedText = textarea
      ? editorValueRef.current.slice(textarea.selectionStart, textarea.selectionEnd)
      : "";
    const query = nextQuery ?? (selectedText.includes("\n") ? "" : selectedText);

    setContextMenu(null);
    setFindOpen(true);

    if (query) {
      const matches = findMatches(editorValueRef.current, query, { wildcards: wildcardMatches });
      setFindQuery(query);
      selectMatch(0, matches);
    }

    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    const textarea = textareaRef.current;
    const scrollLeft = textarea?.scrollLeft ?? 0;
    const scrollTop = textarea?.scrollTop ?? 0;
    setFindOpen(false);
    textarea?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.scrollLeft = scrollLeft;
      textarea.scrollTop = scrollTop;
      syncHighlightLayerScroll(textarea);
    });
  }

  function updateFindQuery(query: string) {
    const matches = findMatches(editorValueRef.current, query, { wildcards: wildcardMatches });
    setFindQuery(query);
    setActiveMatchIndex(0);

    if (matches.length) {
      selectMatch(0, matches);
    }
  }

  function findNext() {
    selectMatch(activeMatchIndex + 1);
  }

  function findPrevious() {
    selectMatch(activeMatchIndex - 1);
  }

  function updateWildcardMatches(enabled: boolean) {
    const matches = findMatches(editorValueRef.current, findQuery, { wildcards: enabled });
    setWildcardMatches(enabled);
    setActiveMatchIndex(0);
    if (matches.length) selectMatch(0, matches);
  }

  function replaceMatches(matches: TextMatch[]) {
    const textarea = textareaRef.current;
    if (!textarea || !matches.length) return;

    const first = matches[0];
    const last = matches.at(-1)!;
    const relativeMatches = matches.map((match) => ({
      start: match.start - first.start,
      end: match.end - first.start,
    }));
    const replacement = replaceTextMatches(
      editorValueRef.current.slice(first.start, last.end),
      relativeMatches,
      replaceQuery,
    );
    const nextValue = `${editorValueRef.current.slice(0, first.start)}${replacement}${editorValueRef.current.slice(last.end)}`;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const usedNativeUndo = replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: first.start,
      selectionEnd: last.end,
      replacement,
      nextSelectionStart: first.start + replacement.length,
      nextSelectionEnd: first.start + replacement.length,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    });

    if (!usedNativeUndo) commitEditorValue(textarea, nextValue);
    readDraft();

    const nextMatches = findMatches(nextValue, findQuery, { wildcards: wildcardMatches });
    const replacedOne = matches.length === 1;
    const nextOffset = first.start + replaceQuery.length;
    const nextIndex = replacedOne
      ? Math.max(0, nextMatches.findIndex((match) => match.start >= nextOffset))
      : 0;
    setActiveMatchIndex(nextIndex);
    if (nextMatches.length) selectMatch(nextIndex, nextMatches);

    window.requestAnimationFrame(() => focusedElement?.focus());
  }

  function replaceCurrent() {
    const match = textMatches[activeMatchIndex];
    if (match) replaceMatches([match]);
  }

  function replaceAll() {
    replaceMatches(textMatches);
  }

  const getFileLinkPopupContext = useCallback(
    (
      textarea: HTMLTextAreaElement,
      nextValue = editorValueRef.current,
    ): FileLinkPopupContext | null => {
      if (textarea.selectionStart !== textarea.selectionEnd) {
        return null;
      }

      const cursor = textarea.selectionStart;
      const lineStart = nextValue.lastIndexOf("\n", cursor - 1) + 1;
      const beforeCursor = nextValue.slice(lineStart, cursor);
      const linkOpenIndex = beforeCursor.lastIndexOf("](");

      if (linkOpenIndex < 0) {
        return null;
      }

      const labelStart = beforeCursor.lastIndexOf("[", linkOpenIndex);

      if (labelStart < 0) {
        return null;
      }

      const destinationStart = lineStart + linkOpenIndex + 2;
      const destination = nextValue.slice(destinationStart, cursor);

      if (destination.includes("\n") || destination.includes(")")) {
        return null;
      }

      const point = getTextareaClientPointForOffset(textarea, cursor);
      const width = Math.min(384, window.innerWidth - 16);
      const height = 384;

      return {
        destinationEnd: cursor,
        destinationStart,
        query: destination.replace(/^</, ""),
        x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(point.y + 6, window.innerHeight - height - 8)),
      };
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

      if (isSameFileLinkPopupContext(currentPopup, nextPopup)) {
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
  }

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

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeContextMenu() {
      setContextMenu(null);
    }

    function handleScroll(event: Event) {
      const target = event.target;

      if (
        target instanceof Node &&
        contextMenuRef.current?.contains(target)
      ) {
        return;
      }

      closeContextMenu();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    }

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      rewriteInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [contextMenu]);

  function openContextMenu(event: MouseEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setEditorValue(textarea.value);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = editorValueRef.current.slice(start, end);
    const image = findMarkdownImageInText(editorValueRef.current, start, end);

    if ((start === end || !selectedText.trim()) && !image) {
      setContextMenu(null);
      return;
    }

    event.preventDefault();
    const menuWidth = 288;
    const menuHeight = (image ? 190 : 146) + (selectedText.trim() ? 80 : 0);
    setRewritePrompt("");

    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      start,
      end,
      image,
    });
  }

  async function formatSelection() {
    if (!contextMenu || aiWorking) {
      return;
    }

    const selection = {
      start: contextMenu.start,
      end: contextMenu.end,
    };

    setContextMenu(null);
    await onAiFormatSelection(selection);
  }

  async function rewriteSelection() {
    if (!contextMenu || aiWorking) {
      return;
    }

    const prompt = rewritePrompt.trim();

    if (!prompt) {
      rewriteInputRef.current?.focus();
      return;
    }

    const selection = {
      start: contextMenu.start,
      end: contextMenu.end,
    };

    setContextMenu(null);
    await onAiRewriteSelection(selection, prompt);
  }

  async function imageToMarkdown() {
    if (!contextMenu?.image || aiWorking) {
      return;
    }

    const image = contextMenu.image;

    setContextMenu(null);
    await onAiImageToMarkdown(image);
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
    if (!hasImageDragItem(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingImage(true);
  }

  function handleDragLeave() {
    setDraggingImage(false);
  }

  async function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
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
    const imageFiles = getClipboardImageFiles(event.clipboardData);

    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    setContextMenu(null);
    closeFileLinkPopup();

    const textarea = event.currentTarget;
    const selection = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };

    await onInsertImageFile(imageFiles[0], selection);
  }

  function applyMarkdownFormat(
    textarea: HTMLTextAreaElement,
    { after, before, placeholder = "text" }: MarkdownFormat,
  ) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = editorValueRef.current;
    const selectedText = currentValue.slice(start, end) || placeholder;
    const replacement = `${before}${selectedText}${after}`;
    const nextValue = `${currentValue.slice(0, start)}${replacement}${currentValue.slice(end)}`;
    const nextSelectionStart = start + before.length;
    const nextSelectionEnd = nextSelectionStart + selectedText.length;

    setContextMenu(null);
    closeFileLinkPopup();

    if (
      !replaceTextareaSelectionWithUndo(textarea, {
        nextSelectionEnd,
        nextSelectionStart,
        replacement,
        scrollLeft: textarea.scrollLeft,
        scrollTop: textarea.scrollTop,
        selectionEnd: end,
        selectionStart: start,
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
    if (fileLinkPopup) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFileLinkPopup();
        return;
      }

      if (fileLinkOptions.length && event.key === "ArrowDown") {
        event.preventDefault();
        setActiveFileLinkIndex((current) => (current + 1) % fileLinkOptions.length);
        return;
      }

      if (fileLinkOptions.length && event.key === "ArrowUp") {
        event.preventDefault();
        setActiveFileLinkIndex(
          (current) => (current - 1 + fileLinkOptions.length) % fileLinkOptions.length,
        );
        return;
      }

      if (fileLinkOptions.length && event.key === "Enter") {
        event.preventDefault();
        insertFileLink(fileLinkOptions[selectedFileLinkIndex]);
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const shortcut = event.key.toLowerCase();
      const format = MARKDOWN_SHORTCUT_FORMATS[shortcut];

      if (format) {
        event.preventDefault();
        applyMarkdownFormat(event.currentTarget, format);
        return;
      }
    }

    if (
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const handled = applyHeadingLevelChange(
        event.shiftKey ? "unindent" : "indent",
      );

      if (handled) {
        event.preventDefault();
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  }

  function handleEditorKeyUp(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Escape") {
      scheduleSelectionChange(event.currentTarget);
    }

    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === "Escape"
    ) {
      return;
    }

    scheduleFileLinkPopupRefresh(event.currentTarget);
  }

  function commitEditorValue(textarea: HTMLTextAreaElement, nextValue: string) {
    editorValueRef.current = nextValue;
    if (textarea.value !== nextValue) textarea.value = nextValue;
    refreshHighlightLayer();
    if (findOpen) setEditorValue(nextValue);
    // Keep workspace/outline/review renders out of the continuous typing path.
    // Save, tab closing, review and export can still read the exact live draft.
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(function publishAfterPause() {
      if (composingRef.current) draftTimerRef.current = setTimeout(publishAfterPause, SOURCE_DRAFT_DELAY_MS);
      else startTransition(() => { readDraft(); });
    }, SOURCE_DRAFT_DELAY_MS);
    scheduleFileLinkPopupRefresh(textarea, nextValue);
    scheduleSelectionChange(textarea);
  }

  function handleEditorChange(textarea: HTMLTextAreaElement) {
    commitEditorValue(textarea, textarea.value);
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

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();

      if (event.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  }

  function handleReplaceKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    }
  }

  const currentMatchNumber = textMatches.length
    ? Math.min(activeMatchIndex + 1, textMatches.length)
    : 0;

  return (
    <div className="relative min-h-0 min-w-0 overflow-hidden bg-card">
      <pre
        ref={highlightLayerRef}
        aria-hidden="true"
        className="markdown-editor-highlight-layer pointer-events-none absolute inset-0 z-0 h-full w-full overflow-auto border-b border-transparent p-5 font-mono text-sm leading-6 lg:border-b-0 lg:border-r"
        style={{
          fontFamily,
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
        }}
      />
      <textarea
        ref={textareaRef}
        aria-label="Source Markdown editor"
        readOnly={review?.locked}
        className="markdown-editor-input relative z-10 block h-full min-h-0 w-full resize-none overflow-auto border-b border-border p-5 font-mono text-sm leading-6 outline-none lg:border-b-0 lg:border-r"
        style={{
          fontFamily,
          fontSize: `${fontSizePx}px`,
          lineHeight: `${lineHeightPx}px`,
        }}
        defaultValue={initialValue}
        onBlur={(event) => { readDraft(); flushSelectionChange(event.currentTarget); }}
        onChange={(event) => handleEditorChange(event.currentTarget)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onContextMenu={openContextMenu}
        onClick={(event) => {
          scheduleFileLinkPopupRefresh(event.currentTarget);
          scheduleSelectionChange(event.currentTarget);
        }}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onKeyDown={handleEditorKeyDown}
        onKeyUp={handleEditorKeyUp}
        onDrop={(event) => void handleDrop(event)}
        onPaste={(event) => void handlePaste(event)}
        onFocus={(event) => scheduleFileLinkPopupRefresh(event.currentTarget)}
        onSelect={(event) => scheduleSelectionChange(event.currentTarget)}
        onScroll={handleEditorScroll}
        spellCheck={false}
      />

      {findOpen ? (
        <div className="absolute right-3 top-3 z-20 flex w-[30rem] max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
          <div className="flex min-w-0 items-center gap-1">
            <Search aria-hidden className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={findInputRef}
              aria-label="Find in note"
              className="h-8 min-w-24 flex-1 border-0 px-1 text-sm outline-none"
              value={findQuery}
              placeholder="Find in note"
              onChange={(event) => updateFindQuery(event.target.value)}
              onKeyDown={handleFindKeyDown}
            />
            <span className="min-w-16 text-center text-xs text-muted-foreground">
              {findQuery ? `${currentMatchNumber}/${textMatches.length}` : "0/0"}
            </span>
            <button className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" type="button" aria-label="Previous match" title="Previous match" disabled={!textMatches.length} onClick={findPrevious}>
              <ChevronUp aria-hidden className="h-4 w-4" />
            </button>
            <button className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" type="button" aria-label="Next match" title="Next match" disabled={!textMatches.length} onClick={findNext}>
              <ChevronDown aria-hidden className="h-4 w-4" />
            </button>
            <button className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted" type="button" aria-label="Close find" title="Close" onClick={closeFind}>
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-1 pl-7">
            <input
              ref={replaceInputRef}
              aria-label="Replace with"
              className="h-8 min-w-20 flex-1 rounded border border-border bg-background px-2 text-sm outline-none"
              value={replaceQuery}
              placeholder="Replace with"
              onChange={(event) => setReplaceQuery(event.target.value)}
              onKeyDown={handleReplaceKeyDown}
            />
            <button type="button" className="h-8 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40" disabled={!textMatches.length} onClick={replaceCurrent}>Replace</button>
            <button type="button" className="h-8 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40" disabled={!textMatches.length} onClick={replaceAll}>Replace all</button>
            <label className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground" title="Use * for any text and ? for one character">
              <input type="checkbox" aria-label="Wildcard matches" checked={wildcardMatches} onChange={(event) => updateWildcardMatches(event.target.checked)} />
              Wildcards
            </label>
          </div>
        </div>
      ) : null}

      {draggingImage ? (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-lg border-2 border-dashed border-input bg-white/70 text-sm font-medium text-foreground">
          Drop image to insert
        </div>
      ) : null}

      {aiWorking ? (
        <div className="pointer-events-none absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-lg">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          AI is working...
        </div>
      ) : null}

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="fixed z-50 w-72 rounded-lg border border-border bg-card p-1 shadow-lg"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            role="menuitem"
            disabled={aiWorking || contextMenu.start === contextMenu.end}
            onClick={() => void formatSelection()}
          >
            {formatting ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles aria-hidden className="h-4 w-4" />
            )}
            {formatting ? "Formatting..." : "AI Format"}
          </button>
          {contextMenu.start !== contextMenu.end ? (
            <>
              <button
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                role="menuitem"
                disabled={!contextMenuHeadingLevels.canIndent}
                onClick={() => {
                  applyHeadingLevelChange("indent", {
                    start: contextMenu.start,
                    end: contextMenu.end,
                  });
                }}
              >
                <ListIndentIncrease aria-hidden className="h-4 w-4" />
                Indent Headings
              </button>
              <button
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                role="menuitem"
                disabled={!contextMenuHeadingLevels.canUnindent}
                onClick={() => {
                  applyHeadingLevelChange("unindent", {
                    start: contextMenu.start,
                    end: contextMenu.end,
                  });
                }}
              >
                <ListIndentDecrease aria-hidden className="h-4 w-4" />
                Unindent Headings
              </button>
            </>
          ) : null}
          <form
            className="mt-1 border-t border-border px-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              void rewriteSelection();
            }}
          >
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="ai-rewrite-prompt">
              AI Rewrite
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                ref={rewriteInputRef}
                id="ai-rewrite-prompt"
                className="h-8 min-w-0 flex-1 rounded-xl border border-border bg-card px-2 text-sm outline-none focus:border-input"
                placeholder="Prompt..."
                value={rewritePrompt}
                disabled={aiWorking || contextMenu.start === contextMenu.end}
                onChange={(event) => setRewritePrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setContextMenu(null);
                  }
                }}
              />
              <button
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                aria-label="Rewrite selected text"
                title="Rewrite selected text"
                disabled={
                  aiWorking ||
                  contextMenu.start === contextMenu.end ||
                  !rewritePrompt.trim()
                }
              >
                {formatting ? (
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles aria-hidden className="h-4 w-4" />
                )}
              </button>
            </div>
          </form>
          {contextMenu.image ? (
            <button
              className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              role="menuitem"
              disabled={aiWorking}
              onClick={() => void imageToMarkdown()}
            >
              {imageConverting ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon aria-hidden className="h-4 w-4" />
              )}
              {imageConverting ? "Converting..." : "AI Image to Markdown"}
            </button>
          ) : null}
        </div>
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
