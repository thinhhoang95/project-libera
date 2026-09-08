"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Mathematics } from "@tiptap/extension-mathematics";
import { Bold, Italic, Underline, List, ListOrdered, Code2, Quote, Undo2, Redo2, ImagePlus, Sigma, Link2, Highlighter, RemoveFormatting, Save } from "lucide-react";
import katex from "katex";
import { createMarkdownExtensions } from "@/lib/tiptap-markdown";
import { MARKDOWN_HIGHLIGHT_COLORS, MARKDOWN_TEXT_COLORS } from "@/lib/markdown-colors";
import { apiRequest } from "@/components/libera/api-client";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { MarkdownDisplayZoom } from "@/components/libera/markdown-display-zoom";
import { TiptapEditorActions } from "@/components/libera/tiptap-editor-actions";
import type { MarkdownImageAssetPayload } from "@/lib/types";

type Props = {
  documentPath: string;
  value: string;
  fontSizePx: number;
  lineHeight: number;
  markdownZoom: number;
  onMarkdownZoomChange: (zoom: number) => void;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  onOpenFileLink: (href: string) => Promise<boolean>;
};

type MathDraft = { latex: string; display: boolean; from: number; to: number; existing: boolean };
const buttonClass = "rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground";
const selectClass = "rounded-md border border-border bg-card px-2 py-1.5 text-xs";
const isImage = (file: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);

