"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { boundsOf, boxCorners, controlPointsFor, outlineOf, smoothStroke, type Geometry } from "@/lib/detection/geometry";
import type { Box, Detection, Point, Quadrats } from "@/lib/detection/results";

export type DetectionLayers = { masks: boolean; boxes: boolean; labels: boolean; centroids: boolean; density: boolean; examples: boolean };
export const DEFAULT_LAYERS: DetectionLayers = { masks: true, boxes: true, labels: true, centroids: false, density: false, examples: true };

/**
 * view: inspect, pan and select. draw: box an example for a visual prompt.
 * calibrate: a line along a scale bar. tag-*: outline an object by hand.
 * edit: drag an object's control points or box corners.
 */
export type CanvasMode = "view" | "draw" | "calibrate" | "tag-box" | "tag-polygon" | "tag-freeform" | "edit";

type Transform = { scale: number; x: number; y: number };
const FIT: Transform = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 12;
/** Handle size and click tolerance, in screen pixels. */
const HANDLE = 5;
const CLOSE_DISTANCE = 9;

type Drag =
  | { kind: "pan"; x: number; y: number; start: Transform; moved: boolean }
  | { kind: "shape"; from: Point }
  | { kind: "stroke" }
  | { kind: "handle"; index: number; start: Geometry }
  | { kind: "move"; from: Point; start: Geometry; moved: boolean };

const pointsAttribute = (points: Point[]) => points.map(([x, y]) => `${x},${y}`).join(" ");

/**
 * The photo with its detections drawn over it in image pixels. Scroll to
 * zoom; drag to pan when zoomed in.
 */
