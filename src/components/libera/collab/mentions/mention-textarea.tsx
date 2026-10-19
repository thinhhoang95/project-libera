"use client";

// A comment box with an @ member picker (plan M2.3), used by Review Mode on
// shared documents. Typing "@" lists the notebook's members
// (ControlRoutes.members); picking one inserts "@Name" and reports the
// member's id through onMentionsChange, so the request carries `mentions`
// and the server notifies them.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import type { Member } from "@/lib/collab/local-api";
import { collabClient } from "@/lib/collab/ui/client";
import { filterMentionCandidates, insertMention, mentionIds, mentionQueryAt, type MentionCandidate } from "@/lib/collab/review-store/mentions";

const memberCache = new Map<string, Promise<Member[]>>();

/** Members of a shared notebook, fetched once per project per window (a failure is retried next time). */
export function loadProjectMembers(projectId: string, fetchMembers: (projectId: string) => Promise<Member[]> = collabClient.members): Promise<Member[]> {
  let request = memberCache.get(projectId);
  if (!request) {
    request = fetchMembers(projectId).catch((error: unknown) => {
      memberCache.delete(projectId);
      throw error;
    });
    memberCache.set(projectId, request);
  }
  return request;
}

/** Forgets cached member lists (a member joined or left). */
export function forgetProjectMembers(projectId?: string) {
  if (projectId) memberCache.delete(projectId);
  else memberCache.clear();
}

export function useProjectMembers(projectId: string | null | undefined): Member[] {
  const [members, setMembers] = useState<{ projectId: string; list: Member[] } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadProjectMembers(projectId).then(
      (list) => { if (live) setMembers({ projectId, list }); },
      () => { if (live) setMembers({ projectId, list: [] }); },
    );
    return () => { live = false; };
  }, [projectId]);
  return members && members.projectId === projectId ? members.list : EMPTY;
}

const EMPTY: Member[] = [];

export type MentionTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  /** The ids of members mentioned in the current text. */
  onMentionsChange?: (ids: string[]) => void;
  /** Not offered in the list (the author). */
  selfId?: string | null;
  /** Members to offer instead of fetching them (tests). */
  members?: MentionCandidate[];
};

export function MentionTextarea({ projectId, value, onChange, onMentionsChange, selfId, members: given, onKeyDown, className, ...rest }: MentionTextareaProps) {
  const listId = useId();
  const fetched = useProjectMembers(given ? null : projectId);
  const members: MentionCandidate[] = given ?? fetched;
  const input = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const options = useMemo(() => (query ? filterMentionCandidates(members, query.query, selfId) : []), [members, query, selfId]);
  const open = !!query && options.length > 0;

  const mentions = useMemo(() => mentionIds(value, picked), [value, picked]);
  const report = useRef(onMentionsChange);
  useEffect(() => { report.current = onMentionsChange; });
  const reported = useRef("");
  useEffect(() => {
    const key = mentions.join(",");
    if (key === reported.current) return;
    reported.current = key;
    report.current?.(mentions);
  }, [mentions]);

  function track(text: string, caret: number) {
    const next = mentionQueryAt(text, caret);
    setQuery(next);
    if (next?.query !== query?.query) setActive(0);
  }

  function pick(candidate: MentionCandidate) {
    const element = input.current;
    if (!query || !element) return;
    const caret = element.selectionStart ?? value.length;
    const next = insertMention(value, caret, query.start, candidate);
    setPicked((current) => (current.some((item) => item.id === candidate.id) ? current : [...current, candidate]));
    setQuery(null);
    onChange(next.text);
    // After React writes the new value.
    queueMicrotask(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(options[Math.min(active, options.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className="libera-mention-field relative">
      <textarea
        {...rest}
        ref={input}
        className={className}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          track(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) track(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
        }}
        onClick={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        onKeyDown={keyDown}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label="Mention a member" className="libera-mention-list absolute left-0 right-0 z-[70] mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-card p-1 text-xs shadow-lg">
          {options.map((candidate, index) => (
            <li
              key={candidate.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${index === active ? "bg-muted" : ""}`}
              onMouseDown={(event) => {
                // Keep the textarea focused and its caret where it was.
                event.preventDefault();
                pick(candidate);
              }}
            >
              <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: candidate.color ?? "#64748b" }} />
              <span className="min-w-0 flex-1 truncate font-medium">{candidate.displayName}</span>
              {candidate.email ? <span className="truncate text-muted-foreground">{candidate.email}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
