"use client";

import { beginAiActivity } from "@/lib/ai-activity";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Columns3, ImageIcon, ListIndentDecrease, ListIndentIncrease, MessageSquarePlus, PenLine, Rows3, Sparkles, Volume2 } from "lucide-react";
import { speakMarkdown } from "@/lib/tts/player";
import { apiRequest } from "./api-client";
import { QuickPromptInput } from "./quick-prompt-input";
import { IncludeDocumentContextCheckbox, readIncludeDocumentContext } from "./ai-document-context-preference";
import {
  changeTiptapHeadingLevels,
  enumerateTiptapHeadings,
  getTiptapBlockInsertionRange,
  getTiptapHeadings,
  hasTiptapHeadings,
  getTiptapSelectionMarkdown,
  numberTiptapHeadings,
  removeTiptapHeadingNumbers,
  replaceTiptapRangeWithMarkdown,
  trackTiptapRange,
  type EditorRange,
} from "@/lib/tiptap-editor-actions";
import { findMarkdownBlockInsertionOffset, insertMarkdownBlock } from "@/lib/ai-write";
import type { SharedVisualSuggestions } from "@/lib/collab/bindings/react-visual";
import { aiSuggestionNotice, imageSourceRange } from "@/lib/collab/client/suggestions-ai";
import type { SnapshotEdit } from "@/lib/collab/suggestions/model";
import { detectStructuralHeadingNumbering } from "@/lib/markdown-heading-numbering";
import { HeadingNumberingControl } from "./heading-numbering-control";
import { readHeadingNumberingSkipTitle, saveDocumentHeadingNumbering, saveHeadingNumberingSkipTitle, useHeadingNumbering } from "./heading-numbering-state";
import { PasteMenuItems, readClipboardText, type ClipboardText, type MenuPasteMode } from "./paste-menu-items";

type ImageSelection = EditorRange & { src: string; alt: string };
type Popup = EditorRange & {
  x: number;
  y: number;
  image?: ImageSelection;
  tableCell?: number;
};
type AiAction = "format" | "rewrite" | "write" | "image";
const menuItemClass = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

