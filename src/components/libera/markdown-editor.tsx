"use client";

import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { LiberaFileNode } from "@/lib/types";

type EditorContextMenuState = {
  image?: MarkdownImageSelection;
  x: number;
  y: number;
  start: number;
  end: number;
};

type TextMatch = {
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
  imageConverting: boolean;
  openTabs: OpenTab[];
  recentFiles: LiberaFileNode[];
  textScale?: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: MarkdownImageSelection) => Promise<void>;
  onAiRewriteSelection: (
    selection: { start: number; end: number },
    prompt: string,
  ) => Promise<void>;
  onChange: (value: string) => void;
  onInsertFileLink: (
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) => void;
  onInsertImageFile: (file: File) => Promise<void>;
  onSelectionChange?: (selection: { end: number; start: number }) => void;
};

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;

function findTextMatches(value: string, query: string): TextMatch[] {
  const normalizedQuery = query.toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const normalizedValue = value.toLowerCase();
  const matches: TextMatch[] = [];
  let searchFrom = 0;

  while (searchFrom <= normalizedValue.length) {
    const start = normalizedValue.indexOf(normalizedQuery, searchFrom);

    if (start === -1) {
      break;
    }

    matches.push({ start, end: start + query.length });
    searchFrom = start + normalizedQuery.length;
  }

  return matches;
}

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

export function MarkdownEditor({
  activeFilePath,
  files,
  formatting,
  imageConverting,
  openTabs,
  recentFiles,
  textScale = 1,
  textareaRef,
  value,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onAiRewriteSelection,
  onChange,
  onInsertFileLink,
  onInsertImageFile,
  onSelectionChange,
}: MarkdownEditorProps) {
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [draggingImage, setDraggingImage] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [fileLinkPopup, setFileLinkPopup] = useState<FileLinkPopupContext | null>(null);
  const [activeFileLinkIndex, setActiveFileLinkIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const rewriteInputRef = useRef<HTMLInputElement>(null);
  const aiWorking = formatting || imageConverting;
  const textMatches = useMemo(() => findTextMatches(value, findQuery), [findQuery, value]);
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
    const textarea = textareaRef.current;
    const selectedText = textarea
      ? value.slice(textarea.selectionStart, textarea.selectionEnd)
      : "";
    const query = nextQuery ?? (selectedText.includes("\n") ? "" : selectedText);

    setContextMenu(null);
    setFindOpen(true);

    if (query) {
      const matches = findTextMatches(value, query);
      setFindQuery(query);
      selectMatch(0, matches);
    }

    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    setFindOpen(false);
    textareaRef.current?.focus();
  }

  function updateFindQuery(query: string) {
    const matches = findTextMatches(value, query);
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

  const getFileLinkPopupContext = useCallback(
    (
      textarea: HTMLTextAreaElement,
      nextValue = value,
    ): FileLinkPopupContext | null => {
      if (textarea.selectionStart !== textarea.selectionEnd) {
        return null;
      }

      const cursor = textarea.selectionStart;
      const beforeCursor = nextValue.slice(0, cursor);
      const linkOpenIndex = beforeCursor.lastIndexOf("](");

      if (linkOpenIndex < 0) {
        return null;
      }

      const labelStart = beforeCursor.lastIndexOf("[", linkOpenIndex);

      if (
        labelStart < 0 ||
        beforeCursor.slice(labelStart, linkOpenIndex).includes("\n")
      ) {
        return null;
      }

      const destinationStart = linkOpenIndex + 2;
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
    [value],
  );

  const refreshFileLinkPopup = useCallback(
    (textarea: HTMLTextAreaElement, nextValue = value) => {
      const nextPopup = getFileLinkPopupContext(textarea, nextValue);

      if (nextPopup?.query !== fileLinkPopup?.query) {
        setActiveFileLinkIndex(0);
      }

      setFileLinkPopup(nextPopup);
    },
    [fileLinkPopup?.query, getFileLinkPopupContext, value],
  );

  function closeFileLinkPopup() {
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
    const textarea = textareaRef.current;

    if (!textarea || document.activeElement !== textarea) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      refreshFileLinkPopup(textarea);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [refreshFileLinkPopup, textareaRef, value]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeContextMenu() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    }

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
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
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = value.slice(start, end);
    const image = findMarkdownImageInText(value, start, end);

    if ((start === end || !selectedText.trim()) && !image) {
      setContextMenu(null);
      return;
    }

    event.preventDefault();
    const menuWidth = 288;
    const menuHeight = image ? 190 : 146;
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

    await onInsertImageFile(imageFiles[0]);
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

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  }

  function handleEditorKeyUp(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === "Escape"
    ) {
      return;
    }

    refreshFileLinkPopup(event.currentTarget);
  }

  function handleEditorChange(textarea: HTMLTextAreaElement) {
    onChange(textarea.value);
    refreshFileLinkPopup(textarea, textarea.value);
  }

  function emitSelectionChange(textarea: HTMLTextAreaElement) {
    onSelectionChange?.({
      end: textarea.selectionEnd,
      start: textarea.selectionStart,
    });
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

  const currentMatchNumber = textMatches.length
    ? Math.min(activeMatchIndex + 1, textMatches.length)
    : 0;

  return (
    <div className="relative min-h-0 min-w-0 overflow-hidden">
      <textarea
        ref={textareaRef}
        className="block h-full min-h-0 w-full resize-none overflow-auto border-b border-border bg-card p-5 font-mono text-sm leading-6 outline-none lg:border-b-0 lg:border-r"
        style={{
          fontSize: `${0.875 * textScale}rem`,
          lineHeight: `${1.5 * textScale}rem`,
        }}
        value={value}
        onBlur={(event) => emitSelectionChange(event.currentTarget)}
        onChange={(event) => handleEditorChange(event.currentTarget)}
        onContextMenu={openContextMenu}
        onClick={(event) => refreshFileLinkPopup(event.currentTarget)}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onKeyDown={handleEditorKeyDown}
        onKeyUp={handleEditorKeyUp}
        onDrop={(event) => void handleDrop(event)}
        onFocus={(event) => refreshFileLinkPopup(event.currentTarget)}
        spellCheck={false}
      />

      {findOpen ? (
        <div className="absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
          <Search aria-hidden className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={findInputRef}
            className="h-8 w-48 min-w-0 border-0 px-1 text-sm outline-none"
            value={findQuery}
            placeholder="Find in note"
            onChange={(event) => updateFindQuery(event.target.value)}
            onKeyDown={handleFindKeyDown}
          />
          <span className="min-w-16 text-center text-xs text-muted-foreground">
            {findQuery ? `${currentMatchNumber}/${textMatches.length}` : "0/0"}
          </span>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            type="button"
            aria-label="Previous match"
            title="Previous match"
            disabled={!textMatches.length}
            onClick={findPrevious}
          >
            <ChevronUp aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            type="button"
            aria-label="Next match"
            title="Next match"
            disabled={!textMatches.length}
            onClick={findNext}
          >
            <ChevronDown aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted"
            type="button"
            aria-label="Close find"
            title="Close"
            onClick={closeFind}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
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
