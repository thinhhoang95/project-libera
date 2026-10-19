"use client";

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FileText, Image as ImageIcon, MessageSquareText, ScrollText, Sparkles } from "lucide-react";
import { findFileSuggestions, indexFileSuggestions } from "@/lib/file-suggestions";
import type { LiberaFileNode } from "@/lib/types";
import { insertQuickPrompt, matchingQuickPrompts, type QuickPrompt } from "@/lib/quick-prompts";
import { DictationButton, DictationStatus, useDictation } from "@/components/libera/audio/dictation";

type ComposerInvocation = { kind: "file" | "quick-prompt"; start: number; end: number; query: string };

/** A document whose review comments an @Comments mention can bring in; `current` is the one in view. */
export type ChatCommentTarget = { path: string; name: string; current: boolean };

/** @Comments entries for a query: all of them while it could still spell "comments", else those whose file name matches. */
export function matchingCommentTargets(targets: ChatCommentTarget[], query: string) {
  const lower = query.toLowerCase();
  if (!lower || "comments".startsWith(lower)) return targets;
  const name = lower.replace(/^comments?:?/, "");
  return lower.startsWith("comment") || name !== lower ? targets.filter((target) => target.name.toLowerCase().includes(name)) : [];
}

export function ChatFileComposer({ chatId, value, placeholder = "Ask a follow-up… Type @ for files or / for prompts", disabled, files, quickPrompts = [], commentTargets = [], composerRef, onChange, onAttachFile, onAttachComments, onSend, dictation: canDictate = true }: {
  chatId: string; value: string; placeholder?: string; disabled: boolean; files: LiberaFileNode[];
  quickPrompts?: QuickPrompt[];
  /** Offered as @Comments entries above the files; needs onAttachComments. */
  commentTargets?: ChatCommentTarget[];
  onAttachComments?: (target: ChatCommentTarget) => Promise<boolean>;
  /** A microphone button that types what is said, transcribed like voice memos. */
  dictation?: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void;
  onAttachFile: (file: LiberaFileNode) => Promise<boolean>; onSend: () => void;
}) {
  const [invocation, setInvocation] = useState<ComposerInvocation | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const fileQuery = invocation?.kind === "file" ? invocation.query : null;
  const searchingFiles = fileQuery !== null;
  const fileIndex = useMemo(() => searchingFiles ? indexFileSuggestions(files) : [], [files, searchingFiles]);
  const suggestions = useMemo(() => fileQuery === null ? null : findFileSuggestions(fileIndex, fileQuery), [fileIndex, fileQuery]);
  const fileMatches = suggestions?.files ?? [];
  const commentMatches = fileQuery !== null && onAttachComments ? matchingCommentTargets(commentTargets, fileQuery) : [];
  const promptMatches = invocation?.kind === "quick-prompt" ? matchingQuickPrompts(quickPrompts, invocation.query) : [];
  const matchCount = invocation?.kind === "file" ? commentMatches.length + fileMatches.length : promptMatches.length;
  const index = Math.min(selected, Math.max(0, matchCount - 1));
  const listId = `chat-suggestions-${chatId}`;
  // Spoken text goes in at the caret, separated from the text around it by spaces.
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  }, [value, onChange]);
  const dictation = useDictation((spoken) => {
    const { value: current, onChange: change } = latest.current;
    const input = composerRef.current;
    const start = input && document.activeElement === input ? input.selectionStart : current.length;
    const end = input && document.activeElement === input ? input.selectionEnd : current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}${spoken}${after && !/^\s/.test(after) ? " " : ""}`;
    change(before + inserted + after);
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
  });

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
    setLoading(true);
    try {
      if (!await onAttachFile(file)) return;
      const replacement = `@${file.name} `;
      onChange(value.slice(0, invocation.start) + replacement + value.slice(invocation.end));
      const caret = invocation.start + replacement.length;
      setInvocation(null);
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
    } finally { busy.current = false; setLoading(false); }
  }

  async function attachComments(target: ChatCommentTarget) {
    if (invocation?.kind !== "file" || busy.current || !onAttachComments) return;
    busy.current = true;
    setLoading(true);
    try {
      if (!await onAttachComments(target)) return;
      const replacement = target.current ? "@Comments " : `@Comments:${target.name} `;
      onChange(value.slice(0, invocation.start) + replacement + value.slice(invocation.end));
      const caret = invocation.start + replacement.length;
      setInvocation(null);
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
    } finally { busy.current = false; setLoading(false); }
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
      if (commentMatches[matchIndex]) void attachComments(commentMatches[matchIndex]);
      else if (fileMatches[matchIndex - commentMatches.length]) void attach(fileMatches[matchIndex - commentMatches.length]);
    } else if (promptMatches[matchIndex]) {
      applyQuickPrompt(promptMatches[matchIndex]);
    }
  }

  return <div className="relative">
    {invocation && <div className="absolute bottom-full z-50 mb-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg" role="listbox" id={listId} aria-label={invocation.kind === "file" ? "Notebook files" : "Quick prompts"}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden="true">{invocation.kind === "file" ? <FileText size={13} /> : <Sparkles size={13} />}{invocation.kind === "file" ? "Reference files" : "Quick prompts"}</div>
      {!loading && commentMatches.map((target, i) => <button
        key={`comments:${target.path}`} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
        className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => void attachComments(target)}
      ><MessageSquareText aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" size={14} /><span className="min-w-0"><span className="block truncate font-medium">Comments{target.current ? "" : `: ${target.name}`}</span><span className="block truncate text-muted-foreground">{target.current ? `Review comments and replies on ${target.name}` : target.path}</span></span></button>)}
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">Attaching…</p> : invocation.kind === "file" ? fileMatches.length ? fileMatches.map((file, position) => { const i = commentMatches.length + position; return <button
        key={file.path} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
        className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => void attach(file)}
      >{file.fileType === "image" ? <ImageIcon aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" size={14} /> : file.fileType === "pdf" ? <ScrollText aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" size={14} /> : <FileText aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" size={14} />}<span className="min-w-0"><span className="block truncate font-medium">{file.name}</span><span className="block truncate text-muted-foreground">{file.path}</span></span></button>; }) : !commentMatches.length && <p className="p-2 text-xs text-muted-foreground">No matching files</p>
        : promptMatches.length ? promptMatches.map((quickPrompt, i) => <button
          key={quickPrompt.identifier} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
          className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => applyQuickPrompt(quickPrompt)}
        ><Sparkles aria-hidden className="mt-0.5 shrink-0 text-accent" size={14} /><span className="min-w-0"><span className="block truncate font-medium">/{quickPrompt.identifier}</span><span className="block truncate text-muted-foreground">{quickPrompt.prompt.replace(/\s+/g, " ").trim()}</span></span></button>) : <p className="p-2 text-xs text-muted-foreground">No matching quick prompts</p>}
      {invocation.kind === "file" && suggestions?.hasMore && <p className="p-2 text-xs text-muted-foreground">Showing the first 50 matches. Keep typing to narrow the results.</p>}
    </div>}
    {canDictate && <DictationStatus dictation={dictation} />}
    {canDictate && <span className="absolute bottom-2 right-2 z-10"><DictationButton dictation={dictation} disabled={disabled || loading} /></span>}
    <textarea ref={composerRef} aria-label="Chat prompt" aria-autocomplete="list" aria-controls={invocation ? listId : undefined} aria-activedescendant={invocation && matchCount ? `${listId}-${index}` : undefined}
      placeholder={placeholder} rows={1} className={`block w-full resize-none rounded-lg border border-border bg-muted p-3 text-sm outline-none focus:border-accent ${canDictate ? "pr-10" : ""}`}
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