export function DetectionCanvas({
  src,
  width,
  height,
  detections,
  colors,
  layers,
  quadrats,
  examples,
  hoverId,
  selectedId,
  mode,
  tagColor = "#ffffff",
  editing = null,
  onNaturalSize,
  onHover,
  onSelect,
  onBox,
  onLine,
  onTag,
  onEditChange,
  onEditDone,
  onRequestEdit,
  dark = true,
}: {
  src: string;
  /** The coordinate space of the detections; the photo's natural size. */
  width: number;
  height: number;
  detections: Detection[];
  /** Each label's color. */
  colors: Map<string, string>;
  layers: DetectionLayers;
  quadrats: Quadrats | null;
  /** Example boxes of visual prompts drawn on this photo. */
  examples: Array<{ box: Box; color: string; label: string }>;
  hoverId: number | null;
  selectedId: number | null;
  mode: CanvasMode;
  /** The color of the label being tagged, for the outline being drawn. */
  tagColor?: string;
  /** The object whose outline is being edited, and its control points. */
  editing?: { id: number; geometry: Geometry; color: string } | null;
  onNaturalSize: (size: { width: number; height: number }) => void;
  onHover: (id: number | null) => void;
  onSelect: (id: number | null) => void;
  onBox: (box: Box) => void;
  onLine: (line: [Point, Point]) => void;
  onTag?: (geometry: Geometry) => void;
  /** `final` is false while a point is being dragged and true when it is let go. */
  onEditChange?: (geometry: Geometry, final: boolean) => void;
  onEditDone?: () => void;
  onRequestEdit?: (id: number) => void;
  dark?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>(FIT);
  const [draft, setDraft] = useState<{ from: Point; to: Point } | null>(null);
  const [stroke, setStroke] = useState<Point[]>([]);
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setStage({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A drawing in progress belongs to the mode it was started in.
  const [draftMode, setDraftMode] = useState(mode);
  if (draftMode !== mode) {
    setDraftMode(mode);
    setPolygon([]);
    setStroke([]);
    setDraft(null);
    setActiveHandle(null);
  }
  const [editingId, setEditingId] = useState(editing?.id ?? null);
  if (editingId !== (editing?.id ?? null)) {
    setEditingId(editing?.id ?? null);
    setActiveHandle(null);
  }

  // The photo fitted in the stage with a margin; zoom scales this frame.
  const margin = 24;
  const fit = width && height && stage.width && stage.height
    ? Math.min((stage.width - margin * 2) / width, (stage.height - margin * 2) / height)
    : 0;
  const frameWidth = Math.max(1, width * fit);
  const frameHeight = Math.max(1, height * fit);
  // Image pixels per screen pixel, to keep strokes and labels a constant size on screen.
  const unit = fit ? 1 / (fit * transform.scale) : 1;

  const toImage = useCallback((clientX: number, clientY: number): Point => {
    const rect = frameRef.current!.getBoundingClientRect();
    return [
      Math.round(Math.min(width, Math.max(0, ((clientX - rect.left) / rect.width) * width)) * 10) / 10,
      Math.round(Math.min(height, Math.max(0, ((clientY - rect.top) / rect.height) * height)) * 10) / 10,
    ];
  }, [width, height]);

  const zoomAt = useCallback((scale: (current: number) => number, clientX: number, clientY: number) => {
    const element = stageRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setTransform((current) => {
      const next = Math.min(MAX_ZOOM, Math.max(1, scale(current.scale)));
      if (next === 1) return FIT;
      const pointX = clientX - (rect.left + rect.width / 2);
      const pointY = clientY - (rect.top + rect.height / 2);
      const factor = next / current.scale;
      return { scale: next, x: pointX - (pointX - current.x) * factor, y: pointY - (pointY - current.y) * factor };
    });
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const intensity = event.ctrlKey ? 0.01 : 0.0025;
      zoomAt((scale) => scale * Math.exp(-event.deltaY * intensity), event.clientX, event.clientY);
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const finishPolygon = useCallback((points: Point[]) => {
    // A double-click lands its last point twice.
    const unique = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 0.5);
    setPolygon([]);
    if (unique.length >= 3) onTag?.({ shape: "polygon", points: unique, curve: "linear" });
  }, [onTag]);

  const removeHandle = useCallback((index: number) => {
    if (!editing || editing.geometry.shape === "box" || editing.geometry.points.length <= 3) return;
    onEditChange?.({ ...editing.geometry, points: editing.geometry.points.filter((_, i) => i !== index) }, true);
    setActiveHandle(null);
  }, [editing, onEditChange]);

  // Keys for a polygon being drawn and a selected control point. They run in
  // the capture phase, ahead of the tool's own Esc and Enter.
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      if (mode === "tag-polygon" && polygon.length) {
        if (event.key === "Escape") setPolygon([]);
        else if (event.key === "Enter") finishPolygon(polygon);
        else if (event.key === "Backspace" || event.key === "Delete") setPolygon((current) => current.slice(0, -1));
        else return;
      } else if (mode === "edit" && activeHandle !== null && (event.key === "Backspace" || event.key === "Delete")) {
        removeHandle(activeHandle);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [mode, polygon, activeHandle, finishPolygon, removeHandle]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "pan", x: event.clientX, y: event.clientY, start: transform, moved: false };
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !fit) return;
    const point = toImage(event.clientX, event.clientY);
    if (mode === "draw" || mode === "calibrate" || mode === "tag-box") {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "shape", from: point };
      setDraft({ from: point, to: point });
    } else if (mode === "tag-freeform") {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "stroke" };
      setStroke([point]);
    } else if (mode === "tag-polygon") {
      if (polygon.length >= 3 && Math.hypot(point[0] - polygon[0][0], point[1] - polygon[0][1]) < CLOSE_DISTANCE * unit) finishPolygon(polygon);
      else setPolygon((current) => [...current, point]);
    } else {
      // Inspect and edit: a drag pans when zoomed in; a click on empty photo deselects or finishes editing.
      startPan(event);
    }
  }

  /** A handle or the edited shape's body was grabbed. */
  function grab(event: ReactPointerEvent<SVGElement>, drag: Drag) {
    if (event.button !== 0) return;
    event.stopPropagation();
    stageRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = drag;
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (mode === "tag-polygon" && fit) setCursor(toImage(event.clientX, event.clientY));
    if (!drag) return;
    const point = toImage(event.clientX, event.clientY);
    if (drag.kind === "pan") {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (transform.scale > 1) setTransform({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy });
    } else if (drag.kind === "shape") {
      setDraft({ from: drag.from, to: point });
    } else if (drag.kind === "stroke") {
      setStroke((current) => {
        const last = current[current.length - 1];
        return last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 2 * unit ? current : [...current, point];
      });
    } else if (drag.kind === "handle" && editing) {
      onEditChange?.(dragHandle(drag.start, drag.index, point), false);
    } else if (drag.kind === "move" && editing) {
      const dx = point[0] - drag.from[0];
      const dy = point[1] - drag.from[1];
      if (Math.hypot(dx, dy) > unit) drag.moved = true;
      onEditChange?.({ ...drag.start, points: drag.start.points.map(([x, y]) => [clamp(x + dx, width), clamp(y + dy, height)]) }, false);
    }
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const point = toImage(event.clientX, event.clientY);
    if (drag.kind === "pan") {
      // A click on empty photo: deselect, or finish editing.
      if (!drag.moved) {
        if (mode === "edit") onEditDone?.();
        else if (mode === "view") onSelect(null);
      }
    } else if (drag.kind === "shape") {
      setDraft(null);
      const [x1, y1] = drag.from;
      const [x2, y2] = point;
      // Ignore clicks: a shape needs a few screen pixels.
      if (Math.hypot(x2 - x1, y2 - y1) < 4 * unit) return;
      const box: Box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      if (mode === "draw") onBox(box);
      else if (mode === "calibrate") onLine([drag.from, point]);
      else if (mode === "tag-box") onTag?.({ shape: "box", points: boxCorners(box), curve: "linear" });
    } else if (drag.kind === "stroke") {
      const points = stroke;
      setStroke([]);
      const [x1, y1, x2, y2] = points.length ? boundsOf(points) : [0, 0, 0, 0];
      if (points.length < 4 || Math.max(x2 - x1, y2 - y1) < 6 * unit) return;
      // Steady the hand, then keep just enough points to follow the stroke.
      onTag?.({ shape: "polygon", points: controlPointsFor(smoothStroke(points, 3), 32, 4), curve: "smooth" });
    } else if (drag.kind === "handle" && editing) {
      onEditChange?.(dragHandle(drag.start, drag.index, point), true);
    } else if (drag.kind === "move" && editing && drag.moved) {
      const dx = point[0] - drag.from[0];
      const dy = point[1] - drag.from[1];
      onEditChange?.({ ...drag.start, points: drag.start.points.map(([x, y]) => [clamp(x + dx, width), clamp(y + dy, height)]) }, true);
    }
  }

  function dragHandle(start: Geometry, index: number, point: Point): Geometry {
    if (start.shape === "box") {
      // The opposite corner stays put; the box stays axis-aligned.
      const opposite = start.points[(index + 2) % 4];
      return { ...start, points: boxCorners(boundsOf([point, opposite])) };
    }
    return { ...start, points: start.points.map((existing, i) => (i === index ? point : existing)) };
  }

  const fontSize = 11 * unit;
  const stroke1 = 1.5;
  const maxCount = quadrats ? Math.max(1, ...quadrats.counts) : 1;
  const tagging = mode.startsWith("tag-") || mode === "draw" || mode === "calibrate";
  const editOutline = editing ? outlineOf(editing.geometry.shape, editing.geometry.points, editing.geometry.curve) : null;

  return (
    <div
      ref={stageRef}
      className={`relative flex min-h-0 min-w-0 flex-1 touch-none items-center justify-center overflow-hidden ${dark ? "bg-neutral-950" : "bg-muted"} ${tagging ? "cursor-crosshair" : transform.scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerLeave={() => setCursor(null)}
      onPointerCancel={() => { dragRef.current = null; setDraft(null); setStroke([]); }}
      onDoubleClick={() => {
        if (mode === "tag-polygon") finishPolygon(polygon);
        else if (mode === "view") setTransform(FIT);
      }}
    >
      <div
        ref={frameRef}
        className="relative shrink-0"
        style={{ width: frameWidth, height: frameHeight, transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: "center" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full select-none"
          onLoad={(event) => onNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${width || 1} ${height || 1}`} preserveAspectRatio="none" aria-label="Detections">
          {layers.density && quadrats ? quadrats.counts.map((count, index) => {
            const column = index % quadrats.columns;
            const row = Math.floor(index / quadrats.columns);
            const cellWidth = width / quadrats.columns;
            const cellHeight = height / quadrats.rows;
            return (
              <g key={`q${index}`} pointerEvents="none">
                <rect x={column * cellWidth} y={row * cellHeight} width={cellWidth} height={cellHeight} fill="#f59e0b" fillOpacity={0.55 * (count / maxCount)} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <text x={column * cellWidth + 4 * unit} y={row * cellHeight + 13 * unit} fontSize={fontSize} fill="#ffffff" style={{ paintOrder: "stroke" }} stroke="#000000" strokeWidth={2.5 * unit}>{count}</text>
              </g>
            );
          }) : null}
          {detections.map((detection) => {
            const color = colors.get(detection.label) ?? "#888888";
            const isEditing = editing?.id === detection.id;
            const active = isEditing || detection.id === hoverId || detection.id === selectedId;
            const [x1, y1, x2, y2] = isEditing && editOutline ? boundsOf(editOutline) : detection.box;
            const outline = isEditing && editOutline ? (editing!.geometry.shape === "box" ? [] : editOutline) : detection.polygon;
            const interactive = mode === "view" || (mode === "edit" && !isEditing);
            const marker = detection.origin === "manual" ? "✎" : detection.origin === "edited" ? "✱" : "";
            return (
              <g
                key={detection.id}
                className={interactive ? "cursor-pointer" : undefined}
                pointerEvents={tagging ? "none" : undefined}
                onPointerEnter={() => onHover(detection.id)}
                onPointerLeave={() => onHover(null)}
                onPointerDown={(event) => {
                  if (isEditing && editing) grab(event, { kind: "move", from: toImage(event.clientX, event.clientY), start: editing.geometry, moved: false });
                  else if (interactive) event.stopPropagation();
                }}
                onClick={(event) => {
                  if (!interactive) return;
                  event.stopPropagation();
                  if (mode === "edit") onRequestEdit?.(detection.id);
                  else onSelect(detection.id === selectedId ? null : detection.id);
                }}
                onDoubleClick={(event) => {
                  if (mode !== "view") return;
                  event.stopPropagation();
                  onRequestEdit?.(detection.id);
                }}
              >
                {(layers.masks || isEditing) && outline.length >= 3 ? (
                  <polygon points={pointsAttribute(outline)} fill={color} fillOpacity={isEditing ? 0.25 : active ? 0.55 : 0.32} stroke={color} strokeWidth={active ? 2.5 : 1.25} vectorEffect="non-scaling-stroke" className={isEditing ? "cursor-move" : undefined} />
                ) : null}
                {layers.boxes || active || (detection.shape === "box" && layers.masks) ? (
                  <rect
                    x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                    fill={detection.shape === "box" && (layers.masks || isEditing) ? color : "none"}
                    fillOpacity={detection.shape === "box" ? (isEditing ? 0.25 : 0.2) : 0}
                    stroke={color}
                    strokeWidth={active ? 2.5 : stroke1}
                    strokeDasharray={detection.shape !== "box" && layers.masks && !active ? "4 3" : undefined}
                    vectorEffect="non-scaling-stroke"
                    className={isEditing ? "cursor-move" : undefined}
                  />
                ) : null}
                {layers.centroids ? (
                  <circle cx={detection.centroid[0]} cy={detection.centroid[1]} r={3 * unit} fill="#ffffff" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                ) : null}
                {layers.labels || active ? (
                  <text x={x1 + 2 * unit} y={Math.max(fontSize, y1 - 3 * unit)} fontSize={fontSize} fontWeight={600} fill="#ffffff" stroke={color} strokeWidth={3 * unit} style={{ paintOrder: "stroke" }} pointerEvents="none">
                    {`${detection.id} ${detection.label} ${detection.origin === "manual" ? "manual" : detection.confidence.toFixed(2)}${marker ? ` ${marker}` : ""}`}
                  </text>
                ) : null}
              </g>
            );
          })}
          {editing ? (
            <g>
              {editing.geometry.shape === "polygon" ? editing.geometry.points.map((point, index) => {
                // A hollow handle between neighbours inserts a point where it is dragged.
                const next = editing.geometry.points[(index + 1) % editing.geometry.points.length];
                const middle: Point = [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2];
                return (
                  <circle
                    key={`m${index}`}
                    cx={middle[0]} cy={middle[1]} r={HANDLE * 0.75 * unit}
                    fill="#000000" fillOpacity={0.35} stroke="#ffffff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                    className="cursor-copy"
                    onPointerDown={(event) => {
                      const points = [...editing.geometry.points.slice(0, index + 1), middle, ...editing.geometry.points.slice(index + 1)];
                      const start = { ...editing.geometry, points };
                      onEditChange?.(start, false);
                      setActiveHandle(index + 1);
                      grab(event, { kind: "handle", index: index + 1, start });
                    }}
                  >
                    <title>Drag to add a point</title>
                  </circle>
                );
              }) : null}
              {editing.geometry.points.map((point, index) => (
                <circle
                  key={`h${index}`}
                  cx={point[0]} cy={point[1]} r={HANDLE * unit}
                  fill={activeHandle === index ? editing.color : "#ffffff"} stroke={activeHandle === index ? "#ffffff" : editing.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
                  className={editing.geometry.shape === "box" ? (index % 2 === 0 ? "cursor-nwse-resize" : "cursor-nesw-resize") : "cursor-grab"}
                  onPointerDown={(event) => {
                    setActiveHandle(index);
                    grab(event, { kind: "handle", index, start: editing.geometry });
                  }}
                  onDoubleClick={(event) => { event.stopPropagation(); removeHandle(index); }}
                >
                  <title>{editing.geometry.shape === "box" ? "Drag to resize" : "Drag to move; double-click or Delete to remove"}</title>
                </circle>
              ))}
            </g>
          ) : null}
          {layers.examples ? examples.map((example, index) => {
            const [x1, y1, x2, y2] = example.box;
            return (
              <g key={`e${index}`} pointerEvents="none">
                <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="#ffffff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
                <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={example.color} strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                <text x={x1} y={y2 + fontSize + 2 * unit} fontSize={fontSize} fill="#ffffff" stroke="#000000" strokeWidth={2.5 * unit} style={{ paintOrder: "stroke" }}>{`example: ${example.label}`}</text>
              </g>
            );
          }) : null}
          {draft && (mode === "draw" || mode === "tag-box") ? (
            <rect
              x={Math.min(draft.from[0], draft.to[0])} y={Math.min(draft.from[1], draft.to[1])} width={Math.abs(draft.to[0] - draft.from[0])} height={Math.abs(draft.to[1] - draft.from[1])}
              fill={mode === "tag-box" ? tagColor : "#ffffff"} fillOpacity={mode === "tag-box" ? 0.2 : 0.12} stroke={mode === "tag-box" ? tagColor : "#ffffff"} strokeWidth={1.5} strokeDasharray={mode === "draw" ? "5 4" : undefined} vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {stroke.length > 1 ? (
            <polyline points={pointsAttribute(stroke)} fill="none" stroke={tagColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" pointerEvents="none" />
          ) : null}
          {polygon.length ? (
            <g pointerEvents="none">
              <polyline points={pointsAttribute(cursor ? [...polygon, cursor] : polygon)} fill={tagColor} fillOpacity={0.15} stroke={tagColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {polygon.map(([x, y], index) => (
                <circle key={index} cx={x} cy={y} r={(index === 0 && polygon.length >= 3 ? HANDLE * 1.3 : HANDLE * 0.8) * unit} fill={index === 0 ? tagColor : "#ffffff"} stroke={tagColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          ) : null}
          {draft && mode === "calibrate" ? (
            <g>
              <line x1={draft.from[0]} y1={draft.from[1]} x2={draft.to[0]} y2={draft.to[1]} stroke="#000000" strokeWidth={4} vectorEffect="non-scaling-stroke" />
              <line x1={draft.from[0]} y1={draft.from[1]} x2={draft.to[0]} y2={draft.to[1]} stroke="#facc15" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={draft.to[0] + 6 * unit} y={draft.to[1]} fontSize={fontSize} fill="#facc15" stroke="#000000" strokeWidth={2.5 * unit} style={{ paintOrder: "stroke" }}>
                {`${Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]).toFixed(1)} px`}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
      {transform.scale > 1 ? (
        <button type="button" className="absolute bottom-3 right-3 rounded-md bg-black/60 px-2.5 py-1 text-xs text-white hover:bg-black/80" onClick={() => setTransform(FIT)}>
          {Math.round(transform.scale * 100)}% · Fit
        </button>
      ) : null}
    </div>
  );
}

function clamp(value: number, max: number) {
  return Math.round(Math.min(max, Math.max(0, value)) * 10) / 10;
}
