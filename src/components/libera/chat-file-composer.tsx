"use client";

import { useRef, useState, type RefObject } from "react";
import { FileText, Sparkles } from "lucide-react";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { ChatContext } from "@/lib/document-chat";
import { insertQuickPrompt, matchingQuickPrompts, type QuickPrompt } from "@/lib/quick-prompts";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";

type ComposerInvocation = { kind: "file" | "quick-prompt"; start: number; end: number; query: string };

export function ChatFileComposer({ chatId, value, placeholder = "Ask a follow-up… Type @ for files or / for prompts", disabled, files, tabs, quickPrompts = [], documentContexts = [], composerRef, onChange, onAttach, onLoading, onError, onSend }: {
  chatId: string; value: string; placeholder?: string; disabled: boolean; files: LiberaFileNode[]; tabs: OpenTab[];
  quickPrompts?: QuickPrompt[];
  documentContexts?: ChatContext[];
  composerRef: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void;
  onAttach: (context: ChatContext) => void; onLoading: (loading: boolean) => void;
  onError: (message: string) => void; onSend: () => void;
}) {
  const [invocation, setInvocation] = useState<ComposerInvocation | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const fileMatches = invocation?.kind === "file" ? files.filter((file) => file.fileType === "markdown" && file.path.toLocaleLowerCase().includes(invocation.query.toLocaleLowerCase()))
    .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(invocation.query.toLocaleLowerCase())) - Number(!b.name.toLocaleLowerCase().startsWith(invocation.query.toLocaleLowerCase())) || a.path.localeCompare(b.path)) : [];
  const promptMatches = invocation?.kind === "quick-prompt" ? matchingQuickPrompts(quickPrompts, invocation.query) : [];
  const matchCount = invocation?.kind === "file" ? fileMatches.length : promptMatches.length;
  const index = Math.min(selected, Math.max(0, matchCount - 1));
  const listId = `chat-suggestions-${chatId}`;

  function locate(input: HTMLTextAreaElement) {
    const prefix = input.value.slice(0, input.selectionStart);
    const fileMatch = input.selectionStart === input.selectionEnd && prefix.match(/(?:^|\s)@([^@\s]*)$/);
    const promptMatch = !fileMatch && input.selectionStart === input.selectionEnd && prefix.match(/(?:^|\s)\/([^/\s]*)$/);
    const match = fileMatch ?? promptMatch;
    setInvocation(match ? { kind: fileMatch ? "file" : "quick-prompt", start: input.selectionStart - match[1].length - 1, end: input.selectionStart, query: match[1] } : null);
    setSelected(0);
  }

  async function attach(file: LiberaFileNode) {
    if (invocation?.kind !== "file" || busy.current) return;
    busy.current = true;
    setLoading(true); onLoading(true); onError("");
    try {
      const tab = tabs.find((item) => !item.untitled && item.file.path === file.path);
      const existing = documentContexts.find((context) => context.kind === "document" && context.path === file.path);
      const payload = existing || tab ? null : await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(file.path)}`);
      const text = existing?.text ?? tab?.draft ?? payload?.content;
      if (typeof text !== "string" || (payload && payload.file.fileType !== "markdown")) throw new Error(`Could not read ${file.name}.`);
      if (text.length > 500_000) throw new Error(`${file.name} is too large to attach (maximum 500,000 characters).`);
      onAttach({ kind: "document", path: file.path, name: file.name, text });
      const replacement = `@${file.name} `;
      onChange(value.slice(0, invocation.start) + replacement + value.slice(invocation.end));
      const caret = invocation.start + replacement.length;
      setInvocation(null);
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
    } catch (error) { onError(error instanceof Error ? error.message : "Could not attach file."); }
    finally { busy.current = false; setLoading(false); onLoading(false); }
  }

  function applyQuickPrompt(quickPrompt: QuickPrompt) {
    if (invocation?.kind !== "quick-prompt") return;
    const insertion = insertQuickPrompt(value, invocation.start, invocation.end, quickPrompt.prompt);
    onChange(insertion.value);
    setInvocation(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(insertion.selectionStart, insertion.selectionEnd);
    });
  }

  function chooseMatch(matchIndex: number) {
    if (invocation?.kind === "file") {
      if (fileMatches[matchIndex]) void attach(fileMatches[matchIndex]);
    } else if (promptMatches[matchIndex]) {
      applyQuickPrompt(promptMatches[matchIndex]);
    }
  }

  return <div className="relative">
    {invocation && <div className="absolute bottom-full z-50 mb-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg" role="listbox" id={listId} aria-label={invocation.kind === "file" ? "Notebook Markdown files" : "Quick prompts"}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden="true">{invocation.kind === "file" ? <FileText size={13} /> : <Sparkles size={13} />}{invocation.kind === "file" ? "Reference files" : "Quick prompts"}</div>
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">Attaching file…</p> : invocation.kind === "file" ? fileMatches.length ? fileMatches.map((file, i) => <button
        key={file.path} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
        className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => void attach(file)}
      ><FileText aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" size={14} /><span className="min-w-0"><span className="block truncate font-medium">{file.name}</span><span className="block truncate text-muted-foreground">{file.path}</span></span></button>) : <p className="p-2 text-xs text-muted-foreground">No matching Markdown files</p>
        : promptMatches.length ? promptMatches.map((quickPrompt, i) => <button
          key={quickPrompt.identifier} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
          className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => applyQuickPrompt(quickPrompt)}
        ><Sparkles aria-hidden className="mt-0.5 shrink-0 text-accent" size={14} /><span className="min-w-0"><span className="block truncate font-medium">/{quickPrompt.identifier}</span><span className="block truncate text-muted-foreground">{quickPrompt.prompt.replace(/\s+/g, " ").trim()}</span></span></button>) : <p className="p-2 text-xs text-muted-foreground">No matching quick prompts</p>}
    </div>}
    <textarea ref={composerRef} aria-label="Chat prompt" aria-autocomplete="list" aria-controls={invocation ? listId : undefined} aria-activedescendant={invocation && matchCount ? `${listId}-${index}` : undefined}
      placeholder={placeholder} rows={1} className="block w-full resize-none rounded-lg border border-border bg-muted p-3 text-sm outline-none focus:border-accent"
      value={value} disabled={disabled || loading} onChange={(event) => { onChange(event.target.value); locate(event.currentTarget); }}
      onSelect={(event) => locate(event.currentTarget)} onBlur={() => setInvocation(null)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (invocation) {
          if (event.key === "Escape") { event.preventDefault(); setInvocation(null); return; }
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matchCount) {
            event.preventDefault(); const next = (index + (event.key === "ArrowDown" ? 1 : -1) + matchCount) % matchCount;
            setSelected(next); window.document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: "nearest" }); return;
          }
          if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && matchCount)) {
            event.preventDefault(); chooseMatch(index); return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} />
  </div>;
}
