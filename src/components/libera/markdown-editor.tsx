"use client";

import { ChevronDown, ChevronUp, ImageIcon, Search, Sparkles, X } from "lucide-react";
import type { DragEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownImageSelection } from "@/components/libera/types";

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

type MarkdownEditorProps = {
  formatting: boolean;
  imageConverting: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: MarkdownImageSelection) => Promise<void>;
  onChange: (value: string) => void;
  onInsertImageFile: (file: File) => Promise<void>;
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

function parsePixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTextareaOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  clientX: number,
  clientY: number,
) {
  const styles = window.getComputedStyle(textarea);
  const rect = textarea.getBoundingClientRect();
  const paddingLeft = parsePixels(styles.paddingLeft);
  const paddingRight = parsePixels(styles.paddingRight);
  const paddingTop = parsePixels(styles.paddingTop);
  const fontSize = parsePixels(styles.fontSize) || 14;
  const lineHeight = parsePixels(styles.lineHeight) || fontSize * 1.5;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const font = [
    styles.fontStyle,
    styles.fontVariant,
    styles.fontWeight,
    styles.fontSize,
    styles.fontFamily,
  ].join(" ");
  if (context) {
    context.font = font;
  }

  const charWidth = context ? context.measureText("M").width || fontSize * 0.6 : fontSize * 0.6;
  const contentWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);
  const wrapColumn = Math.max(1, Math.floor(contentWidth / charWidth));
  const targetLine = Math.max(
    0,
    Math.floor((clientY - rect.top - paddingTop + textarea.scrollTop) / lineHeight),
  );
  const targetColumn = Math.max(
    0,
    Math.round((clientX - rect.left - paddingLeft + textarea.scrollLeft) / charWidth),
  );
  const lines = textarea.value.split("\n");
  let offset = 0;
  let visualLine = 0;

  for (const line of lines) {
    const visualLineCount = Math.max(1, Math.ceil(Math.max(1, line.length) / wrapColumn));

    if (targetLine < visualLine + visualLineCount) {
      const wrappedLine = targetLine - visualLine;
      const lineOffset = Math.min(line.length, wrappedLine * wrapColumn + targetColumn);
      return offset + lineOffset;
    }

    offset += line.length + 1;
    visualLine += visualLineCount;
  }

  return textarea.value.length;
}

function scrollTextareaToOffset(textarea: HTMLTextAreaElement, offset: number) {
  const styles = window.getComputedStyle(textarea);
  const fontSize = parsePixels(styles.fontSize) || 14;
  const lineHeight = parsePixels(styles.lineHeight) || fontSize * 1.5;
  const lineIndex = textarea.value.slice(0, offset).split("\n").length - 1;

  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2);
}

export function MarkdownEditor({
  formatting,
  imageConverting,
  textareaRef,
  value,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onChange,
  onInsertImageFile,
}: MarkdownEditorProps) {
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const textMatches = useMemo(() => findTextMatches(value, findQuery), [findQuery, value]);

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
    const menuWidth = 176;
    const menuHeight = image ? 88 : 44;

    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      start,
      end,
      image,
    });
  }

  async function formatSelection() {
    if (!contextMenu || formatting) {
      return;
    }

    const selection = {
      start: contextMenu.start,
      end: contextMenu.end,
    };

    setContextMenu(null);
    await onAiFormatSelection(selection);
  }

  async function imageToMarkdown() {
    if (!contextMenu?.image || imageConverting) {
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

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  }

  function handleFindKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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
    <div className="relative min-h-0 overflow-hidden">
      <textarea
        ref={textareaRef}
        className="block h-full min-h-0 w-full resize-none overflow-auto border-b border-zinc-200 bg-white p-5 font-mono text-sm leading-6 outline-none lg:border-b-0 lg:border-r"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onContextMenu={openContextMenu}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onKeyDown={handleEditorKeyDown}
        onDrop={(event) => void handleDrop(event)}
        spellCheck={false}
      />

      {findOpen ? (
        <div className="absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 shadow-lg">
          <Search aria-hidden className="ml-2 h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={findInputRef}
            className="h-8 w-48 min-w-0 border-0 px-1 text-sm outline-none"
            value={findQuery}
            placeholder="Find in note"
            onChange={(event) => updateFindQuery(event.target.value)}
            onKeyDown={handleFindKeyDown}
          />
          <span className="min-w-16 text-center text-xs text-zinc-500">
            {findQuery ? `${currentMatchNumber}/${textMatches.length}` : "0/0"}
          </span>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
            type="button"
            aria-label="Previous match"
            title="Previous match"
            disabled={!textMatches.length}
            onClick={findPrevious}
          >
            <ChevronUp aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
            type="button"
            aria-label="Next match"
            title="Next match"
            disabled={!textMatches.length}
            onClick={findNext}
          >
            <ChevronDown aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-600 hover:bg-zinc-100"
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
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-md border-2 border-dashed border-zinc-400 bg-white/70 text-sm font-medium text-zinc-700">
          Drop image to insert
        </div>
      ) : null}

      {contextMenu ? (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-zinc-200 bg-white p-1 shadow-lg"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            role="menuitem"
            disabled={formatting || contextMenu.start === contextMenu.end}
            onClick={() => void formatSelection()}
          >
            <Sparkles aria-hidden className="h-4 w-4" />
            {formatting ? "Formatting..." : "AI Format"}
          </button>
          {contextMenu.image ? (
            <button
              className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              role="menuitem"
              disabled={imageConverting}
              onClick={() => void imageToMarkdown()}
            >
              <ImageIcon aria-hidden className="h-4 w-4" />
              {imageConverting ? "Converting..." : "AI Image to Markdown"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
