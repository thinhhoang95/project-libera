"use client";

import { toggleComment } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { BookmarkPlus, ClipboardPaste, Copy, FileDown, FileSearch, Loader2, MessageSquareText, PenLine, Replace, Scissors, Sparkles, Volume2, Wand2 } from "lucide-react";
import { speakMarkdown } from "@/lib/tts/player";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AiEditOptions } from "@/components/libera/ai-edit-thread";
import { AiModelPicker } from "@/components/libera/ai-model-picker";
import { QuickPromptInput } from "@/components/libera/quick-prompt-input";
import { isLatexAiWorking, runLatexAi } from "./latex-ai";

export type LatexAiMenuState = { from: number; to: number; x: number; y: number };

const itemClass = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
const MENU_WIDTH = 296;

export function LatexAiMenu({ view, menu, documentPath, onClose, onError, onForwardSync, onAddSnippet, onPaste, onPasteMarkdown, onConvertMarkdown }: {
  view: EditorView;
  menu: LatexAiMenuState;
  documentPath: string;
  onClose: () => void;
  onError: (message: string) => void;
  onForwardSync: (pos: number) => void;
  onAddSnippet: (range: { from: number; to: number }) => void;
  /** Paste: the clipboard converted as a paste would be (Markdown as LaTeX); throws when the clipboard cannot be read. */
  onPaste?: () => Promise<void>;
  /** Paste Markdown as LaTeX…: the clipboard's text through the conversion dialog. */
  onPasteMarkdown?: () => void;
  /** Convert Markdown to LaTeX…: the selected text through the conversion dialog. */
  onConvertMarkdown?: (range: { from: number; to: number }) => void;
}) {
  const t = useTranslations("latex.latexAiMenu");
  const tAi = useTranslations("latex.latexAi");
  const menuRef = useRef<HTMLDivElement>(null);
  const rewriteRef = useRef<HTMLTextAreaElement>(null);
  const writeRef = useRef<HTMLTextAreaElement>(null);
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [writePrompt, setWritePrompt] = useState("");
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const hasText = !!view.state.sliceDoc(menu.from, menu.to).trim();
  const working = isLatexAiWorking(view);
  const isTex = /\.tex$/i.test(documentPath);

  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const height = element.offsetHeight;
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
    (hasText ? rewriteRef : writeRef).current?.focus();
  }, [hasText, menu.x, menu.y]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); view.focus(); }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, view]);

  function run(action: "format" | "rewrite" | "write", prompt = "") {
    if (working) return;
    if (action !== "format" && !prompt.trim()) {
      (action === "rewrite" ? rewriteRef : writeRef).current?.focus();
      return;
    }
    onClose();
    void runLatexAi(view, action, { from: menu.from, to: menu.to }, prompt.trim(), onError, documentPath, tAi);
  }

  async function clipboard(action: "cut" | "copy" | "paste") {
    onClose();
    view.focus();
    const { from, to } = view.state.selection.main;
    try {
      if (action === "paste") {
        if (onPaste) { await onPaste(); return; }
        const text = await navigator.clipboard.readText();
        view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
        return;
      }
      await navigator.clipboard.writeText(view.state.sliceDoc(from, to));
      if (action === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
    } catch {
      onError(t("clipboardUnavailable"));
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("menuLabel")}
      className="fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {hasText ? (
        <>
          <button type="button" role="menuitem" className={itemClass} disabled={working} onClick={() => run("format")} title={t("formatTitle")}>
            {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Wand2 aria-hidden className="h-4 w-4" />}
            {t("formatButton")}
          </button>
          <AiModelPicker task="formatting" disabled={working} className="-mt-0.5 mb-0.5 pl-[34px] pr-2" />
          <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); run("rewrite", rewritePrompt); }}>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="latex-ai-rewrite"><Sparkles aria-hidden className="h-3.5 w-3.5" />{t("rewriteLabel")}</label>
            <div className="mt-1 flex items-start gap-2">
              <QuickPromptInput id="latex-ai-rewrite" inputRef={rewriteRef} value={rewritePrompt} disabled={working} onChange={setRewritePrompt} onSubmit={() => run("rewrite", rewritePrompt)} onEscape={onClose} />
              <button type="submit" aria-label={t("rewriteSubmitLabel")} title={t("rewriteSubmitLabel")} disabled={working || !rewritePrompt.trim()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                <Sparkles aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <AiModelPicker task="rewrite" disabled={working} className="mt-1" />
          </form>
        </>
      ) : null}
      <form className={`${hasText ? "mt-1 border-t border-border " : ""}px-2 py-2`} onSubmit={(event) => { event.preventDefault(); run("write", writePrompt); }}>
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="latex-ai-write"><PenLine aria-hidden className="h-3.5 w-3.5" />{t("writeLabel")}</label>
        <div className="mt-1 flex items-start gap-2">
          <QuickPromptInput id="latex-ai-write" inputRef={writeRef} placeholder={t("writePlaceholder")} value={writePrompt} disabled={working} onChange={setWritePrompt} onSubmit={() => run("write", writePrompt)} onEscape={onClose} />
          <button type="submit" aria-label={t("writeSubmitLabel")} title={t("writeSubmitLabel")} disabled={working || !writePrompt.trim()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            <PenLine aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <AiModelPicker task="write" disabled={working} className="mt-1" />
        <AiEditOptions id="latex-ai-document-context" documentPath={documentPath} />
      </form>
      <div className="mt-1 border-t border-border pt-1">
        {isTex ? (
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); onForwardSync(menu.to); }}>
            <FileSearch aria-hidden className="h-4 w-4" />{t("showInPdf")}
            <kbd className="ml-auto text-xs font-normal text-muted-foreground">⇧⌘J</kbd>
          </button>
        ) : null}
        {hasText ? (
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); onAddSnippet({ from: menu.from, to: menu.to }); }} title={t("addSnippetTitle")}>
            <BookmarkPlus aria-hidden className="h-4 w-4" />{t("addSnippet")}
          </button>
        ) : null}
        <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); toggleComment(view); view.focus(); }}>
          <MessageSquareText aria-hidden className="h-4 w-4" />{t("toggleComment")}
          <kbd className="ml-auto text-xs font-normal text-muted-foreground">⌘/</kbd>
        </button>
        <button type="button" role="menuitem" className={itemClass} disabled={!hasText} onClick={() => { onClose(); speakMarkdown(view.state.sliceDoc(menu.from, menu.to), { label: t("selectionLabel"), format: /\.(?:tex|sty|cls|ltx)$/i.test(documentPath) ? "latex" : "plain" }); }}><Volume2 aria-hidden className="h-4 w-4" />{t("readOutLoud")}</button>
        <button type="button" role="menuitem" className={itemClass} disabled={!hasText} onClick={() => void clipboard("cut")}><Scissors aria-hidden className="h-4 w-4" />{t("cut")}</button>
        <button type="button" role="menuitem" className={itemClass} disabled={!hasText} onClick={() => void clipboard("copy")}><Copy aria-hidden className="h-4 w-4" />{t("copy")}</button>
        <button type="button" role="menuitem" className={itemClass} onClick={() => void clipboard("paste")}><ClipboardPaste aria-hidden className="h-4 w-4" />{t("paste")}</button>
        {isTex && onPasteMarkdown ? (
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); view.focus(); onPasteMarkdown(); }} title={t("pasteMarkdownTitle")}>
            <FileDown aria-hidden className="h-4 w-4" />{t("pasteMarkdown")}
            <kbd className="ml-auto text-xs font-normal text-muted-foreground">⌥⌘V</kbd>
          </button>
        ) : null}
        {isTex && hasText && onConvertMarkdown ? (
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); onConvertMarkdown({ from: menu.from, to: menu.to }); }} title={t("convertMarkdownTitle")}>
            <Replace aria-hidden className="h-4 w-4" />{t("convertMarkdown")}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
