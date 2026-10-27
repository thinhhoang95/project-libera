"use client";

import { X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createAnnotationId, nowIso } from "@/components/libera/text-annotation-layer";
import { PDF_SPACE_MIN_HEIGHT, availableSpaceHeight, columnBounds, sameBand } from "@/lib/pdf-space";
import type { PdfPageGeometry } from "@/lib/pdf-space-geometry";
import type { PdfSpaceCut } from "@/lib/pdf-space-layout";
import type { PdfSpaceAnnotation } from "@/lib/types";

/*
 * Create space: drag down from a cut to open blank room in the page
 * (docs/create-space-plan.md, "Interaction layer"). The layer shows each
 * space's box and controls; the page host previews and commits the spaces.
 */

// Pointer travel (px) before a press becomes a drag rather than a click.
const DRAG_THRESHOLD_PX = 4;
// A cut this close to an existing space's (page heights) resizes that space.
const SAME_CUT = 0.002;

type Gesture = {
  pointerId: number;
  space: PdfSpaceAnnotation;
  created: boolean;
  startClientY: number;
  startHeight: number;
  minHeight: number;
  maxHeight: number;
  target: HTMLElement;
  baseSpaces: PdfSpaceAnnotation[];
  moved: boolean;
};

type PdfSpaceLayerProps = {
  /** The Create space tool is on: hovering shows the cut, pressing opens a space. */
  active: boolean;
  /** Spaces show their outline, grip and delete button. */
  editable: boolean;
  geometry: PdfPageGeometry;
  pageNumber: number;
  /** The page as displayed, in CSS pixels. */
  pageSize: { width: number; height: number };
  selectedId: string;
  spaces: PdfSpaceAnnotation[];
  /** Height (page heights) of a space opened with a click. */
  defaultHeight: number;
  /** The lowest point (page heights from the space's top) of what each space holds. */
  contentBottom: (id: string) => number;
  /**
   * Where a space pressed at a document point opens: in its column inside a
   * column block, across the page elsewhere or with `fullWidth` (Alt).
   */
  placeCut: (point: { x: number; y: number }, fullWidth: boolean, snap: boolean) => PdfSpaceCut & { fill?: string };
  /** The page's spaces while a drag is in progress; null when it ends. */
  onPreview: (spaces: PdfSpaceAnnotation[] | null) => void;
  onCommit: (space: PdfSpaceAnnotation, created: boolean) => void;
  onDelete: (id: string) => void;
  onSelect: (space: PdfSpaceAnnotation) => void;
};

