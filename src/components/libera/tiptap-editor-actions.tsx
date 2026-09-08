"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ImageIcon, ListIndentDecrease, ListIndentIncrease, ListOrdered, Loader2, Sparkles } from "lucide-react";
import { apiRequest } from "./api-client";
import {
  changeTiptapHeadingLevels,
  enumerateTiptapHeadings,
  getTiptapHeadings,
  getTiptapSelectionMarkdown,
  replaceTiptapRangeWithMarkdown,
  trackTiptapRange,
  type EditorRange,
} from "@/lib/tiptap-editor-actions";

type ImageSelection = EditorRange & { src: string; alt: string };
type Popup = EditorRange & {
  kind: "headings" | "context";
  x: number;
  y: number;
  image?: ImageSelection;
};
type AiAction = "format" | "rewrite" | "image";
const menuItemClass = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

export function TiptapEditorActions({ editor, documentPath, onError }: {
  editor: Editor;
  documentPath: string;
  onError: (message: string) => void;
}) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [startAt, setStartAt] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [working, setWorking] = useState<AiAction | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<{ controller: AbortController; dispose: () => void } | null>(null);
  const hasHeadings = useEditorState({ editor, selector: ({ editor: current }) => getTiptapHeadings(current, current.state.selection).length > 0 });

  useEffect(() => {
    function openContextMenu(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      const { from, to } = editor.state.selection;
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
      if (from === to && !image) return;
      event.preventDefault();
      const point = event instanceof MouseEvent
        ? { left: event.clientX, top: event.clientY }
        : editor.view.coordsAtPos(from);
      setPrompt("");
      setStartAt("1");
      setPopup({ from, to, kind: "context", image,
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
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
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
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
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

  function enumerate(scope: "all" | "selected") {
    if (!popup) return;
    enumerateTiptapHeadings(editor, scope, popup, scope === "all" ? 1 : Number(startAt));
    setPopup(null);
    editor.commands.focus();
  }

  async function runAi(action: AiAction) {
    if (!popup || pendingRef.current) return;
    const range = action === "image" ? popup.image : popup;
    if (!range || range.from === range.to || (action === "rewrite" && !prompt.trim())) return;
    const tracked = trackTiptapRange(editor, range);
    const controller = new AbortController();
    const pending = { controller, dispose: tracked.dispose };
    pendingRef.current = pending;
    setWorking(action);
    setPopup(null);
    onError("");
    try {
      const text = getTiptapSelectionMarkdown(editor, range);
      let markdown: string;
      const init = { method: "POST", signal: controller.signal };
      if (action === "image" && popup.image) {
        const result = await apiRequest<{ markdown: string }>("/api/ai-image-to-markdown", {
          ...init, body: JSON.stringify({ documentPath, imageSource: popup.image.src, alt: popup.image.alt }),
        });
        markdown = result.markdown;
      } else if (action === "rewrite") {
        const result = await apiRequest<{ rewrittenText: string }>("/api/ai-rewrite", {
          ...init, body: JSON.stringify({ text, prompt: prompt.trim() }),
        });
        markdown = result.rewrittenText;
      } else {
        const result = await apiRequest<{ formattedText: string }>("/api/ai-format", {
          ...init, body: JSON.stringify({ text }),
        });
        markdown = result.formattedText;
      }
      if (controller.signal.aborted || editor.isDestroyed) return;
      if (!tracked.isValid()) throw new Error("The selected content changed while AI was working. Select it again and retry.");
      if (!markdown?.trim()) throw new Error("AI returned an empty response. Please retry.");
      tracked.dispose();
      replaceTiptapRangeWithMarkdown(editor, tracked.range, markdown);
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

  const selectedHeadings = popup ? getTiptapHeadings(editor, popup).filter((heading) => heading.selected) : [];
  const hasText = popup ? !!getTiptapSelectionMarkdown(editor, popup).trim() : false;
  const canIndent = selectedHeadings.some(({ node }) => node.attrs.level < 6);
  const canUnindent = selectedHeadings.some(({ node }) => node.attrs.level > 1);

  return <>
    <button ref={buttonRef} type="button" aria-label="Enumerate Headings" title="Enumerate Headings"
      aria-haspopup="menu" aria-expanded={popup?.kind === "headings"} disabled={!hasHeadings || !!working}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (popup?.kind === "headings") { setPopup(null); return; }
        const rect = buttonRef.current!.getBoundingClientRect();
        const { from, to } = editor.state.selection;
        setStartAt("1");
        setPopup({ kind: "headings", from, to, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 200)) });
      }}><ListOrdered aria-hidden className="h-4 w-4" /></button>
    {working ? <span role="status" className="flex items-center gap-1 px-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />{working === "image" ? "Converting image…" : working === "rewrite" ? "Rewriting…" : "Formatting…"}</span> : null}
    {popup ? createPortal(
      <div ref={menuRef} role="menu" aria-label={popup.kind === "headings" ? "Heading numbering" : "Editor actions"}
        className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
        style={{ left: popup.x, top: popup.y, maxHeight: "calc(100vh - 16px)" }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          event.preventDefault();
        }}>
        {popup.kind === "context" ? <>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!!working || !hasText} onClick={() => void runAi("format")}><Sparkles aria-hidden className="h-4 w-4" />AI Format</button>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!canIndent} onClick={() => { changeTiptapHeadingLevels(editor, popup, "indent"); setPopup(null); editor.commands.focus(); }}><ListIndentIncrease aria-hidden className="h-4 w-4" />Indent Headings</button>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!canUnindent} onClick={() => { changeTiptapHeadingLevels(editor, popup, "unindent"); setPopup(null); editor.commands.focus(); }}><ListIndentDecrease aria-hidden className="h-4 w-4" />Unindent Headings</button>
        </> : null}
        <button type="button" role="menuitem" className={menuItemClass} disabled={!hasHeadings} onClick={() => enumerate("all")}><ListOrdered aria-hidden className="h-4 w-4" />Enumerate All Headings</button>
        <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); enumerate("selected"); }}>
          <label className="block text-xs font-medium text-muted-foreground" htmlFor="visual-heading-start">Enumerate Selected Headings</label>
          <div className="mt-1 flex items-center gap-2">
            <input id="visual-heading-start" aria-label="Selected heading start value" type="number" min="1" step="1" value={startAt} disabled={!selectedHeadings.length}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-sm" onChange={(event) => setStartAt(event.target.value)} />
            <button type="submit" disabled={!selectedHeadings.length} className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50">Apply</button>
          </div>
        </form>
        {popup.kind === "context" ? <>
          <form className="mt-1 border-t border-border px-2 py-2" onSubmit={(event) => { event.preventDefault(); void runAi("rewrite"); }}>
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="visual-ai-rewrite">AI Rewrite</label>
            <div className="mt-1 flex items-center gap-2">
              <input id="visual-ai-rewrite" placeholder="Prompt..." value={prompt} disabled={!!working || !hasText}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-sm" onChange={(event) => setPrompt(event.target.value)} />
              <button type="submit" aria-label="Rewrite selected text" disabled={!!working || !hasText || !prompt.trim()} className="h-8 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"><Sparkles aria-hidden className="h-4 w-4" /></button>
            </div>
          </form>
          {popup.image ? <button type="button" role="menuitem" className={menuItemClass} disabled={!!working} onClick={() => void runAi("image")}><ImageIcon aria-hidden className="h-4 w-4" />AI Image to Markdown</button> : null}
        </> : null}
      </div>, document.body,
    ) : null}
  </>;
}
