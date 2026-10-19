"use client";

import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  clamp,
  createAnnotationId,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";
import {
  arrowHeadPoints,
  arrowShaftEnd,
  constrainShapeEnd,
  drawingBounds,
  hitTestDrawing,
  isClosedShape,
  shouldKeepSample,
  smoothStrokePath,
  toPixels,
  translateDrawing,
  type PdfDrawingAnnotation,
} from "@/lib/pdf-drawing";
import type {
  PdfAnnotation,
  PdfAnnotationPoint,
  PdfHighlightAnnotation,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfShapeKind,
} from "@/lib/types";

/** What pointer input on the page does to drawings. */
export type PdfDrawingMode = "idle" | "select" | "draw" | "shape" | "eraser";

export type NewDrawingStyle = {
  color: string;
  shape: PdfShapeKind;
  strokeWidth: number;
};

/** A drawing about to be added; the host fills in id, page and timestamps. */
export type PdfDrawingDraft =
  | Pick<PdfShapeAnnotation, "type" | "shape" | "color" | "strokeWidth" | "from" | "to">
  | Pick<PdfInkAnnotation, "type" | "color" | "strokeWidth" | "points">;

type Handle = "from" | "to" | "nw" | "ne" | "se" | "sw";

type Gesture = {
  handle?: Handle;
  id: string;
  moved: boolean;
  start: PdfDrawingAnnotation;
  startClient: { x: number; y: number };
};

type Transient = { id: string; patch: Partial<PdfDrawingAnnotation> };

// Pointer travel (px) before a press on a drawing becomes a move.
const DRAG_THRESHOLD_PX = 3;
// Pen samples closer than this (px) add nothing but path length.
const MIN_SAMPLE_DISTANCE_PX = 1.5;
// Pixels around a stroke that still count as touching it.
const HIT_SLOP_PX = 5;
const ERASER_STEP_PX = 3;
const MIN_SHAPE_SIZE_PX = 4;

const HANDLE_CURSORS: Record<Handle, string> = {
  from: "move",
  to: "move",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

function pointInElement(event: { clientX: number; clientY: number }, element: Element): PdfAnnotationPoint {
  const bounds = element.getBoundingClientRect();

  return {
    x: bounds.width ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1) : 0,
    y: bounds.height ? clamp((event.clientY - bounds.top) / bounds.height, 0, 1) : 0,
  };
}

function constrainedEnd(
  shape: PdfShapeKind,
  from: PdfAnnotationPoint,
  to: PdfAnnotationPoint,
  size: AnnotationSurfaceSize,
): PdfAnnotationPoint {
  if (!size.width || !size.height) {
    return to;
  }

  const end = constrainShapeEnd(shape, toPixels(from, size), toPixels(to, size));

  return { x: clamp(end.x / size.width, 0, 1), y: clamp(end.y / size.height, 0, 1) };
}

/** Box corners of a closed shape, as page fractions. */
function corner(annotation: PdfShapeAnnotation, handle: Handle): PdfAnnotationPoint {
  const left = Math.min(annotation.from.x, annotation.to.x);
  const right = Math.max(annotation.from.x, annotation.to.x);
  const top = Math.min(annotation.from.y, annotation.to.y);
  const bottom = Math.max(annotation.from.y, annotation.to.y);

  return {
    x: handle.includes("w") ? left : right,
    y: handle.includes("n") ? top : bottom,
  };
}

const OPPOSITE: Record<"nw" | "ne" | "se" | "sw", Handle> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

function resizeShape(
  annotation: PdfShapeAnnotation,
  handle: Handle,
  point: PdfAnnotationPoint,
  constrain: boolean,
  size: AnnotationSurfaceSize,
): Partial<PdfShapeAnnotation> {
  if (handle === "from" || handle === "to") {
    const anchor = handle === "from" ? annotation.to : annotation.from;
    const moved = constrain ? constrainedEnd(annotation.shape, anchor, point, size) : point;

    return handle === "from" ? { from: moved } : { to: moved };
  }

  const anchor = corner(annotation, OPPOSITE[handle as keyof typeof OPPOSITE]);

  return { from: anchor, to: constrain ? constrainedEnd(annotation.shape, anchor, point, size) : point };
}