export const PdfSpaceLayer = memo(function PdfSpaceLayer({
  active,
  editable,
  geometry,
  pageNumber,
  pageSize,
  selectedId,
  spaces,
  defaultHeight,
  contentBottom,
  placeCut,
  onPreview,
  onCommit,
  onDelete,
  onSelect,
}: PdfSpaceLayerProps) {
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const [hover, setHover] = useState<{ y: number; snapped: boolean; x0: number; x1: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // One original page height in CSS pixels; geometry y values are in these units.
  const unit = pageSize.height / geometry.scale;

  function pointerView(event: { clientX: number; clientY: number }, element: Element) {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.width ? (event.clientX - bounds.left) / bounds.width : 0,
      y: bounds.height ? ((event.clientY - bounds.top) / bounds.height) * geometry.scale : 0,
    };
  }

  function preview(gesture: Gesture, height: number) {
    const others = spaces.filter((space) => space.id !== gesture.space.id);
    onPreview(height >= PDF_SPACE_MIN_HEIGHT ? [...others, { ...gesture.space, height }] : others);
  }

  function heightFor(gesture: Gesture, clientY: number) {
    const height = gesture.startHeight + (clientY - gesture.startClientY) / unit;
    return Math.min(gesture.maxHeight, Math.max(gesture.created ? 0 : gesture.minHeight, height));
  }

  function begin(event: PointerEvent<HTMLElement>, space: PdfSpaceAnnotation, created: boolean) {
    const maxHeight = availableSpaceHeight(spaces, created ? undefined : space.id);
    if (maxHeight < PDF_SPACE_MIN_HEIGHT) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      space,
      created,
      startClientY: event.clientY,
      startHeight: created ? 0 : space.height,
      minHeight: created ? PDF_SPACE_MIN_HEIGHT : Math.max(PDF_SPACE_MIN_HEIGHT, contentBottom(space.id)),
      maxHeight,
      target: event.currentTarget,
      baseSpaces: spaces,
      moved: false,
    };
    setDragging(true);
  }

  function startCut(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gestureRef.current) return;
    const { point, space: inside } = geometry.toDoc(pointerView(event, event.currentTarget));
    const existing = inside ? spaces.find((space) => space.id === inside) : undefined;
    if (existing) {
      begin(event, existing, false);
      return;
    }

    const cut = placeCut(point, event.altKey, !event.shiftKey);
    const same = spaces.find((space) =>
      sameBand(space.band, cut.band) && space.column === cut.column && Math.abs(space.y - cut.y) < SAME_CUT);
    if (same) {
      begin(event, same, false);
      return;
    }

    const timestamp = nowIso();
    begin(event, {
      id: createAnnotationId(),
      type: "space",
      pageNumber,
      y: cut.y,
      height: 0,
      band: cut.band,
      column: cut.column,
      ...(cut.fill ? { fill: cut.fill } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    }, true);
    setHover(null);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      if (active && event.currentTarget.dataset.pdfSpaceSurface !== undefined) {
        const { point, space } = geometry.toDoc(pointerView(event, event.currentTarget));
        const cut = space ? null : placeCut(point, event.altKey, !event.shiftKey);
        setHover(cut ? { y: cut.y, snapped: cut.snapped, ...columnBounds(cut.band, cut.column) } : null);
      }
      return;
    }
    if (Math.abs(event.clientY - gesture.startClientY) >= DRAG_THRESHOLD_PX) gesture.moved = true;
    if (gesture.moved) {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      const height = heightFor(gesture, event.clientY);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        preview(gesture, height);
      });
    }
  }

  function finish(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onPreview(null);
    if (event.type === "pointercancel") return;

    if (!gesture.moved) {
      // A click opens a space of a few lines; a click on a space selects it.
      if (gesture.created) onCommit({ ...gesture.space, height: Math.min(gesture.maxHeight, Math.max(PDF_SPACE_MIN_HEIGHT, defaultHeight)) }, true);
      else onSelect(gesture.space);
      return;
    }
    const height = heightFor(gesture, event.clientY);
    if (gesture.created && height < PDF_SPACE_MIN_HEIGHT) return;
    if (!gesture.created && Math.abs(height - gesture.space.height) < 1e-6) return;
    onCommit({ ...gesture.space, height, updatedAt: nowIso() }, gesture.created);
  }

  const cancel = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    setDragging(false);
    onPreview(null);
  }, [onPreview]);

  useEffect(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const changed = gesture.baseSpaces.length !== spaces.length || gesture.baseSpaces.some((before) =>
      !spaces.some((space) => space.id === before.id && space.y === before.y && space.height === before.height &&
        space.column === before.column && space.fill === before.fill && sameBand(space.band, before.band)));
    if (!editable || (gesture.created && !active) || changed) cancel();
  }, [active, cancel, editable, spaces]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (gestureRef.current) {
      gestureRef.current = null;
      onPreview(null);
    }
  }, [onPreview]);

  // Esc abandons a drag in progress.
  useEffect(() => {
    if (!dragging) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !gestureRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [cancel, dragging]);

  const boxes = geometry.spaces.map((box) => ({ ...box, space: spaces.find((space) => space.id === box.id) }));
  const px = (rect: { x: number; y: number; width: number; height: number }) => ({
    left: rect.x * pageSize.width,
    top: rect.y * unit,
    width: rect.width * pageSize.width,
    height: rect.height * unit,
  });

  return (
    <>
      {/* Fills sit under ink and notes; in Select a click on a space selects it. */}
      <div className="pdf-space-boxes" aria-hidden>
        {boxes.map(({ id, rect, fill, space }) => (
          <div
            key={id}
            className="pdf-space-box"
            data-pdf-space-id={id}
            data-editable={editable || undefined}
            data-selected={selectedId === id || undefined}
            style={{ ...px(rect), background: fill }}
            onClick={editable && !active && space ? (event) => {
              event.stopPropagation();
              onSelect(space);
            } : undefined}
          />
        ))}
        {/* Paper under the shorter columns of a block; hatched while spaces are being made. */}
        {geometry.fillers.map((rect, index) => (
          <div key={index} className="pdf-space-filler" data-active={active || undefined} style={{ ...px(rect), background: rect.fill }} />
        ))}
      </div>

      <div className="pdf-space-chrome">
        {active ? (
          <div
            className="pdf-space-surface"
            data-pdf-space-surface
            onPointerDown={startCut}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
            onLostPointerCapture={cancel}
            onPointerLeave={() => setHover(null)}
          />
        ) : null}
        {active && hover && !dragging ? (
          <div
            className="pdf-space-cut"
            data-snapped={hover.snapped || undefined}
            style={{
              top: geometry.toView({ x: (hover.x0 + hover.x1) / 2, y: hover.y }).y * unit,
              left: hover.x0 * pageSize.width,
              width: (hover.x1 - hover.x0) * pageSize.width,
            }}
          />
        ) : null}
        {editable ? boxes.map(({ id, rect, space }) => space ? (
          <div key={id} className="pdf-space-controls" style={px(rect)} data-pdf-annotation-ui>
            <button
              type="button"
              className="pdf-space-delete"
              aria-label="Delete space"
              title="Delete space and what is in it"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(id);
              }}
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize space"
              className="pdf-space-grip"
              onPointerDown={(event) => {
                if (event.button === 0) begin(event, space, false);
              }}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
              onLostPointerCapture={cancel}
            />
          </div>
        ) : null) : null}
      </div>
    </>
  );
});