export function TiptapMarkdownEditor({ documentPath, value, fontSizePx, lineHeight, markdownZoom, onMarkdownZoomChange, onChange, onSave, onOpenFileLink }: Props) {
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ href: string; from: number; to: number } | null>(null);
  const [error, setError] = useState("");
  const [uploadCount, setUploadCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const lastValue = useRef(value);
  const uploads = useRef(new Set<{ pos: number; controller: AbortController }>());
  const extensions = useMemo(() => [
    ...createMarkdownExtensions(documentPath),
    Mathematics.configure({
      katexOptions: { throwOnError: false, trust: false },
      inlineOptions: { onClick: (node, pos) => setMathDraft({ latex: node.attrs.latex, display: false, from: pos, to: pos + node.nodeSize, existing: true }) },
      blockOptions: { onClick: (node, pos) => setMathDraft({ latex: node.attrs.latex, display: true, from: pos, to: pos + node.nodeSize, existing: true }) },
    }),
  ], [documentPath]);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "libera-tiptap", role: "textbox", "aria-label": "Visual Markdown editor", "aria-multiline": "true" },
      handleDrop(view, event, _slice, moved) {
        if (moved || !event.dataTransfer?.files.length) return false;
        event.preventDefault();
        setDragging(false);
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        void insertImages(Array.from(event.dataTransfer.files), pos);
        return true;
      },
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some(isImage)) return false;
        event.preventDefault();
        void insertImages(files, view.state.selection.from);
        return true;
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
      const markdown = current.getMarkdown();
      lastValue.current = markdown;
      onChange(markdown);
    },
    onTransaction({ transaction }) {
      for (const upload of uploads.current) upload.pos = transaction.mapping.map(upload.pos);
    },
  });

  const state = useEditorState({ editor, selector: ({ editor: observedEditor }) => {
    // With deferred rendering, TipTap's state subscription can still hold its
    // initial null snapshot until the first transaction. Read the new editor
    // directly so EditorContent can mount without waiting for that transaction.
    const current = observedEditor ?? editor;
    return current ? {
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"),
    bulletList: current.isActive("bulletList"), orderedList: current.isActive("orderedList"),
    blockquote: current.isActive("blockquote"), codeBlock: current.isActive("codeBlock"), highlight: current.isActive("highlight"),
    heading: current.isActive("heading") ? String(current.getAttributes("heading").level) : "0",
    fontSize: current.getAttributes("textStyle").fontSize ?? "",
    lineHeight: current.getAttributes("textStyle").lineHeight ?? "",
    color: current.getAttributes("textStyle").color ?? "",
    highlightColor: current.getAttributes("highlight").color ?? "#fef08a",
    undo: current.can().undo(), redo: current.can().redo(),
    } : null;
  } });

  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    // Parent echoes must never reset the cursor or undo history. Only external
    // document changes (e.g. source edits) replace the editor document.
    lastValue.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    const pending = uploads.current;
    return () => { for (const upload of pending) upload.controller.abort(); };
  }, []);

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
        const payload = await apiRequest<MarkdownImageAssetPayload>("/api/markdown-assets", { method: "POST", body: formData, signal: upload.controller.signal });
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

  function openMath() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const node = editor.state.doc.nodeAt(from);
    const existing = node?.type.name === "inlineMath" || node?.type.name === "blockMath";
    setMathDraft({ from, to: existing ? from + node!.nodeSize : to, existing, display: node?.type.name === "blockMath", latex: existing ? node!.attrs.latex : editor.state.doc.textBetween(from, to) });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <div aria-label="Visual editor formatting" role="toolbar" tabIndex={0}
        className="flex min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-border px-3 py-1.5 [scrollbar-width:thin] [&>*]:shrink-0">
        <MarkdownDisplayZoom markdownBaseFontSize={fontSizePx / (markdownZoom / 100)} markdownZoom={markdownZoom} onMarkdownZoomChange={onMarkdownZoomChange} />
        <TiptapEditorActions editor={editor} documentPath={documentPath} onError={setError} />
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
        {[
          { title: "Bold", icon: Bold, active: state.bold, run: () => editor.chain().focus().toggleBold().run() },
          { title: "Italic", icon: Italic, active: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
          { title: "Underline", icon: Underline, active: state.underline, run: () => editor.chain().focus().toggleUnderline().run() },
          { title: "Highlight", icon: Highlighter, active: state.highlight, run: () => editor.chain().focus().toggleHighlight({ color: state.highlightColor }).run() },
          { title: "Bullet list", icon: List, active: state.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
          { title: "Numbered list", icon: ListOrdered, active: state.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
          { title: "Quote", icon: Quote, active: state.blockquote, run: () => editor.chain().focus().toggleBlockquote().run() },
          { title: "Code block", icon: Code2, active: state.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
        ].map(({ title, icon: Icon, active, run }) => <button key={title} type="button" title={title} aria-label={title} aria-pressed={active} className={buttonClass} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></button>)}
        <select aria-label="Highlight color" className={selectClass} value={state.highlightColor} onChange={(event) => editor.chain().focus().setHighlight({ color: event.target.value }).run()}>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => <option key={color.value} value={color.value}>{color.label} highlight</option>)}
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
        <button type="button" aria-label="Save document" title="Save document" className={buttonClass} onClick={() => void onSave()}><Save className="h-4 w-4" /></button>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" aria-label="Choose images" onChange={(event) => { void insertImages(Array.from(event.target.files ?? []), editor.state.selection.from); event.target.value = ""; }} />
      </div>
      {error ? <div role="alert" className="flex items-center justify-between bg-destructive-muted px-4 py-2 text-sm text-destructive">{error}<button type="button" onClick={() => setError("")}>Dismiss</button></div> : null}
      <div className={`min-h-0 flex-1 overflow-auto p-6 ${dragging ? "ring-2 ring-inset ring-primary" : ""}`} style={{ fontSize: fontSizePx, lineHeight }}
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
      <div role="status" className="border-t border-border px-4 py-1.5 text-xs text-muted-foreground">{uploadCount ? "Uploading images…" : "Drop or paste photos · Click an equation to edit · ⌘/Ctrl-click a link to open"}</div>
      <ModalDialog open={!!mathDraft} title={mathDraft?.existing ? "Edit equation" : "Insert equation"} description="Write LaTeX without the surrounding dollar signs." panelClassName="max-w-xl" onClose={() => setMathDraft(null)} footer={<>
        <button type="button" className={selectClass} onClick={() => setMathDraft(null)}>Cancel</button>
        <button type="button" disabled={!!mathPreview.error} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" onClick={() => {
          if (!mathDraft) return;
          editor.chain().focus().insertContentAt({ from: mathDraft.from, to: mathDraft.to }, { type: mathDraft.display ? "blockMath" : "inlineMath", attrs: { latex: mathDraft.latex.trim() } }).run();
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
          if (linkDraft.from === linkDraft.to && !editor.isActive("link")) chain.insertContent({ type: "text", text: linkDraft.href, marks: [{ type: "link", attrs: { href: linkDraft.href } }] }).run();
          else chain.setLink({ href: linkDraft.href.trim() }).run();
        } else chain.unsetLink().run();
        setLinkDraft(null);
      }}>Apply link</button>}>
        <input autoFocus aria-label="Link URL or file path" placeholder="https://… or notebook/note.md" className="w-full rounded-md border border-border bg-background p-2" value={linkDraft?.href ?? ""} onChange={(event) => setLinkDraft((current) => current ? { ...current, href: event.target.value } : null)} />
      </ModalDialog>
    </div>
  );
}
