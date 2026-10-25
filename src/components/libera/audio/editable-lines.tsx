"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { applyRecapEdits, type RecapEdit } from "@/lib/recording/recap";
import type { RecapBullet } from "@/lib/recording/types";
import {
  applySegmentEdits,
  cleanLineText,
  joinSegments,
  setSegmentText,
  splitSegment,
  withoutEmptySegments,
  type SegmentEdits,
} from "@/lib/transcription/edits";
import type { TranscriptSegment } from "@/lib/transcription/types";

/**
 * Transcripts and recaps read like a document the reader can type into: each
 * passage or bullet is a line of plain text. Enter breaks a line in two,
 * Backspace at its start joins it to the one before (Delete at its end, to
 * the one after), and the arrows cross from line to line. Edits are kept in
 * memory while the reader types and saved once, when the editing ends: focus
 * leaves the lines, the view closes, or the window does.
 */

export type LineFocus = { offset: number; nonce: number };

let focusNonce = 0;
const nextNonce = () => ++focusNonce;

/** The selection's start and end as offsets in the line's text; null without a caret in it. */
function selectionOffsets(element: HTMLElement): [number, number] | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(node, at);
    return before.toString().length;
  };
  return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
}

function placeCaret(element: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let placed = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= length;
  }
  if (!placed) range.selectNodeContents(element);
  range.collapse(placed);
  selection.removeAllRanges();
  selection.addRange(range);
}

const textOf = (element: HTMLElement) => (element.textContent ?? "").replace(/ /g, " ");

export type EditableLineProps = {
  /** The line as saved (or as last committed). */
  text: string;
  /** How the line shows while it is not being edited, such as with find matches marked; the text by default. */
  children?: ReactNode;
  className?: string;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Set by the list to move the caret here. */
  focus?: LineFocus | null;
  /** Each keystroke, so a view closing mid-line keeps what was typed. */
  onType?: (text: string) => void;
  /** The reader left the line, or pressed Escape (with the text as it was). */
  onCommit: (text: string) => void;
  onSplit?: (text: string, offset: number) => void;
  onJoinPrevious?: (text: string) => void;
  onJoinNext?: (text: string) => void;
  onMove?: (direction: -1 | 1) => void;
};

export function EditableLine({
  text,
  children,
  className = "",
  label,
  placeholder,
  readOnly,
  focus,
  onType,
  onCommit,
  onSplit,
  onJoinPrevious,
  onJoinNext,
  onMove,
}: EditableLineProps) {
  const ref = useRef<HTMLDivElement>(null);
  // While the reader types, the browser owns the line's DOM; React keeps
  // showing what it showed when editing began, and a fresh element replaces
  // the line afterwards, so React never patches nodes the browser changed.
  const [frozen, setFrozen] = useState<{ content: ReactNode } | null>(null);
  const [generation, setGeneration] = useState(0);
  const typed = useRef(false);
  const handledFocus = useRef(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!focus || !element || handledFocus.current === focus.nonce) return;
    handledFocus.current = focus.nonce;
    element.focus({ preventScroll: true });
    placeCaret(element, focus.offset);
    element.scrollIntoView({ block: "nearest" });
  }, [focus, generation]);

  /** The line hands its text to the list (which re-renders it), so its DOM starts afresh. */
  function release() {
    typed.current = false;
    setFrozen(null);
    setGeneration((value) => value + 1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (readOnly || event.nativeEvent.isComposing) return;
    const element = event.currentTarget;
    const value = textOf(element);
    const selection = selectionOffsets(element);
    if (!selection) return;
    const [start, end] = selection;
    const collapsed = start === end;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;

    if (event.key === "Enter") {
      event.preventDefault();
      if (!onSplit) return;
      release();
      onSplit(value.slice(0, start) + value.slice(end), start);
    } else if (event.key === "Backspace" && collapsed && start === 0 && onJoinPrevious) {
      event.preventDefault();
      release();
      onJoinPrevious(value);
    } else if (event.key === "Delete" && collapsed && start === value.length && onJoinNext) {
      event.preventDefault();
      release();
      onJoinNext(value);
    } else if (plain && !event.shiftKey && collapsed && onMove && (((event.key === "ArrowUp" || event.key === "ArrowLeft") && start === 0) || ((event.key === "ArrowDown" || event.key === "ArrowRight") && start === value.length))) {
      event.preventDefault();
      onMove(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Escape") {
      // Back to the line as it was.
      event.preventDefault();
      event.stopPropagation();
      release();
      onCommit(text);
    }
  }

  return (
    <div
      key={generation}
      ref={ref}
      role="textbox"
      aria-label={label}
      aria-readonly={readOnly || undefined}
      contentEditable={readOnly ? false : "plaintext-only"}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      className={`min-w-0 whitespace-pre-wrap break-words outline-none ${readOnly ? "" : "cursor-text"} ${placeholder ? "empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)]" : ""} ${className}`}
      onFocus={() => {
        if (readOnly) return;
        typed.current = false;
        setFrozen({ content: children ?? text });
      }}
      onInput={(event) => {
        typed.current = true;
        onType?.(textOf(event.currentTarget));
      }}
      onBlur={(event) => {
        if (!frozen && !typed.current) return;
        const changed = typed.current;
        const value = cleanLineText(textOf(event.currentTarget));
        if (changed) release();
        else setFrozen(null);
        if (changed) onCommit(value);
      }}
      onKeyDown={onKeyDown}
    >
      {frozen ? frozen.content : children ?? text}
    </div>
  );
}

/**
 * Calls `flush` when the editing ends: focus leaves the lines (moving between
 * them does not count), the view goes away, or the window closes. Returns
 * the handler for the container's focus leaving.
 */
export function useFlushWhenEditingEnds(flush: (closing: boolean) => void) {
  const flushRef = useRef(flush);
  useLayoutEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const onPageHide = () => flushRef.current(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current(false);
    };
  }, []);

  return useCallback((event: FocusEvent<HTMLElement>) => {
    const container = event.currentTarget;
    // Focus moves on to the next line (or a button in the list) after this event.
    window.setTimeout(() => {
      if (!container.contains(document.activeElement)) flushRef.current(false);
    }, 0);
  }, []);
}

