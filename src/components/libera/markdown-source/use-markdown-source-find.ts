"use client";

import { useMemo, useRef, useState, type RefObject } from "react";
import { findTextMatches, replaceTextMatches, type TextMatch } from "@/lib/text-find";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { scrollTextareaToOffset } from "@/lib/textarea-position";

function createFindMatcher() {
  let cached: { text: string; query: string; wildcards: boolean; matches: TextMatch[] } | undefined;
  return (text: string, query: string, options: { wildcards: boolean }) => {
    if (cached?.text === text && cached.query === query && cached.wildcards === options.wildcards) return cached.matches;
    const matches = findTextMatches(text, query, options);
    cached = { text, query, wildcards: options.wildcards, matches };
    return matches;
  };
}

/** Find policy uses the same textarea surface as the toolbar, including the
 * CodeMirror adapter. Only draft storage and overlay rendering stay outside. */
export function useMarkdownSourceFind({ text, textareaRef, readText, updateText, commitText, readDraft, closeContextMenu, syncScroll }: {
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  readText: () => string;
  updateText: (text: string) => void;
  commitText: (textarea: HTMLTextAreaElement, text: string) => void;
  readDraft: () => string;
  closeContextMenu: () => void;
  syncScroll?: (textarea: HTMLTextAreaElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [wildcards, setWildcards] = useState(false);
  const [active, setActive] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findMatches = useMemo(() => createFindMatcher(), []);
  const matches = useMemo(() => open ? findMatches(text, query, { wildcards }) : [], [open, text, query, wildcards, findMatches]);

  function selectMatch(index: number, list = matches) {
    if (!list.length) return;
    const normalized = (index + list.length) % list.length;
    const match = list[normalized];
    setActive(normalized);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.setSelectionRange(match.start, match.end);
      scrollTextareaToOffset(textarea, match.start);
    });
  }

  function openFind(nextQuery?: string) {
    const text = readText();
    updateText(text);
    const textarea = textareaRef.current;
    const selected = textarea ? text.slice(textarea.selectionStart, textarea.selectionEnd) : "";
    const next = nextQuery ?? (selected.includes("\n") ? "" : selected);
    closeContextMenu();
    setOpen(true);
    if (next) {
      setQuery(next);
      selectMatch(0, findMatches(text, next, { wildcards }));
    }
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    const textarea = textareaRef.current;
    const left = textarea?.scrollLeft ?? 0;
    const top = textarea?.scrollTop ?? 0;
    setOpen(false);
    textarea?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.scrollLeft = left;
      textarea.scrollTop = top;
      syncScroll?.(textarea);
    });
  }

  function updateQuery(next: string) {
    const list = findMatches(readText(), next, { wildcards });
    setQuery(next);
    setActive(0);
    if (list.length) selectMatch(0, list);
  }

  function updateWildcards(enabled: boolean) {
    const list = findMatches(readText(), query, { wildcards: enabled });
    setWildcards(enabled);
    setActive(0);
    if (list.length) selectMatch(0, list);
  }

  function replaceMatches(list: TextMatch[]) {
    const textarea = textareaRef.current;
    if (!textarea || !list.length) return;
    const text = readText();
    const first = list[0], last = list.at(-1)!;
    const inserted = replaceTextMatches(text.slice(first.start, last.end), list.map((match) => ({ start: match.start - first.start, end: match.end - first.start })), replacement);
    const next = `${text.slice(0, first.start)}${inserted}${text.slice(last.end)}`;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: first.start, selectionEnd: last.end, replacement: inserted,
      nextSelectionStart: first.start + inserted.length, nextSelectionEnd: first.start + inserted.length,
      scrollLeft: textarea.scrollLeft, scrollTop: textarea.scrollTop,
    })) commitText(textarea, next);
    readDraft();
    const nextMatches = findMatches(next, query, { wildcards });
    const index = list.length === 1 ? Math.max(0, nextMatches.findIndex((match) => match.start >= first.start + replacement.length)) : 0;
    setActive(index);
    if (nextMatches.length) selectMatch(index, nextMatches);
    window.requestAnimationFrame(() => focused?.focus());
  }

  return {
    open, query, replacement, wildcards, active, matches, findMatches, findInputRef, openFind, closeFind,
    updateQuery, updateWildcards, setReplacement, next: () => selectMatch(active + 1), previous: () => selectMatch(active - 1),
    replace: () => { if (matches[active]) replaceMatches([matches[active]]); }, replaceAll: () => replaceMatches(matches),
  };
}
