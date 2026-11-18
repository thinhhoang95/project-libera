"use client";

import { useMemo, useRef, useState, type RefObject } from "react";
import { compileFind, describeMatch, type FindMatch, type Finder, type TextRange } from "@/lib/find";
import type { FindPreset } from "@/lib/find/presets";
import type { FindSettings } from "@/lib/find/settings-store";
import { getChangedTextRange } from "@/lib/markdown-source";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import type { FindBarProps } from "../find/find-replace-bar";
import { toFindOptions, useFindQuery, type FindQueryState } from "../find/use-find-query";

const NO_MATCHES: FindMatch[] = [];

/** Finds with one finder over the latest text, reusing the result while neither changes. */
function createFindMatcher() {
  let cached: { text: string; finder: Finder; within: TextRange | null; matches: FindMatch[]; incomplete: boolean } | undefined;
  return (text: string, finder: Finder | null, within: TextRange | null) => {
    if (!finder) return { matches: NO_MATCHES, incomplete: false };
    if (cached?.text === text && cached.finder === finder && cached.within === within) return cached;
    const result = finder.find(text, within ? { within: [within] } : undefined);
    cached = { text, finder, within, ...result };
    return cached;
  };
}

/** In selection keeps its range across edits made outside it (and grows or shrinks with edits inside). */
function mapRange(range: TextRange, previous: string, next: string): TextRange {
  const change = getChangedTextRange(previous, next);
  const delta = change.replacement.length - (change.selectionEnd - change.selectionStart);
  const map = (offset: number, end: boolean) => {
    if (offset < change.selectionStart || (!end && offset === change.selectionStart)) return offset;
    if (offset >= change.selectionEnd) return offset + delta;
    return end ? change.selectionStart + change.replacement.length : change.selectionStart;
  };
  return { start: map(range.start, false), end: Math.max(map(range.start, false), map(range.end, true)) };
}

