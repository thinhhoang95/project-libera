"use client";

import { ImageIcon, Sparkles } from "lucide-react";
import type { MouseEvent, RefObject } from "react";
import { useEffect, useState } from "react";
import type { MarkdownImageSelection } from "@/components/libera/types";

type EditorContextMenuState = {
  image?: MarkdownImageSelection;
  x: number;
  y: number;
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
};

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

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

export function MarkdownEditor({
  formatting,
  imageConverting,
  textareaRef,
  value,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onChange,
}: MarkdownEditorProps) {
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);

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

  return (
    <div className="relative min-h-[50vh] lg:min-h-0">
      <textarea
        ref={textareaRef}
        className="h-full min-h-[50vh] w-full resize-none border-b border-zinc-200 bg-white p-5 font-mono text-sm leading-6 outline-none lg:min-h-0 lg:border-b-0 lg:border-r"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onContextMenu={openContextMenu}
        spellCheck={false}
      />

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
