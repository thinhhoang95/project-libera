"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { EditorView } from "@codemirror/view";
import { closeHistory } from "@tiptap/pm/history";
import { sourceRangeForTiptapSelection, tiptapRangeForSource, tiptapReviewBlocks, tiptapReviewChanges, tiptapReviewKey } from "@/lib/tiptap-review";
import { tiptapChangesKey, type ChangeDecider, type TiptapChangesMeta } from "@/lib/tiptap-changes";
import { installCodeMirrorReview, setCodeMirrorReviewLocked, setReviewHighlights } from "@/lib/codemirror-review";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import { useMarkdownReview } from "./markdown-review-context";

const VISUAL_SELECTION_ERROR = "This visual selection could not be mapped to Markdown. Use the source editor to comment on this passage.";

/**
 * Reports the source range an editor shows while it scrolls, so the Comments
 * panel of a shared document can line its cards up with the text (plan M2.1).
 * Scrolling may happen in the editor or in any container around it, hence the
 * capturing listener on the document. One measurement per animation frame.
 */
function watchViewport(root: HTMLElement, measure: (top: number, bottom: number) => { start: number; end: number } | null, report: (range: { start: number; end: number } | null) => void) {
  let frame = 0;
  const run = () => {
    frame = 0;
    const rect = root.getBoundingClientRect();
    const top = Math.max(rect.top, 0) + 2;
    const bottom = Math.min(rect.bottom, window.innerHeight || rect.bottom) - 2;
    if (bottom <= top) return;
    try { report(measure(top, bottom)); } catch { /* Layout is not available (hidden pane). */ }
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && target !== document && !target.contains(root) && !root.contains(target)) return;
    if (!frame) frame = window.requestAnimationFrame(run);
  };
  document.addEventListener("scroll", onScroll, true);
  frame = window.requestAnimationFrame(run);
  return () => { document.removeEventListener("scroll", onScroll, true); if (frame) window.cancelAnimationFrame(frame); };
}

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
export function useCodeMirrorReview(view: EditorView | null, apply: (text: string) => void) {
  const r = useMarkdownReview();
  const latest = useRef({ r, apply });
  useLayoutEffect(() => { latest.current = { r, apply }; }, [r, apply]);
  const register = r?.register;
  useEffect(() => {
    if (!view || !register) return;
    installCodeMirrorReview(view);
    const root = view.contentDOM;
    const range = () => { const { from, to } = view.state.selection.main; return { start: from, end: to }; };
    const unregister = register({ isComposing: () => view.composing, snapshot: () => { if (view.composing) throw new Error("Finish composing text before reviewing."); return view.state.doc.toString(); }, apply: (text) => latest.current.apply(text), focus: (target) => {
      const length = view.state.doc.length;
      const anchor = Math.min(target.start, length), head = Math.min(target.end, length);
      view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
      view.focus();
    } });
    function select(event: MouseEvent) {
      if (!latest.current.r?.enabled || view!.composing || event.button !== 0) return;
      // Let CodeMirror settle the selection from this mouseup first.
      const { clientX, clientY } = event;
      window.setTimeout(() => latest.current.r?.enabled && latest.current.r.select(range(), clientX, clientY), 0);
    }
    function key(event: KeyboardEvent) {
      const review = latest.current.r;
      if (!review?.enabled) return;
      const text = () => view!.state.doc.toString();
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault(); event.stopImmediatePropagation(); const rect = view!.coordsAtPos(view!.state.selection.main.head); review.select(range(), rect?.left ?? 30, rect?.bottom ?? 30);
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.undo.at(-1)?.after === text()) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("undo"); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z" && review.doc?.redo?.at(-1)?.before === text()) { event.preventDefault(); event.stopImmediatePropagation(); void review.action("redo"); }
      if (event.key === "Escape") review.clearSelection();
    }
    const changed = () => latest.current.r?.clearSelection();
    root.addEventListener("input", changed); root.addEventListener("mouseup", select); root.addEventListener("keydown", key, true);
    return () => { unregister(); root.removeEventListener("input", changed); root.removeEventListener("mouseup", select); root.removeEventListener("keydown", key, true); };
  }, [view, register]);
  useEffect(() => { if (view) { installCodeMirrorReview(view); setCodeMirrorReviewLocked(view, !!r?.locked); } }, [view, r?.locked]);
  const sharedDoc = !!r?.shared;
  const reportViewport = r?.reportViewport;
  useEffect(() => {
    if (!view || !sharedDoc || !reportViewport) return;
    const left = () => view.contentDOM.getBoundingClientRect().left + 4;
    return watchViewport(view.dom, (top, bottom) => {
      const start = view.posAtCoords({ x: left(), y: top }, false);
      const end = view.posAtCoords({ x: left(), y: bottom }, false);
      return { start, end: Math.max(start, end) };
    }, reportViewport);
  }, [view, sharedDoc, reportViewport]);
  useEffect(() => {
    if (!view) return;
    installCodeMirrorReview(view);
    const ranges = r?.enabled ? [
      ...(r.doc?.threads.filter((t) => t.anchor.state === "attached" && t.status === "open").map((t) => t.anchor) ?? []),
      ...(r.doc?.session?.suggestions.filter((s) => s.status === "pending").flatMap((s) => s.edits) ?? []),
      ...(r.selection ? [r.selection.range] : []),
    ] : [];
    view.dispatch({ effects: setReviewHighlights.of(ranges) });
  }, [view, r?.doc, r?.enabled, r?.selection]);
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
  const sharedDoc = !!r?.shared;
  const reportViewport = r?.reportViewport;
  useEffect(() => {
    if (!editor || !sharedDoc || !reportViewport) return;
    const root = editor.view.dom;
    const sourceAt = (y: number) => {
      const left = root.getBoundingClientRect().left + 4;
      const pos = editor.view.posAtCoords({ left, top: y })?.pos;
      if (pos === undefined) return null;
      const block = tiptapReviewBlocks(editor, read()).find((item) => item.to > pos) ?? null;
      return block ? block.start : read().length;
    };
    return watchViewport(root, (top, bottom) => {
      const start = sourceAt(top);
      if (start === null) return null;
      return { start, end: Math.max(start, sourceAt(bottom) ?? start) };
    }, reportViewport);
  }, [editor, sharedDoc, reportViewport, read]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // A shared tab's Visual editor is built from the shared text, which the
    // draft ref only catches up with on read; anchors resolve against it.
    const source = sharedDoc ? read() : lastValue.current;
    const ranges = r?.enabled ? [
      ...(r.doc?.threads.filter((t) => t.anchor.state === "attached" && t.status === "open").map((t) => ({ ...t.anchor, kind: "comment" })) ?? []),
      ...(r.selection ? [{ ...r.selection.range, kind: "selection" }] : []),
    ].flatMap((range) => { const mapped = tiptapRangeForSource(editor, source, range); return mapped ? [{ from: mapped.from + 1, to: Math.max(mapped.from + 1, mapped.to - 1), kind: range.kind }] : []; }) : [];
    // Pending agentic-review proposals are previewed inline as changes; their
    // decisions still go through the review so its undo/CAS state stays exact.
    const suggestions = r?.doc?.session?.suggestions ?? [];
    const changes = tiptapReviewChanges(editor, source, suggestions.flatMap((s, index) => s.status === "pending" ? [{ id: s.id, label: `Change ${index + 1}`, edits: s.edits }] : []));
    const decide: ChangeDecider = (ids, decision) => {
      const review = latest.current;
      if (!review || review.busy || (decision === "accept" && review.recovery)) return;
      void review.action("decision", { ids, decision });
    };
    editor.view.dispatch(editor.state.tr.setMeta(tiptapReviewKey, ranges).setMeta(tiptapChangesKey, { type: "preview", changes, decide } satisfies TiptapChangesMeta));
  }, [editor, r?.doc, r?.enabled, r?.selection, lastValue, sharedDoc, read]);
}