/** Find policy uses the same textarea surface as the toolbar, including the
 * CodeMirror adapter. Only draft storage and match drawing stay outside. */
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
  const [active, setActive] = useState(0);
  const [summary, setSummary] = useState<{ replaced: number; skipped: number } | null>(null);
  // In selection: the range and the text it was taken from, mapped to the current text during render.
  const [selection, setSelection] = useState<{ range: TextRange; text: string } | null>(null);
  if (selection && selection.text !== text) setSelection({ range: mapRange(selection.range, selection.text, text), text });
  const within = selection?.text === text ? selection.range : null;
  const query = useFindQuery("markdown", "markdown");
  const { finder, replacer, settings } = query;
  const findInputRef = useRef<HTMLInputElement>(null);
  const findMatches = useMemo(() => createFindMatcher(), []);
  const { matches, incomplete } = open ? findMatches(text, finder, within) : { matches: NO_MATCHES, incomplete: false };
  // The active index is kept as is when an outside edit removes matches: the bar shows the last one,
  // and Replace then does nothing rather than replace a different match.
  const activeIndex = active;

  /** The matches a highlight layer draws for `text` (the latest text, which may be ahead of React's). */
  const matchesFor = useMemo(() => (current: string) => open ? findMatches(current, finder, within).matches : NO_MATCHES, [open, findMatches, finder, within]);

  function selectMatch(index: number, list: FindMatch[] = matches) {
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

  /** The matches for a query or settings about to be applied, so the first can be selected at once. */
  function matchesWith(nextQuery: string, nextSettings: FindSettings, range = within) {
    const compiled = compileFind(nextQuery, toFindOptions(nextSettings, "markdown"));
    return compiled.ok ? compiled.finder.find(readText(), range ? { within: [range] } : undefined).matches : NO_MATCHES;
  }

  function restart(list: FindMatch[]) {
    setActive(0);
    setSummary(null);
    if (list.length) selectMatch(0, list);
  }

  function openFind(nextQuery?: string) {
    const current = readText();
    updateText(current);
    const textarea = textareaRef.current;
    const selected = textarea ? current.slice(textarea.selectionStart, textarea.selectionEnd) : "";
    const next = nextQuery ?? (selected.includes("\n") ? "" : selected);
    closeContextMenu();
    setOpen(true);
    if (next) {
      query.setQuery(next);
      restart(matchesWith(next, settings));
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
    setSelection(null);
    setSummary(null);
    textarea?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.scrollLeft = left;
      textarea.scrollTop = top;
      syncScroll?.(textarea);
    });
  }

  // The bar edits the query and settings through these, so the first match is selected as the user types.
  const barQuery: FindQueryState = {
    ...query,
    setQuery: (next: string) => { query.setQuery(next); restart(matchesWith(next, settings)); },
    updateSettings: (patch: Partial<FindSettings>) => { query.updateSettings(patch); restart(matchesWith(query.query, { ...settings, ...patch })); },
    applyPreset: (preset: FindPreset) => {
      query.applyPreset(preset);
      restart(matchesWith(preset.query, { ...settings, mode: preset.mode, ...(preset.scope ? { scope: preset.scope } : {}) }));
    },
  };

  function toggleInSelection() {
    if (selection) { setSelection(null); restart(matchesWith(query.query, settings, null)); return; }
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart === textarea.selectionEnd) return;
    const current = readText();
    // The selection may be the active match itself; In selection searches inside it all the same.
    const range = { start: textarea.selectionStart, end: textarea.selectionEnd };
    setSelection({ range, text: current });
    restart(matchesWith(query.query, settings, range));
  }

  function replaceMatches(list: FindMatch[], firstCounter: number) {
    const textarea = textareaRef.current;
    if (!textarea || !list.length || !replacer || !finder) return;
    const current = readText();
    const rendered = list.map((match, index) => ({ match, value: replacer.render(current, match, firstCounter + index) }));
    const valid = rendered.filter((entry): entry is { match: FindMatch; value: string } => typeof entry.value === "string");
    const skipped = rendered.length - valid.length;
    if (list.length > 1) setSummary({ replaced: valid.length, skipped });
    if (!valid.length) return;
    const first = valid[0].match, last = valid.at(-1)!.match;
    const pieces: string[] = [];
    let offset = first.start;
    for (const { match, value } of valid) {
      pieces.push(current.slice(offset, match.start), value);
      offset = match.end;
    }
    const inserted = pieces.join("");
    const next = `${current.slice(0, first.start)}${inserted}${current.slice(last.end)}`;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!replaceTextareaSelectionWithUndo(textarea, {
      selectionStart: first.start, selectionEnd: last.end, replacement: inserted,
      nextSelectionStart: first.start + inserted.length, nextSelectionEnd: first.start + inserted.length,
      scrollLeft: textarea.scrollLeft, scrollTop: textarea.scrollTop,
    })) commitText(textarea, next);
    readDraft();
    const range = selection ? mapRange(selection.range, selection.text, next) : null;
    const nextMatches = finder.find(next, range ? { within: [range] } : undefined).matches;
    const after = first.start + valid[0].value.length;
    const index = list.length === 1 ? Math.max(0, nextMatches.findIndex((match) => match.start >= after)) : 0;
    setActive(index);
    if (nextMatches.length) selectMatch(index, nextMatches);
    window.requestAnimationFrame(() => focused?.focus());
  }

  const activeMatch = matches[activeIndex];
  const preview = activeMatch && finder ? describeMatch(text, activeMatch, finder, replacer, activeIndex + 1) : null;

  const barProps: Omit<FindBarProps, "placeholder"> = {
    find: barQuery,
    matchCount: matches.length,
    activeIndex,
    incomplete,
    preview,
    summary,
    findInputRef,
    showScopes: true,
    inSelection: { active: !!selection, onToggle: toggleInSelection },
    onNext: () => selectMatch(activeIndex + 1),
    onPrevious: () => selectMatch(activeIndex - 1),
    onClose: closeFind,
    onReplace: () => { if (activeMatch) replaceMatches([activeMatch], activeIndex + 1); },
    onReplaceAll: () => replaceMatches(matches, 1),
  };

  return { open, active: activeIndex, matches, matchesFor, findInputRef, openFind, closeFind, barProps };
}
