"use client";

import { ImageIcon, ListIndentDecrease, ListIndentIncrease, Loader2, PenLine, Sparkles, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownImageSelection } from "@/components/libera/types";
import { AiEditOptions } from "../ai-edit-thread";
import { QuickPromptInput } from "../quick-prompt-input";
import { PasteMenuItems, type MenuPasteMode } from "../paste-menu-items";
import { changeSelectedHeadingLevels, findMarkdownImageInText } from "@/lib/markdown-source";

/* The Source editor's right-click menu: Paste, Paste with Peer Heading Level, Read Out Loud, AI Format, Indent/Unindent Headings,
 * AI Rewrite, Write with AI and AI Image to Markdown. Same items, labels and
 * keyboard behaviour for both editor engines. DOM selection stays in the editor. */

export type SourceContextMenuState = {
  end: number;
  hasText: boolean;
  image?: MarkdownImageSelection;
  start: number;
  x: number;
  y: number;
};

const MENU_WIDTH = 288;

/** Where the menu opens: at the pointer, kept inside the window. */
export function sourceContextMenuPosition(clientX: number, clientY: number, hasText: boolean, hasImage: boolean) {
  const height = (hasText ? 384 : 114) + 90 + (hasImage ? 44 : 0);
  return {
    x: Math.max(8, Math.min(clientX, window.innerWidth - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(clientY, window.innerHeight - height - 8)),
  };
}

export function sourceContextMenuState(text: string, start: number, end: number, clientX: number, clientY: number): SourceContextMenuState {
  const hasText = !!text.slice(start, end).trim();
  const image = findMarkdownImageInText(text, start, end);
  return { start, end, hasText, image, ...sourceContextMenuPosition(clientX, clientY, hasText, !!image) };
}

const ITEM_CLASS = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const SUBMIT_CLASS = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50";

export function MarkdownSourceContextMenu({
  aiWorking,
  documentPath,
  formatting,
  imageConverting,
  menu,
  text,
  onClose,
  onFormat,
  onHeadingLevels,
  onImageToMarkdown,
  onPaste,
  onReadAloud,
  onRewrite,
  onWrite,
}: {
  aiWorking: boolean;
  /** Keys the cached AI Rewrite / Write with AI thread. */
  documentPath?: string;
  formatting: boolean;
  imageConverting: boolean;
  menu: SourceContextMenuState;
  text: string;
  onClose: () => void;
  onFormat: () => void;
  onHeadingLevels: (direction: "indent" | "unindent") => void;
  onImageToMarkdown: () => void;
  onPaste: (mode: MenuPasteMode) => void;
  onReadAloud: () => void;
  onRewrite: (prompt: string) => void;
  onWrite: (prompt: string) => void;
}) {
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [writePrompt, setWritePrompt] = useState("");
  const [promptMenu, setPromptMenu] = useState(menu);
  if (promptMenu !== menu) {
    setPromptMenu(menu);
    setRewritePrompt("");
    setWritePrompt("");
  }
  const menuRef = useRef<HTMLDivElement>(null);
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const writeInputRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  // Close on any outside pointer, scroll outside the menu, resize or Escape.
  useEffect(() => {
    const close = () => closeRef.current();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // Without a selection the menu offers only Write with AI; focus its prompt.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      (menu.hasText ? rewriteInputRef : writeInputRef).current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menu]);

  const { canIndent, canUnindent } = useMemo(() => ({
    canIndent: menu.start !== menu.end && changeSelectedHeadingLevels(text, menu.start, menu.end, "indent").changed,
    canUnindent: menu.start !== menu.end && changeSelectedHeadingLevels(text, menu.start, menu.end, "unindent").changed,
  }), [text, menu]);

  function rewrite() {
    const prompt = rewritePrompt.trim();
    if (aiWorking) return;
    if (!prompt) {
      rewriteInputRef.current?.focus();
      return;
    }
    onRewrite(prompt);
  }

  function write() {
    const prompt = writePrompt.trim();
    if (aiWorking) return;
    if (!prompt) {
      writeInputRef.current?.focus();
      return;
    }
    onWrite(prompt);
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-72 rounded-lg border border-border bg-card p-1 shadow-lg"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <PasteMenuItems className={ITEM_CLASS} onPaste={onPaste} />
      {menu.hasText ? (
        <>
          <button className={ITEM_CLASS} type="button" role="menuitem" onClick={onReadAloud}>
            <Volume2 aria-hidden className="h-4 w-4" />
            Read Out Loud
          </button>
          <button className={ITEM_CLASS} type="button" role="menuitem" disabled={aiWorking} onClick={onFormat}>
            {formatting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden className="h-4 w-4" />}
            {formatting ? "Formatting..." : "AI Format"}
          </button>
          <button className={ITEM_CLASS} type="button" role="menuitem" disabled={!canIndent} onClick={() => onHeadingLevels("indent")}>
            <ListIndentIncrease aria-hidden className="h-4 w-4" />
            Indent Headings
          </button>
          <button className={ITEM_CLASS} type="button" role="menuitem" disabled={!canUnindent} onClick={() => onHeadingLevels("unindent")}>
            <ListIndentDecrease aria-hidden className="h-4 w-4" />
            Unindent Headings
          </button>
          <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); rewrite(); }}>
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="ai-rewrite-prompt">AI Rewrite</label>
            <div className="mt-1 flex items-start gap-2">
              <QuickPromptInput
                id="ai-rewrite-prompt"
                inputRef={rewriteInputRef}
                value={rewritePrompt}
                disabled={aiWorking}
                onChange={setRewritePrompt}
                onSubmit={rewrite}
                onEscape={onClose}
              />
              <button className={SUBMIT_CLASS} type="submit" aria-label="Rewrite selected text" title="Rewrite selected text" disabled={aiWorking || !rewritePrompt.trim()}>
                {formatting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden className="h-4 w-4" />}
              </button>
            </div>
          </form>
        </>
      ) : null}
      <form className={`${menu.hasText ? "mt-1 border-t border-border " : ""}px-2 py-2`} onSubmit={(event) => { event.preventDefault(); write(); }}>
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="ai-write-prompt">
          <PenLine aria-hidden className="h-3.5 w-3.5" />
          Write with AI
        </label>
        <div className="mt-1 flex items-start gap-2">
          <QuickPromptInput
            id="ai-write-prompt"
            inputRef={writeInputRef}
            placeholder="What should AI write? Type / for prompts"
            value={writePrompt}
            disabled={aiWorking}
            onChange={setWritePrompt}
            onSubmit={write}
            onEscape={onClose}
          />
          <button className={SUBMIT_CLASS} type="submit" aria-label="Write new text with AI" title="Write new text with AI" disabled={aiWorking || !writePrompt.trim()}>
            <PenLine aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <AiEditOptions id="ai-document-context" documentPath={documentPath} />
      </form>
      {menu.image ? (
        <button className={ITEM_CLASS} type="button" role="menuitem" disabled={aiWorking} onClick={onImageToMarkdown}>
          {imageConverting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ImageIcon aria-hidden className="h-4 w-4" />}
          {imageConverting ? "Converting..." : "AI Image to Markdown"}
        </button>
      ) : null}
    </div>
  );
}
