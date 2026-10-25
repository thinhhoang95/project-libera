"use client";

import type { NodeViewRenderer } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  INK_BLOCK_GROW_BY,
  INK_BLOCK_GROW_MARGIN,
  INK_BLOCK_MIN_HEIGHT,
  clampInkBlockHeight,
  inkBlockChunk,
  inkBlockFrame,
  parseInkBlockSource,
} from "@/lib/ink/block";
import { strokeReach } from "@/lib/ink/geometry";
import { InkSurface } from "./ink-surface";
import { InkToolbar } from "./ink-toolbar";
import { useInkDocument } from "./use-ink-document";
import { useInkTools } from "./use-ink-tools";

/*
 * A Markdown ink block in the Visual editor (docs/ink-plan.md, "Markdown").
 * In the note it is an image of `_assets/…/ink-<id>.svg`; here it is an ink
 * surface on paper. A pen always draws on it; a mouse draws once the block is
 * selected, and the toolbox shows then. The block grows when ink nears its
 * bottom, and its grip resizes it. While it is selected, Undo and Redo undo
 * ink first. Its ink is saved with the note's Save (pending-saves.ts).
 */

function InkBlock({ node, editor, selected, documentPath }: NodeViewProps & { documentPath: string }) {
  const src = String(node.attrs.src ?? "");
  const id = parseInkBlockSource(src)!;
  const ink = useInkDocument({ path: documentPath, chunk: inkBlockChunk(id), frame: inkBlockFrame(), rendering: src });
  const tools = useInkTools();
  const [focused, setFocused] = useState(false);
  const editable = editor.isEditable;
  const active = editable && (selected || focused);
  const latest = useRef(ink);
  useEffect(() => { latest.current = ink; });

  // Ink first, then the note, for Undo and Redo while the block is selected.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const redo = (key === "z" && event.shiftKey) || key === "y";
      const undo = key === "z" && !event.shiftKey;
      const current = latest.current;
      if (undo && current.canUndo) current.undo();
      else if (redo && current.canRedo) current.redo();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  const grow = useCallback((y: number) => {
    const { frame, setHeight } = latest.current;
    if (y > frame.height - INK_BLOCK_GROW_MARGIN) setHeight(clampInkBlockHeight(frame.height + INK_BLOCK_GROW_BY));
  }, []);

  // The grip never makes the block shorter than its ink.
  const lowestInk = useMemo(() => ink.strokes.reduce((bottom, { stroke }) => Math.max(bottom, stroke.bounds.y + stroke.bounds.height + strokeReach(stroke.brush, stroke.width)), 0), [ink.strokes]);
  const resizeRef = useRef<{ startY: number; startHeight: number; scale: number } | null>(null);
  const surfaceBox = useRef<HTMLDivElement>(null);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = surfaceBox.current?.clientWidth || ink.frame.width;
    resizeRef.current = { startY: event.clientY, startHeight: ink.frame.height, scale: width / ink.frame.width };
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    const height = resize.startHeight + (event.clientY - resize.startY) / resize.scale;
    ink.setHeight(clampInkBlockHeight(Math.max(height, lowestInk + 8, INK_BLOCK_MIN_HEIGHT)));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <NodeViewWrapper
      className={`libera-ink-block${active ? " is-active" : ""}`}
      data-ink-block={id}
      contentEditable={false}
      onFocus={() => setFocused(true)}
      onBlur={(event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {active ? <InkToolbar className="libera-ink-block-toolbar" canUndo={ink.canUndo} canRedo={ink.canRedo} onUndo={ink.undo} onRedo={ink.redo} /> : null}
      <div ref={surfaceBox} className="libera-ink-paper" role="img" aria-label={node.attrs.alt ? String(node.attrs.alt) : "Ink drawing"} style={{ aspectRatio: `${ink.frame.width} / ${ink.frame.height}` }}>
        {ink.loaded ? (
          <InkSurface
            frame={ink.frame}
            strokes={ink.strokes}
            tools={tools}
            enabled={editable}
            mouseDraws={active}
            onChange={ink.change}
            onReach={grow}
          />
        ) : null}
      </div>
      {active ? <div className="libera-ink-grip" role="separator" aria-orientation="horizontal" aria-label="Resize ink block" title="Drag to resize" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} data-ink-ui /> : null}
      {ink.error ? <p className="libera-ink-block-error" role="status">{ink.error}</p> : null}
    </NodeViewWrapper>
  );
}

/**
 * The Visual editor's image view: ink blocks draw as ink surfaces, every other
 * image goes to `fallback` (the Python figure view).
 */
export function createInkImageNodeView(documentPath: string, fallback: NodeViewRenderer): NodeViewRenderer {
  function View(props: NodeViewProps) {
    return <InkBlock {...props} documentPath={documentPath} />;
  }
  const ink = ReactNodeViewRenderer(View, {
    // Pointer input inside the block is the surface's, and its toolbox's.
    stopEvent: ({ event }) => event.type.startsWith("pointer") || event.type.startsWith("touch") || (event.target instanceof Element && Boolean(event.target.closest("[data-ink-ui]"))),
    ignoreMutation: () => true,
  });
  return (props) => (parseInkBlockSource(String(props.node.attrs.src ?? "")) ? ink(props) : fallback(props));
}
