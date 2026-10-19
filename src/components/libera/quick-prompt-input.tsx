"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Sparkles } from "lucide-react";
import { insertQuickPrompt, matchingQuickPrompts, type QuickPrompt } from "@/lib/quick-prompts";
import { DictationButton, DictationStatus, useDictation } from "@/components/libera/audio/dictation";

/** The slash-command prompts configured in Preferences → AI, shared by the chat
 * composer and the editors' AI prompt fields. */
export const QuickPromptsContext = createContext<QuickPrompt[]>([]);

type Invocation = { start: number; end: number; query: string };

/** A one-line AI prompt field that grows with its content and expands `/name`
 * into the matching quick prompt. Enter submits; Shift+Enter adds a line. Its
 * microphone types a spoken prompt, transcribed like voice memos. */
export function QuickPromptInput({ id, value, placeholder = "Prompt… Type / for prompts", disabled, inputRef, ariaLabel, onChange, onSubmit, onEscape }: {
  id: string; value: string; placeholder?: string; disabled?: boolean; ariaLabel?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void; onSubmit: () => void; onEscape?: () => void;
}) {
  const quickPrompts = useContext(QuickPromptsContext);
  const [invocation, setInvocation] = useState<Invocation | null>(null);
  const [selected, setSelected] = useState(0);
  const matches = invocation ? matchingQuickPrompts(quickPrompts, invocation.query) : [];
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const listId = `${id}-quick-prompts`;
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  }, [value, onChange]);
  // Spoken text goes in at the caret, with spaces around it as needed.
  const dictation = useDictation((spoken) => {
    const { value: current, onChange: change } = latest.current;
    const input = inputRef?.current ?? document.getElementById(id) as HTMLTextAreaElement | null;
    const focused = input && document.activeElement === input;
    const start = focused ? input.selectionStart : current.length;
    const end = focused ? input.selectionEnd : current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}${spoken}${after && !/^\s/.test(after) ? " " : ""}`;
    change(before + inserted + after);
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(caret, caret); });
  });

  function locate(input: HTMLTextAreaElement) {
    const match = quickPrompts.length && input.selectionStart === input.selectionEnd
      ? input.value.slice(0, input.selectionStart).match(/(?:^|\s)\/([^/\s]*)$/)
      : null;
    setInvocation(match ? { start: input.selectionStart - match[1].length - 1, end: input.selectionStart, query: match[1] } : null);
    setSelected(0);
  }

  function apply(quickPrompt: QuickPrompt) {
    if (!invocation) return;
    const insertion = insertQuickPrompt(value, invocation.start, invocation.end, quickPrompt.prompt);
    onChange(insertion.value);
    setInvocation(null);
    requestAnimationFrame(() => {
      const input = inputRef?.current ?? document.getElementById(id) as HTMLTextAreaElement | null;
      input?.focus();
      input?.setSelectionRange(insertion.selectionStart, insertion.selectionEnd);
    });
  }

  return <div className="min-w-0 flex-1">
    <DictationStatus dictation={dictation} />
    <div className="relative">
    <span className="absolute bottom-0.5 right-1 z-10"><DictationButton dictation={dictation} disabled={disabled} /></span>
    <textarea ref={inputRef} id={id} aria-label={ariaLabel} rows={1} placeholder={placeholder} value={value} disabled={disabled}
      aria-autocomplete="list" aria-controls={invocation ? listId : undefined} aria-activedescendant={invocation && matches.length ? `${listId}-${index}` : undefined}
      className="block max-h-40 min-h-8 w-full resize-none overflow-auto rounded-md border border-border bg-card py-1.5 pl-2 pr-9 text-sm leading-5 outline-none [field-sizing:content] focus:border-input"
      onChange={(event) => { onChange(event.target.value); locate(event.currentTarget); }}
      onSelect={(event) => locate(event.currentTarget)} onBlur={() => setInvocation(null)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        // Escape stops a dictation before it closes the prompt.
        if (event.key === "Escape" && dictation.state !== "idle") { event.preventDefault(); event.stopPropagation(); dictation.cancel(); return; }
        if (invocation) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setInvocation(null); return; }
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
            event.preventDefault();
            const next = (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            setSelected(next);
            document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: "nearest" });
            return;
          }
          if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
            if (matches[index]) { event.preventDefault(); apply(matches[index]); return; }
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); }
        else if (event.key === "Escape" && onEscape) { event.preventDefault(); onEscape(); }
      }} />
    </div>
    {invocation ? <div role="listbox" id={listId} aria-label="Quick prompts" className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-card p-1">
      {matches.length ? matches.map((quickPrompt, i) => <button key={quickPrompt.identifier} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
        className={`flex w-full items-start gap-2 rounded p-1.5 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => apply(quickPrompt)}
      ><Sparkles aria-hidden className="mt-0.5 shrink-0 text-accent" size={13} /><span className="min-w-0"><span className="block truncate font-medium">/{quickPrompt.identifier}</span><span className="block truncate text-muted-foreground">{quickPrompt.prompt.replace(/\s+/g, " ").trim()}</span></span></button>)
        : <p className="p-1.5 text-xs text-muted-foreground">No matching quick prompts</p>}
    </div> : null}
  </div>;
}