export function TiptapEditorActions({ editor, documentPath, onError, onPaste, shared }: {
  editor: Editor;
  documentPath: string;
  onError: (message: string) => void;
  /** Paste or Paste with Peer Heading Level from the right-click menu. */
  onPaste?: (range: EditorRange, clipboard: ClipboardText, mode: MenuPasteMode) => void;
  /**
   * Shared tab: AI results become AI suggestions on the overlay instead of
   * applied changes (plan M3.4), and "Suggest edit" proposes a replacement
   * for the selection (M3.2). Read at use, since the bridge binds after mount.
   */
  shared?: () => SharedVisualSuggestions | null;
}) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [prompt, setPrompt] = useState("");
  const [writePrompt, setWritePrompt] = useState("");
  const [suggestText, setSuggestText] = useState("");
  const [working, setWorking] = useState<AiAction | null>(null);
  useEffect(() => (working ? beginAiActivity() : undefined), [working]);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<{ controller: AbortController; dispose: () => void } | null>(null);
  const hasHeadings = useEditorState({ editor, selector: ({ editor: current }) => hasTiptapHeadings(current.state.doc) });
  const headingNumbering = useHeadingNumbering(documentPath, () => {
    const { doc } = editor.state;
    if (doc.content.size <= 2) return null;
    const headings: { level: number; text: string }[] = [];
    doc.descendants((node) => {
      if (node.type.name === "heading") headings.push({ level: node.attrs.level, text: node.textContent });
    });
    return detectStructuralHeadingNumbering(headings);
  });
  const sharedRef = useRef(shared);
  useEffect(() => { sharedRef.current = shared; });

  useEffect(() => {
    function openContextMenu(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      let { from, to } = editor.state.selection;
      let image: ImageSelection | undefined;
      const target = event.target instanceof Element ? event.target.closest("img") : null;
      if (target && editor.view.dom.contains(target)) {
        const pos = editor.view.posAtDOM(target, 0);
        const node = editor.state.doc.nodeAt(pos);
        if (node?.type.name === "image") image = { from: pos, to: pos + node.nodeSize, src: node.attrs.src, alt: node.attrs.alt ?? "" };
      }
      if (!image) {
        editor.state.doc.nodesBetween(from, to, (node, pos) => {
          if (!image && node.type.name === "image") image = { from: pos, to: pos + node.nodeSize, src: node.attrs.src, alt: node.attrs.alt ?? "" };
        });
      }
      // Without a selection the menu offers Write with AI at the clicked spot.
      if (from === to && image) {
        from = to = image.to;
      } else if (from === to && event instanceof MouseEvent) {
        from = to = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? from;
      }
      // A right-click may land in a cell the selection has not reached yet.
      let tableCell: number | undefined;
      const $cell = (() => { try { return editor.state.doc.resolve(from); } catch { return null; } })();
      for (let depth = $cell?.depth ?? -1; depth > 0; depth--) {
        const name = $cell!.node(depth).type.name;
        if (name === "tableCell" || name === "tableHeader") { tableCell = $cell!.start(depth); break; }
      }
      event.preventDefault();
      const point = event instanceof MouseEvent
        ? { left: event.clientX, top: event.clientY }
        : editor.view.coordsAtPos(from);
      setPrompt("");
      setWritePrompt("");
      // "Suggest edit" starts from the selection's own source text.
      const sharedTarget = sharedRef.current?.() ?? null;
      if (sharedTarget && from !== to) {
        const source = sharedTarget.sourceRange({ from, to });
        setSuggestText(sharedTarget.text().slice(source.start, source.end));
      } else setSuggestText("");
      setPopup({ from, to, image, tableCell,
        x: Math.max(8, Math.min(point.left, window.innerWidth - 296)),
        y: Math.max(8, Math.min(point.top, window.innerHeight - 420)),
      });
    }
    const dom = editor.view.dom;
    dom.addEventListener("contextmenu", openContextMenu);
    dom.addEventListener("keydown", openContextMenu);
    return () => {
      dom.removeEventListener("contextmenu", openContextMenu);
      dom.removeEventListener("keydown", openContextMenu);
    };
  }, [editor]);

  useEffect(() => {
    if (!popup) return;
    const close = () => setPopup(null);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); editor.commands.focus(); }
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) close();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    editor.on("transaction", onTransaction);
    const writeOnly = popup.from === popup.to;
    menuRef.current?.querySelector<HTMLElement>(writeOnly ? "#visual-ai-write" : "button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      editor.off("transaction", onTransaction);
    };
  }, [popup, editor]);

  useEffect(() => () => {
    pendingRef.current?.controller.abort();
    pendingRef.current?.dispose();
    pendingRef.current = null;
  }, []);

  async function paste(mode: MenuPasteMode) {
    if (!popup || !onPaste) return;
    const range = { from: popup.from, to: popup.to };
    setPopup(null);
    const clipboard = await readClipboardText();
    if (editor.isDestroyed) return;
    onPaste(range, clipboard, mode);
    editor.commands.focus();
  }

  async function runAi(action: AiAction) {
    if (!popup || pendingRef.current) return;
    const range = action === "image" ? popup.image : action === "write" ? getTiptapBlockInsertionRange(editor, popup.to) : popup;
    if (!range) return;
    if (action === "write" ? !writePrompt.trim() : range.from === range.to || (action === "rewrite" && !prompt.trim())) return;
    const tracked = trackTiptapRange(editor, range);
    const target = shared?.() ?? null;
    // On a shared tab the AI works on the source text it will suggest a
    // replacement for, and the result is mapped from that snapshot onto the
    // live text when it arrives.
    let source: { snapshot: string; start: number; end: number } | null = null;
    if (target) {
      const mapped = target.sourceRange(range);
      const snapshot = target.text();
      if (action === "write") {
        const position = findMarkdownBlockInsertionOffset(snapshot, mapped.start);
        source = { snapshot, start: position, end: position };
      } else if (action === "image" && popup.image) {
        source = { snapshot, ...imageSourceRange(snapshot, mapped.start, mapped.end, popup.image.src) };
      } else source = { snapshot, ...mapped };
    }
    const controller = new AbortController();
    const pending = { controller, dispose: tracked.dispose };
    pendingRef.current = pending;
    setWorking(action);
    setPopup(null);
    onError("");
    try {
      const text = action === "write" ? "" : source ? source.snapshot.slice(source.start, source.end) : getTiptapSelectionMarkdown(editor, range);
      // The Markdown on either side of the selection or insertion point.
      const context = (action === "write" || action === "rewrite") && readIncludeDocumentContext() ? (source ? {
        before: source.snapshot.slice(0, source.start),
        after: source.snapshot.slice(source.end),
      } : {
        before: getTiptapSelectionMarkdown(editor, { from: 0, to: range.from }),
        after: getTiptapSelectionMarkdown(editor, { from: range.to, to: editor.state.doc.content.size }),
      }) : {};
      let markdown: string;
      const init = { method: "POST", signal: controller.signal };
      if (action === "image" && popup.image) {
        const result = await apiRequest<{ markdown: string }>("/api/ai-image-to-markdown", {
          ...init, body: JSON.stringify({ documentPath, imageSource: popup.image.src, alt: popup.image.alt }),
        });
        markdown = result.markdown;
      } else if (action === "write") {
        const result = await apiRequest<{ markdown: string }>("/api/ai-write", {
          ...init, body: JSON.stringify({ prompt: writePrompt.trim(), ...context }),
        });
        markdown = result.markdown;
      } else if (action === "rewrite") {
        const result = await apiRequest<{ rewrittenText: string }>("/api/ai-rewrite", {
          ...init, body: JSON.stringify({ text, prompt: prompt.trim(), ...context }),
        });
        markdown = result.rewrittenText;
      } else {
        const result = await apiRequest<{ formattedText: string }>("/api/ai-format", {
          ...init, body: JSON.stringify({ text }),
        });
        markdown = result.formattedText;
      }
      if (controller.signal.aborted || editor.isDestroyed) return;
      if (target && source) {
        if (!markdown?.trim()) throw new Error("AI returned an empty response. Please retry.");
        const edit: SnapshotEdit = action === "write"
          ? { start: source.start, end: source.start, before: "", after: (() => {
            const inserted = insertMarkdownBlock(source.snapshot, source.start, markdown).value;
            return inserted.slice(source.start, source.start + inserted.length - source.snapshot.length);
          })() }
          : { start: source.start, end: source.end, before: source.snapshot.slice(source.start, source.end), after: markdown };
        const notice = aiSuggestionNotice(target.controller.suggestAi(source.snapshot, [edit], { feature: action === "image" ? "image-to-markdown" : action }));
        if (notice) onError(notice);
        return;
      }
      if (!tracked.isValid()) throw new Error(action === "write" ? "The text around the insertion point changed while AI was working. Please retry." : "The selected content changed while AI was working. Select it again and retry.");
      if (!markdown?.trim()) throw new Error("AI returned an empty response. Please retry.");
      tracked.dispose();
      replaceTiptapRangeWithMarkdown(editor, tracked.range, markdown, action);
      // Keep converted image assets available so Undo can restore the image.
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause instanceof Error ? cause.message : "AI request failed.");
    } finally {
      tracked.dispose();
      if (pendingRef.current === pending) {
        pendingRef.current = null;
        setWorking(null);
      }
    }
  }

  function suggestEdit() {
    const target = shared?.() ?? null;
    if (!popup || !target || popup.from === popup.to) return;
    const { start, end } = target.sourceRange(popup);
    const result = target.controller.suggest(start, end, suggestText);
    setPopup(null);
    onError(result.ok ? "" : result.message);
    editor.commands.focus();
  }

  const selectedHeadings = popup ? getTiptapHeadings(editor, popup).filter((heading) => heading.selected) : [];
  const canSuggestEdit = !!popup && popup.from !== popup.to && !!shared?.()?.controller.canSuggest();
  const hasText = popup ? !!getTiptapSelectionMarkdown(editor, popup).trim() : false;
  const canIndent = selectedHeadings.some(({ node }) => node.attrs.level < 6);
  const canUnindent = selectedHeadings.length > 0;
  const writeOnly = popup?.from === popup?.to;
  type TableAction = "addRowBefore" | "addRowAfter" | "addColumnBefore" | "addColumnAfter" | "deleteRow" | "deleteColumn";
  function tableAction(action: TableAction) {
    if (popup?.tableCell === undefined) return;
    editor.chain().focus().setTextSelection(popup.tableCell)[action]().run();
    setPopup(null);
  }
  const writeForm = <form className={`${writeOnly ? "" : "mt-1 border-t border-border "}px-2 py-2`} onSubmit={(event) => { event.preventDefault(); void runAi("write"); }}>
    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="visual-ai-write"><PenLine aria-hidden className="h-3.5 w-3.5" />Write with AI</label>
    <div className="mt-1 flex items-start gap-2">
      <QuickPromptInput id="visual-ai-write" placeholder="What should AI write? Type / for prompts" value={writePrompt} disabled={!!working} onChange={setWritePrompt} onSubmit={() => void runAi("write")} />
      <button type="submit" aria-label="Write new text with AI" title="Write new text with AI" disabled={!!working || !writePrompt.trim()} className="h-8 shrink-0 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"><PenLine aria-hidden className="h-4 w-4" /></button>
    </div>
    <IncludeDocumentContextCheckbox id="visual-ai-document-context" />
  </form>;

  return <>
    <HeadingNumberingControl
      buttonClassName="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground"
      disabled={!!working}
      enabled={headingNumbering.enabled}
      skipTitle={headingNumbering.skipTitle}
      onEnumerateSelected={hasHeadings ? (startAt) => { enumerateTiptapHeadings(editor, "selected", editor.state.selection, startAt); editor.commands.focus(); } : undefined}
      onNumberAll={() => { numberTiptapHeadings(editor, { skipTitle: readHeadingNumberingSkipTitle() }); editor.commands.focus(); }}
      onRemoveAll={() => { saveDocumentHeadingNumbering(documentPath, false); removeTiptapHeadingNumbers(editor); editor.commands.focus(); }}
      onSkipTitleChange={saveHeadingNumberingSkipTitle}
      onToggle={(enabled) => saveDocumentHeadingNumbering(documentPath, enabled)}
    />
    {popup ? createPortal(
      <div ref={menuRef} role="menu" aria-label="Editor actions"
        className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
        style={{ left: popup.x, top: popup.y, maxHeight: "calc(100vh - 16px)" }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          event.preventDefault();
        }}>
        {onPaste ? <PasteMenuItems className={menuItemClass} disabled={!!working} onPaste={(mode) => void paste(mode)} /> : null}
        {writeOnly ? writeForm : null}
        {!writeOnly ? <>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!hasText} onClick={() => { speakMarkdown(getTiptapSelectionMarkdown(editor, popup), { label: "Selection" }); setPopup(null); }}><Volume2 aria-hidden className="h-4 w-4" />Read Out Loud</button>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!!working || !hasText} onClick={() => void runAi("format")}><Sparkles aria-hidden className="h-4 w-4" />AI Format</button>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!canIndent} onClick={() => { changeTiptapHeadingLevels(editor, popup, "indent"); setPopup(null); editor.commands.focus(); }}><ListIndentIncrease aria-hidden className="h-4 w-4" />Indent Headings</button>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!canUnindent} onClick={() => { changeTiptapHeadingLevels(editor, popup, "unindent"); setPopup(null); editor.commands.focus(); }}><ListIndentDecrease aria-hidden className="h-4 w-4" />Unindent Headings</button>
        </> : null}
        {canSuggestEdit ? <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); suggestEdit(); }}>
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="visual-suggest-edit"><MessageSquarePlus aria-hidden className="h-3.5 w-3.5" />Suggest edit</label>
          <div className="mt-1 flex items-start gap-2">
            <textarea id="visual-suggest-edit" rows={2} value={suggestText} placeholder="Replacement text (empty suggests deleting it)"
              className="min-w-0 flex-1 resize-y rounded-md border border-border bg-card px-2 py-1 text-sm"
              onChange={(event) => setSuggestText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); suggestEdit(); } }} />
            <button type="submit" aria-label="Suggest this replacement" title="Suggest this replacement" className="h-8 shrink-0 rounded-md bg-primary px-2 text-primary-foreground"><MessageSquarePlus aria-hidden className="h-4 w-4" /></button>
          </div>
        </form> : null}
        {!writeOnly ? <>
          <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); void runAi("rewrite"); }}>
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="visual-ai-rewrite">AI Rewrite</label>
            <div className="mt-1 flex items-start gap-2">
              <QuickPromptInput id="visual-ai-rewrite" value={prompt} disabled={!!working || !hasText} onChange={setPrompt} onSubmit={() => void runAi("rewrite")} />
              <button type="submit" aria-label="Rewrite selected text" disabled={!!working || !hasText || !prompt.trim()} className="h-8 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"><Sparkles aria-hidden className="h-4 w-4" /></button>
            </div>
          </form>
          {writeForm}
        </> : null}
        <>
          {popup.tableCell !== undefined ? <>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("addRowBefore")}><ArrowUpToLine aria-hidden className="h-4 w-4" />Insert Row Above</button>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("addRowAfter")}><ArrowDownToLine aria-hidden className="h-4 w-4" />Insert Row Below</button>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("addColumnBefore")}><ArrowLeftToLine aria-hidden className="h-4 w-4" />Insert Column to the Left</button>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("addColumnAfter")}><ArrowRightToLine aria-hidden className="h-4 w-4" />Insert Column to the Right</button>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("deleteRow")}><Rows3 aria-hidden className="h-4 w-4" />Delete Row</button>
            <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => tableAction("deleteColumn")}><Columns3 aria-hidden className="h-4 w-4" />Delete Column</button>
          </> : null}
          {popup.image ? <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => void runAi("image")}><ImageIcon aria-hidden className="h-4 w-4" />AI Image to Markdown</button> : null}
        </>
      </div>, document.body,
    ) : null}
  </>;
}
