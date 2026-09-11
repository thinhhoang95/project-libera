"use client";

import { useRef, useState, type RefObject } from "react";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";

export function ChatFileComposer({ chatId, value, disabled, files, tabs, composerRef, onChange, onAttach, onLoading, onError, onSend }: {
  chatId: string; value: string; disabled: boolean; files: LiberaFileNode[]; tabs: OpenTab[];
  composerRef: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void;
  onAttach: (context: ChatContext) => void; onLoading: (loading: boolean) => void;
  onError: (message: string) => void; onSend: () => void;
}) {
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const matches = files.filter((file) => file.fileType === "markdown" && file.path.toLocaleLowerCase().includes(mention?.query.toLocaleLowerCase() ?? ""))
    .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(mention?.query.toLocaleLowerCase() ?? "")) - Number(!b.name.toLocaleLowerCase().startsWith(mention?.query.toLocaleLowerCase() ?? "")) || a.path.localeCompare(b.path));
  const index = Math.min(selected, Math.max(0, matches.length - 1));

  function locate(input: HTMLTextAreaElement) {
    const prefix = input.value.slice(0, input.selectionStart);
    const match = input.selectionStart === input.selectionEnd && prefix.match(/(?:^|\s)@([^@\s]*)$/);
    setMention(match ? { start: input.selectionStart - match[1].length - 1, end: input.selectionStart, query: match[1] } : null);
    setSelected(0);
  }

  async function attach(file: LiberaFileNode) {
    if (!mention || busy.current) return;
    busy.current = true;
    setLoading(true); onLoading(true); onError("");
    try {
      const tab = tabs.find((item) => !item.untitled && item.file.path === file.path);
      const payload = tab ? null : await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(file.path)}`);
      const text = tab?.draft ?? payload?.content;
      if (typeof text !== "string" || (payload && payload.file.fileType !== "markdown")) throw new Error(`Could not read ${file.name}.`);
      if (text.length > 500_000) throw new Error(`${file.name} is too large to attach (maximum 500,000 characters).`);
      onAttach({ kind: "document", path: file.path, name: file.name, text });
      const replacement = `@${file.name} `;
      onChange(value.slice(0, mention.start) + replacement + value.slice(mention.end));
      const caret = mention.start + replacement.length;
      setMention(null);
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
    } catch (error) { onError(error instanceof Error ? error.message : "Could not attach file."); }
    finally { busy.current = false; setLoading(false); onLoading(false); }
  }

  return <div className="relative">
    {mention && <div className="absolute bottom-full z-50 mb-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg" role="listbox" id={`chat-files-${chatId}`} aria-label="Notebook Markdown files">
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">Attaching file…</p> : matches.length ? matches.map((file, i) => <button
        key={file.path} id={`chat-file-${chatId}-${i}`} type="button" role="option" aria-selected={i === index}
        className={`block w-full rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => void attach(file)}
      ><span className="block truncate font-medium">{file.name}</span><span className="block truncate text-muted-foreground">{file.path}</span></button>) : <p className="p-2 text-xs text-muted-foreground">No matching Markdown files</p>}
    </div>}
    <textarea ref={composerRef} aria-label="Chat prompt" aria-autocomplete="list" aria-controls={mention ? `chat-files-${chatId}` : undefined} aria-activedescendant={mention && matches.length ? `chat-file-${chatId}-${index}` : undefined}
      placeholder="Ask about your document… Type @ to add files" rows={3} className="block w-full resize-none rounded-lg border border-border bg-muted p-3 text-sm outline-none focus:border-accent"
      value={value} disabled={disabled || loading} onChange={(event) => { onChange(event.target.value); locate(event.currentTarget); }}
      onSelect={(event) => locate(event.currentTarget)} onBlur={() => setMention(null)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (mention) {
          if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
            event.preventDefault(); const next = (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            setSelected(next); window.document.getElementById(`chat-file-${chatId}-${next}`)?.scrollIntoView?.({ block: "nearest" }); return;
          }
          if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && matches.length)) {
            event.preventDefault(); if (matches[index]) void attach(matches[index]); return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} />
  </div>;
}
