"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { sourceRangeForTiptapSelection, tiptapRangeForSource, tiptapReviewKey } from "@/lib/tiptap-review";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import { useMarkdownReview } from "./markdown-review-context";

const VISUAL_SELECTION_ERROR = "This visual selection could not be mapped to Markdown. Use the source editor to comment on this passage.";

export function useSourceReview(textareaRef: RefObject<HTMLTextAreaElement | null>, apply: (text: string) => void) {
  const r = useMarkdownReview();
  const latest = useRef({ r, apply });
  useLayoutEffect(() => { latest.current = { r, apply }; }, [r, apply]);
  const register = r?.register;
  useEffect(() => {
    const input = textareaRef.current;
    if (!input || !register) return;
    let composing = false;
    const unregister = register({ isComposing: () => composing, snapshot: () => { if (composing) throw new Error("Finish composing text before reviewing."); return input.value; }, apply: (text) => latest.current.apply(text), focus: (range) => {
      input.focus(); input.setSelectionRange(range.start, range.end); scrollTextareaToOffset(input, range.start);
    } });
    const start = () => { composing = true; }, end = () => { composing = false; };
    function select(event: MouseEvent) {
      if (!latest.current.r?.enabled || composing) return;
      latest.current.r.select({ start: input!.selectionStart, end: input!.selectionEnd }, event.clientX, event.clientY);
    }
    function key(event: KeyboardEvent) {
      const review = latest.current.r;
      if (!review?.enabled) return;
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault(); event.stopImmediatePropagation(); const rect = input!.getBoundingClientRect(); review.select({ start: input!.selectionStart, end: input!.selectionEnd }, rect.left + 30, rect.top + 30);
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.undo.at(-1)?.after === input!.value) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("undo"); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.redo?.at(-1)?.before === input!.value) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("redo"); }
      if (event.key === "Escape") review.clearSelection();
    }
    const changed = () => latest.current.r?.clearSelection();
    input.addEventListener("input", changed);
    input.addEventListener("compositionstart", start); input.addEventListener("compositionend", end); input.addEventListener("mouseup", select); input.addEventListener("keydown", key, true);
    return () => { unregister(); input.removeEventListener("input", changed); input.removeEventListener("compositionstart", start); input.removeEventListener("compositionend", end); input.removeEventListener("mouseup", select); input.removeEventListener("keydown", key, true); };
  }, [register, textareaRef]);
  return r;
}
export function useTiptapReview(editor: Editor | null, lastValue: RefObject<string>, read: () => string, replace: (markdown: string) => void) {
  const r = useMarkdownReview();
  const latest = useRef(r);
  useLayoutEffect(() => { latest.current = r; }, [r]);
  const register = r?.register;
  useEffect(() => {
    if (!editor || !register) return;
    const root = editor.view.dom;
    const unregister = register({ isComposing: () => editor.view.composing, snapshot: () => { if (editor.view.composing) throw new Error("Finish composing text before reviewing."); return read(); }, apply: (text) => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      replace(text);
      editor.view.dispatch(closeHistory(editor.state.tr));
    }, focus: (range) => {
      const target = tiptapRangeForSource(editor, read(), range);
      if (!target) return;
      editor.commands.setTextSelection({ from: target.from + 1, to: Math.max(target.from + 1, target.to - 1) });
      editor.commands.scrollIntoView(); editor.view.focus();
    } });
    function select(x: number, y: number) {
      const review = latest.current;
      if (!review?.enabled || editor!.view.composing) return;
      const { from, to } = editor!.state.selection;
      const range = sourceRangeForTiptapSelection(editor!, read(), from, to);
      if (range) {
        if (review.error === VISUAL_SELECTION_ERROR) review.reportError("");
        review.select(range, x, y);
      } else review.reportError(VISUAL_SELECTION_ERROR);
    }
    const mouse = (event: MouseEvent) => select(event.clientX, event.clientY);
    function key(event: KeyboardEvent) {
      const review = latest.current;
      if (!review?.enabled) return;
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === "m") { event.preventDefault(); event.stopImmediatePropagation(); const rect = editor!.view.coordsAtPos(editor!.state.selection.from); select(rect.left, rect.bottom); }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.undo.at(-1)?.after === read()) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("undo"); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.redo?.at(-1)?.before === read()) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("redo"); }
      if (event.key === "Escape") review.clearSelection();
    }
    const changed = () => latest.current?.clearSelection();
    editor.on("update", changed);
    root.addEventListener("mouseup", mouse); root.addEventListener("keydown", key, true);
    return () => { unregister(); editor.off("update", changed); root.removeEventListener("mouseup", mouse); root.removeEventListener("keydown", key, true); };
  }, [editor, register, lastValue, read, replace]);
  useEffect(() => { if (editor && editor.isEditable !== !r?.locked) editor.setEditable(!r?.locked, false); }, [editor, r?.locked]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const ranges = r?.enabled ? [
      ...(r.doc?.threads.filter((t) => t.anchor.state === "attached" && t.status !== "resolved").map((t) => ({ ...t.anchor, kind: "comment" })) ?? []),
      ...(r.doc?.session?.suggestions.filter((s) => s.status === "pending").flatMap((s) => s.edits.map((e) => ({ ...e, kind: "suggestion" }))) ?? []),
      ...(r.selection ? [{ ...r.selection.range, kind: "selection" }] : []),
    ].flatMap((range) => { const mapped = tiptapRangeForSource(editor, lastValue.current, range); return mapped ? [{ from: mapped.from + 1, to: Math.max(mapped.from + 1, mapped.to - 1), kind: range.kind }] : []; }) : [];
    editor.view.dispatch(editor.state.tr.setMeta(tiptapReviewKey, ranges));
  }, [editor, r?.doc, r?.enabled, r?.selection, lastValue]);
}