type Typing<Key> = { key: Key; text: string };

/** A transcript being corrected: the shown passages, the line operations and the save at the end. */
export function useSegmentDraft({ base, saved, save }: {
  /** The passages as transcribed (live: as they come). */
  base: TranscriptSegment[];
  /** Edits already saved (live); null for a saved transcript, whose base holds them. */
  saved: SegmentEdits | null;
  save: (change: { edits: SegmentEdits; segments: TranscriptSegment[] }, closing: boolean) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<SegmentEdits | null>(null);
  const edits = draft ?? saved;
  const segments = useMemo(() => applySegmentEdits(base, edits), [base, edits]);
  const [focus, setFocus] = useState<{ index: number; offset: number; nonce: number } | null>(null);
  const typing = useRef<Typing<number> | null>(null);
  const sent = useRef<SegmentEdits | null>(null);
  const latest = useRef({ base, saved, draft, edits, segments, save });
  useLayoutEffect(() => {
    latest.current = { base, saved, draft, edits, segments, save };
  });

  // Stable, so passages that did not change need not render again while the recording plays.
  const actions = useMemo(() => {
    const change = (next: SegmentEdits | null) => {
      if (next && next !== latest.current.edits) setDraft(next);
    };
    return {
      flush(closing: boolean) {
        const { base: current, saved: savedEdits, draft: currentDraft, save: saveEdits } = latest.current;
        let next = currentDraft;
        const pending = typing.current;
        typing.current = null;
        if (pending) {
          const applied = setSegmentText(current, next ?? savedEdits, pending.key, cleanLineText(pending.text));
          if (applied && applied !== (next ?? savedEdits)) {
            next = applied;
            setDraft(applied);
          }
        }
        if (!next || next === sent.current) return;
        sent.current = next;
        const clean = withoutEmptySegments(next);
        const sending = next;
        saveEdits({ edits: clean, segments: applySegmentEdits(current, clean) }, closing).then(
          () => setDraft((value) => (value === sending ? null : value)),
          () => {
            // Kept, and saved again when the editing next ends.
            sent.current = null;
          },
        );
      },
      type(index: number, text: string) {
        typing.current = { key: index, text };
      },
      commit(index: number, text: string) {
        typing.current = null;
        const { base: current, edits: currentEdits } = latest.current;
        change(setSegmentText(current, currentEdits, index, text));
      },
      split(index: number, text: string, offset: number) {
        typing.current = null;
        const { base: current, edits: currentEdits } = latest.current;
        change(splitSegment(current, currentEdits, index, text, offset));
        setFocus({ index: index + 1, offset: 0, nonce: nextNonce() });
      },
      joinPrevious(index: number, text: string) {
        typing.current = null;
        const { base: current, edits: currentEdits } = latest.current;
        const joined = joinSegments(current, currentEdits, index, text);
        if (!joined) return;
        change(joined.edits);
        setFocus({ index: index - 1, offset: joined.caret, nonce: nextNonce() });
      },
      joinNext(index: number, text: string) {
        typing.current = null;
        const { base: current, edits: currentEdits } = latest.current;
        const typed = setSegmentText(current, currentEdits, index, cleanLineText(text)) ?? currentEdits;
        const following = applySegmentEdits(current, typed)[index + 1];
        if (!following) return change(typed);
        const joined = joinSegments(current, typed, index + 1, following.text);
        if (!joined) return;
        change(joined.edits);
        setFocus({ index, offset: joined.caret, nonce: nextNonce() });
      },
      move(index: number, direction: -1 | 1) {
        const target = latest.current.segments[index + direction];
        if (target) setFocus({ index: index + direction, offset: direction < 0 ? target.text.length : 0, nonce: nextNonce() });
      },
    };
  }, []);

  return { segments, focus, edited: draft !== null, ...actions };
}

export type SegmentDraft = ReturnType<typeof useSegmentDraft>;

/** The live recap being written in: the shown bullets, the line operations and the save at the end. */
export function useRecapDraft({ base, save, now }: {
  base: RecapBullet[];
  save: (edits: RecapEdit[], closing: boolean) => Promise<unknown>;
  /** Recording seconds, for a bullet the reader adds. */
  now: () => number;
}) {
  const [draft, setDraft] = useState<RecapEdit[]>([]);
  const bullets = useMemo(() => (draft.length ? applyRecapEdits(base, draft) : base), [base, draft]);
  const [focus, setFocus] = useState<{ id: number; offset: number; nonce: number } | null>(null);
  const typing = useRef<Typing<number> | null>(null);
  const nextTemporaryId = useRef(-1);
  const sent = useRef<RecapEdit[] | null>(null);
  const latest = useRef({ base, draft, bullets, save, now });
  useLayoutEffect(() => {
    latest.current = { base, draft, bullets, save, now };
  });

  const actions = useMemo(() => {
    const push = (...edits: RecapEdit[]) => setDraft((current) => [...current, ...edits]);
    const temporaryId = () => nextTemporaryId.current--;
    const find = (id: number) => {
      const { bullets: shown } = latest.current;
      const index = shown.findIndex((bullet) => bullet.id === id);
      return { index, bullet: shown[index], previous: shown[index - 1], following: shown[index + 1] };
    };
    return {
      flush(closing: boolean) {
        const { base: current, draft: currentDraft, save: saveEdits } = latest.current;
        let next = currentDraft;
        const pending = typing.current;
        typing.current = null;
        if (pending) next = [...next, { op: "update", id: pending.key, text: cleanLineText(pending.text) }];
        // Bullets left empty go.
        const empty = applyRecapEdits(current, next).filter((bullet) => !bullet.text.trim()).map((bullet): RecapEdit => ({ op: "remove", id: bullet.id }));
        if (empty.length) next = [...next, ...empty];
        if (next !== currentDraft) setDraft(next);
        if (!next.length || next === sent.current) return;
        sent.current = next;
        const sending = next;
        saveEdits(sending, closing).then(
          // Edits made while saving stay for the next save.
          () => setDraft((value) => (value === sending ? [] : value.slice(sending.length))),
          () => {
            sent.current = null;
          },
        );
      },
      type(id: number, text: string) {
        typing.current = { key: id, text };
      },
      commit(id: number, text: string) {
        typing.current = null;
        const { bullet } = find(id);
        if (bullet && bullet.text !== text) push({ op: "update", id, text });
      },
      split(id: number, text: string, offset: number) {
        typing.current = null;
        const { bullet } = find(id);
        if (!bullet) return;
        const added = temporaryId();
        push({ op: "update", id, text: cleanLineText(text.slice(0, offset)) }, { op: "add", id: added, after: id, text: cleanLineText(text.slice(offset)), at: bullet.addedAt });
        setFocus({ id: added, offset: 0, nonce: nextNonce() });
      },
      joinPrevious(id: number, text: string) {
        typing.current = null;
        const { previous } = find(id);
        if (!previous) return;
        const head = previous.text.trimEnd();
        const tail = cleanLineText(text);
        push({ op: "update", id: previous.id, text: head && tail ? `${head} ${tail}` : head || tail }, { op: "remove", id });
        setFocus({ id: previous.id, offset: head.length, nonce: nextNonce() });
      },
      joinNext(id: number, text: string) {
        typing.current = null;
        const { following } = find(id);
        if (!following) return;
        const head = cleanLineText(text);
        const tail = following.text.trim();
        push({ op: "update", id, text: head && tail ? `${head} ${tail}` : head || tail }, { op: "remove", id: following.id });
        setFocus({ id, offset: head.length, nonce: nextNonce() });
      },
      move(id: number, direction: -1 | 1) {
        const { index } = find(id);
        const target = latest.current.bullets[index + direction];
        if (index >= 0 && target) setFocus({ id: target.id, offset: direction < 0 ? target.text.length : 0, nonce: nextNonce() });
      },
      /** A new, empty bullet at the end, with the caret in it. */
      add() {
        const added = temporaryId();
        const { bullets: shown, now: clock } = latest.current;
        push({ op: "add", id: added, after: shown.at(-1)?.id ?? null, text: "", at: clock() });
        setFocus({ id: added, offset: 0, nonce: nextNonce() });
      },
    };
  }, []);

  return { bullets, focus, ...actions };
}