/** Pen strokes, boxes, ellipses and plain lines; arrows add a head below. */
function DrawingGeometry({
  annotation,
  size,
  stroke,
  strokeWidth,
}: {
  annotation: PdfDrawingAnnotation | PdfDrawingDraft;
  size: AnnotationSurfaceSize;
  stroke: string;
  strokeWidth: number;
}) {
  if (annotation.type === "ink") {
    return (
      <path
        d={smoothStrokePath(annotation.points.map((point) => toPixels(point, size)))}
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    );
  }

  const from = toPixels(annotation.from, size);
  const to = toPixels(annotation.to, size);

  if (annotation.shape === "rectangle") {
    return (
      <rect
        x={Math.min(from.x, to.x)}
        y={Math.min(from.y, to.y)}
        width={Math.abs(to.x - from.x)}
        height={Math.abs(to.y - from.y)}
        fill="none"
        stroke={stroke}
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    );
  }

  if (annotation.shape === "ellipse") {
    return (
      <ellipse
        cx={(from.x + to.x) / 2}
        cy={(from.y + to.y) / 2}
        rx={Math.abs(to.x - from.x) / 2}
        ry={Math.abs(to.y - from.y) / 2}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  }

  return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={stroke} strokeLinecap="round" strokeWidth={strokeWidth} />;
}

/**
 * A drawing's geometry at the current zoom, drawn visibly or (with a wide,
 * transparent stroke) as its hit area. Arrow heads are sized from the visible
 * stroke so the hit area keeps the same head.
 */
function ArrowAwareGeometry({
  annotation,
  size,
  zoom,
  stroke,
  hitWidth,
}: {
  annotation: PdfDrawingAnnotation | PdfDrawingDraft;
  size: AnnotationSurfaceSize;
  zoom: number;
  stroke: string;
  hitWidth?: number;
}) {
  const visibleWidth = annotation.strokeWidth * zoom;

  if (annotation.type === "shape" && annotation.shape === "arrow") {
    const from = toPixels(annotation.from, size);
    const to = toPixels(annotation.to, size);
    const shaftEnd = arrowShaftEnd(from, to, visibleWidth);
    const width = hitWidth ?? visibleWidth;

    return (
      <>
        <line x1={from.x} y1={from.y} x2={shaftEnd.x} y2={shaftEnd.y} stroke={stroke} strokeLinecap="round" strokeWidth={width} />
        <polygon
          points={arrowHeadPoints(from, to, visibleWidth)}
          fill={stroke}
          stroke={stroke}
          strokeLinejoin="round"
          strokeWidth={hitWidth ?? Math.max(1, visibleWidth / 2)}
        />
      </>
    );
  }

  return <DrawingGeometry annotation={annotation} size={size} stroke={stroke} strokeWidth={hitWidth ?? visibleWidth} />;
}

const DrawingItem = memo(function DrawingItem({
  annotation,
  interactive,
  size,
  zoom,
  onPointerDown,
}: {
  annotation: PdfDrawingAnnotation;
  interactive: boolean;
  size: AnnotationSurfaceSize;
  zoom: number;
  onPointerDown: (event: PointerEvent<SVGGElement>, annotation: PdfDrawingAnnotation) => void;
}) {
  const hitWidth = annotation.strokeWidth * zoom + HIT_SLOP_PX * 2;

  return (
    <g data-pdf-annotation-id={annotation.id} data-pdf-drawing={annotation.type}>
      <ArrowAwareGeometry annotation={annotation} size={size} zoom={zoom} stroke={annotation.color} />
      {interactive ? (
        <g
          className="pdf-drawing-hit"
          pointerEvents="stroke"
          onPointerDown={(event) => onPointerDown(event, annotation)}
          // The page hit-tests highlights on click; a drawing on top wins.
          onClick={(event) => event.stopPropagation()}
        >
          <ArrowAwareGeometry annotation={annotation} size={size} zoom={zoom} stroke="transparent" hitWidth={hitWidth} />
        </g>
      ) : null}
    </g>
  );
});

function SelectionFrame({
  annotation,
  size,
  zoom,
  onHandlePointerDown,
}: {
  annotation: PdfDrawingAnnotation;
  size: AnnotationSurfaceSize;
  zoom: number;
  onHandlePointerDown: (event: PointerEvent<SVGCircleElement>, handle: Handle) => void;
}) {
  const bounds = drawingBounds(annotation);
  const pad = (annotation.strokeWidth * zoom) / 2 + 4;
  const handles: { handle: Handle; point: PdfAnnotationPoint }[] =
    annotation.type === "shape"
      ? isClosedShape(annotation.shape)
        ? (["nw", "ne", "se", "sw"] as const).map((handle) => ({ handle, point: corner(annotation, handle) }))
        : [
            { handle: "from", point: annotation.from },
            { handle: "to", point: annotation.to },
          ]
      : [];

  return (
    <g aria-hidden>
      <rect
        className="pdf-drawing-frame"
        x={bounds.x * size.width - pad}
        y={bounds.y * size.height - pad}
        width={bounds.width * size.width + pad * 2}
        height={bounds.height * size.height + pad * 2}
      />
      {handles.map(({ handle, point }) => {
        const center = toPixels(point, size);

        return (
          <circle
            key={handle}
            className="pdf-drawing-handle"
            data-pdf-annotation-ui
            data-handle={handle}
            cx={center.x}
            cy={center.y}
            r={5}
            style={{ cursor: HANDLE_CURSORS[handle] }}
            onPointerDown={(event) => onHandlePointerDown(event, handle)}
            onClick={(event) => event.stopPropagation()}
          />
        );
      })}
    </g>
  );
}

export function PdfDrawingLayer({
  annotations,
  markups,
  mode,
  pageSize,
  selectedAnnotationId,
  style,
  zoom,
  onAdd,
  onErase,
  onSelect,
  onUpdate,
}: {
  annotations: PdfDrawingAnnotation[];
  /** Text markup the eraser can also remove. */
  markups: PdfHighlightAnnotation[];
  mode: PdfDrawingMode;
  pageSize: AnnotationSurfaceSize;
  selectedAnnotationId: string;
  style: NewDrawingStyle;
  zoom: number;
  onAdd: (draft: PdfDrawingDraft) => void;
  /** Every deletion in one eraser drag shares a gesture key, for one undo step. */
  onErase: (ids: string[], gestureKey: string) => void;
  onSelect: (annotation: PdfAnnotation) => void;
  onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<PdfDrawingDraft | null>(null);
  const eraseRef = useRef<{ erased: Set<string>; key: string; last: PdfAnnotationPoint } | null>(null);
  const [draft, setDraft] = useState<PdfDrawingDraft | null>(null);
  const [transient, setTransient] = useState<Transient | null>(null);
  const transientRef = useRef<Transient | null>(null);
  const latestRef = useRef({ annotations, markups, pageSize, zoom, selectedAnnotationId });

  useLayoutEffect(() => {
    latestRef.current = { annotations, markups, pageSize, zoom, selectedAnnotationId };
  });

  const interactive = mode === "select";
  const drawingSurface = mode === "draw" || mode === "shape" || mode === "eraser";
  const shown = transient
    ? annotations.map((annotation) =>
        annotation.id === transient.id ? ({ ...annotation, ...transient.patch } as PdfDrawingAnnotation) : annotation,
      )
    : annotations;
  const selected = interactive ? shown.find((annotation) => annotation.id === selectedAnnotationId) : undefined;

  // ---- Select, move and resize ------------------------------------------

  function beginGesture(event: PointerEvent<SVGElement>, annotation: PdfDrawingAnnotation, handle?: Handle) {
    if (event.button !== 0) {
      return;
    }

    // Keep the press from starting a text selection in the layer below.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      handle,
      id: annotation.id,
      moved: false,
      start: annotation,
      startClient: { x: event.clientX, y: event.clientY },
    };

    if (latestRef.current.selectedAnnotationId !== annotation.id) {
      onSelect(annotation);
    }
  }

  function moveGesture(event: PointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    const svg = svgRef.current;

    if (!gesture || !svg) {
      return;
    }

    const dx = event.clientX - gesture.startClient.x;
    const dy = event.clientY - gesture.startClient.y;

    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }

    gesture.moved = true;
    const bounds = svg.getBoundingClientRect();
    let patch: Partial<PdfDrawingAnnotation>;

    if (gesture.handle && gesture.start.type === "shape") {
      patch = resizeShape(gesture.start, gesture.handle, pointInElement(event, svg), event.shiftKey, latestRef.current.pageSize);
    } else {
      patch = translateDrawing(gesture.start, bounds.width ? dx / bounds.width : 0, bounds.height ? dy / bounds.height : 0);
    }

    transientRef.current = { id: gesture.id, patch };
    setTransient(transientRef.current);
  }

  function endGesture(event: PointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;

    if (!gesture) {
      return;
    }

    gestureRef.current = null;
    const moved = transientRef.current;
    transientRef.current = null;
    setTransient(null);

    if (gesture.moved && moved?.id === gesture.id && event.type !== "pointercancel") {
      onUpdate(gesture.id, moved.patch as Partial<PdfAnnotation>);
    }
  }

  // ---- Pen, shapes and eraser -------------------------------------------

  function eraseAlong(from: PdfAnnotationPoint, to: PdfAnnotationPoint) {
    const erase = eraseRef.current;
    const { annotations: drawings, markups: marks, pageSize: size, zoom: scale } = latestRef.current;

    if (!erase || !size.width || !size.height) {
      return;
    }

    const start = toPixels(from, size);
    const end = toPixels(to, size);
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / ERASER_STEP_PX));
    const hits: string[] = [];

    for (let step = 0; step <= steps; step += 1) {
      const point = {
        x: start.x + ((end.x - start.x) * step) / steps,
        y: start.y + ((end.y - start.y) * step) / steps,
      };

      for (const drawing of drawings) {
        if (!erase.erased.has(drawing.id) && hitTestDrawing(drawing, point, size, scale, HIT_SLOP_PX)) {
          erase.erased.add(drawing.id);
          hits.push(drawing.id);
        }
      }

      const x = point.x / size.width;
      const y = point.y / size.height;
      const slackX = 2 / size.width;
      const slackY = 2 / size.height;

      for (const mark of marks) {
        if (
          !erase.erased.has(mark.id) &&
          mark.rects.some(
            (rect) =>
              x >= rect.x - slackX &&
              x <= rect.x + rect.width + slackX &&
              y >= rect.y - slackY &&
              y <= rect.y + rect.height + slackY,
          )
        ) {
          erase.erased.add(mark.id);
          hits.push(mark.id);
        }
      }
    }

    if (hits.length) {
      onErase(hits, erase.key);
    }
  }

  function startSurfaceGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointInElement(event, event.currentTarget);

    if (mode === "eraser") {
      eraseRef.current = { erased: new Set(), key: `erase:${createAnnotationId()}`, last: point };
      eraseAlong(point, point);
      return;
    }

    const next: PdfDrawingDraft =
      mode === "draw"
        ? { type: "ink", color: style.color, strokeWidth: style.strokeWidth, points: [point] }
        : { type: "shape", shape: style.shape, color: style.color, strokeWidth: style.strokeWidth, from: point, to: point };

    draftRef.current = next;
    setDraft(next);
  }

  function updateSurfaceGesture(event: PointerEvent<HTMLDivElement>) {
    const surface = event.currentTarget;
    const erase = eraseRef.current;

    if (erase) {
      const point = pointInElement(event, surface);
      eraseAlong(erase.last, point);
      erase.last = point;
      return;
    }

    const current = draftRef.current;

    if (!current) {
      return;
    }

    if (current.type === "ink") {
      const size = latestRef.current.pageSize;
      // Coalesced samples keep fast strokes smooth between animation frames.
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = [...current.points];

      for (const sample of samples.length ? samples : [event.nativeEvent]) {
        const point = pointInElement(sample, surface);
        const last = points.at(-1);

        if (shouldKeepSample(last && toPixels(last, size), toPixels(point, size), MIN_SAMPLE_DISTANCE_PX)) {
          points.push(point);
        }
      }

      if (points.length !== current.points.length) {
        draftRef.current = { ...current, points };
        setDraft(draftRef.current);
      }

      return;
    }

    const point = pointInElement(event, surface);
    const to = event.shiftKey ? constrainedEnd(current.shape, current.from, point, latestRef.current.pageSize) : point;
    draftRef.current = { ...current, to };
    setDraft(draftRef.current);
  }

  function finishSurfaceGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    eraseRef.current = null;
    const finished = draftRef.current;
    draftRef.current = null;
    setDraft(null);

    if (!finished || event.type === "pointercancel") {
      return;
    }

    if (finished.type === "shape") {
      const from = toPixels(finished.from, pageSize);
      const to = toPixels(finished.to, pageSize);

      // A click without a drag draws nothing.
      if (Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) < MIN_SHAPE_SIZE_PX) {
        return;
      }
    }

    onAdd(finished);
  }

  return (
    <>
      <svg
        ref={svgRef}
        className="pdf-drawing-layer"
        width={pageSize.width}
        height={pageSize.height}
        aria-hidden={!interactive || undefined}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        {shown.map((annotation) => (
          <DrawingItem
            key={annotation.id}
            annotation={annotation}
            interactive={interactive}
            size={pageSize}
            zoom={zoom}
            onPointerDown={beginGesture}
          />
        ))}
        {draft ? <ArrowAwareGeometry annotation={draft} size={pageSize} zoom={zoom} stroke={draft.color} /> : null}
        {selected ? (
          <SelectionFrame
            annotation={selected}
            size={pageSize}
            zoom={zoom}
            onHandlePointerDown={(event, handle) => {
              event.stopPropagation();
              beginGesture(event, selected, handle);
            }}
          />
        ) : null}
      </svg>

      {drawingSurface ? (
        <div
          className="pdf-drawing-surface"
          data-mode={mode}
          onPointerDown={startSurfaceGesture}
          onPointerMove={updateSurfaceGesture}
          onPointerUp={finishSurfaceGesture}
          onPointerCancel={finishSurfaceGesture}
        />
      ) : null}
    </>
  );
}
