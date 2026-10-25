"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { encodeInkSamples, sampleBounds, strokeSamples } from "@/lib/ink/codec";
import { hitTestSamples, inflateRect, simplifySamples, splitSamplesByCircle, strokeReach, unionRect } from "@/lib/ink/geometry";
import { widthInUnits } from "@/lib/ink/tools";
import { createInkId, type InkFrame, type InkLineStyle, type InkRect, type InkSample, type InkStroke, type MergedInkStroke } from "@/lib/ink/types";
import { attachInkInput, type InkGestureKind } from "./ink-input";
import { inkPower } from "./ink-power";
import { IDENTITY_INK_MATRIX, InkRenderer, applyInkTransform, inkCanvasRatio, paintLiveStroke, paintStroke, sizeCanvas, type InkCanvasSize, type InkMatrix } from "./ink-renderer";
import { inkSelection } from "./ink-selection";
import { activeInkStyle, type InkToolsState } from "./use-ink-tools";

/*
 * One ink surface: committed strokes (ink-renderer), the stroke being drawn
 * on a desynchronized live canvas, and pointer input (ink-input). React
 * renders it once; strokes and tools are read through refs, so a pen sample
 * never re-renders anything (docs/ink-plan.md, "Rendering engine").
 *
 * The live canvas also shows the lasso: its outline while drawing, the
 * selection's frame, and selected strokes while they are dragged.
 */

export type InkChange = {
  add: InkStroke[];
  /** Strokes erased, cut, moved or restyled, with whose file held them. */
  removed: MergedInkStroke[];
  /** One eraser drag shares a key, for one undo step. */
  gesture?: string;
};

type Props = {
  /** The units strokes are stored in. */
  frame: InkFrame;
  /**
   * The size of what is shown, in view units, when it differs from the frame:
   * a gallery photo edited since it was inked, whose strokes `matrix` maps.
   */
  viewSize?: { width: number; height: number };
  /** Stroke units to view units; identity by default. */
  matrix?: InkMatrix;
  /** Any CSS zoom an ancestor applies, so the canvases stay sharp. */
  zoom?: number;
  strokes: readonly MergedInkStroke[];
  tools: InkToolsState;
  /** False while the document is read-only or ink is not being drawn: the ink shows but takes no input. */
  enabled?: boolean;
  /** Whether a mouse draws here now (a pen always does while enabled). */
  mouseDraws: boolean;
  onChange: (change: InkChange) => void;
  /** The lowest point (in view units) a pen has reached in the current stroke. */
  onReach?: (y: number) => void;
  /** Pans the host by (dx, dy) CSS px under a finger; without it a finger scrolls the page. */
  onPan?: (dx: number, dy: number) => void;
  className?: string;
  style?: CSSProperties;
};

/** The author of strokes this surface made itself, before the host has them (use-ink-document maps it). */
export const OWN_AUTHOR = "";

/** Surfaces this far outside the viewport give up their canvases. */
const RELEASE_MARGIN = "1500px 0px";
/** Pasted strokes land this far (CSS px) below and right of the originals. */
const PASTE_OFFSET_PX = 16;

function invert([a, b, c, d, e, f]: InkMatrix): InkMatrix {
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function insidePolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A stroke moved or restyled, under a new id. */
function variant(stroke: InkStroke, change: { dx?: number; dy?: number; color?: `#${string}`; lineStyle?: InkLineStyle }): InkStroke {
  const dx = change.dx ?? 0;
  const dy = change.dy ?? 0;
  const samples = dx || dy ? strokeSamples(stroke).map((sample) => ({ ...sample, x: sample.x + dx, y: sample.y + dy })) : null;
  return {
    ...stroke,
    id: createInkId(),
    ...(change.color ? { color: change.color } : {}),
    ...(change.lineStyle ? { lineStyle: change.lineStyle } : {}),
    ...(samples ? { points: encodeInkSamples(samples), bounds: sampleBounds(samples) } : {}),
  };
}

const boundsOf = (strokes: readonly InkStroke[]) =>
  strokes.reduce<InkRect | null>((box, stroke) => unionRect(box, inflateRect(stroke.bounds, strokeReach(stroke.brush, stroke.width))), null);

export function InkSurface({ frame, viewSize, matrix, zoom = 1, strokes, tools, enabled = true, mouseDraws, onChange, onReach, onPan, className, style }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const penRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<InkRenderer | null>(null);
  const measureRef = useRef<() => void>(() => undefined);
  const clearSelectionRef = useRef<() => void>(() => undefined);
  const latest = useRef({ strokes, tools, enabled, mouseDraws, onChange, onReach, onPan, frame, viewSize, matrix, zoom });
  useLayoutEffect(() => { latest.current = { strokes, tools, enabled, mouseDraws, onChange, onReach, onPan, frame, viewSize, matrix, zoom }; });

  // Committed strokes follow the props.
  useLayoutEffect(() => {
    rendererRef.current?.setStrokes(strokes.map((item) => item.stroke));
  }, [strokes]);

  // A new view (an edited photo), zoom or matrix redraws at the new size.
  useLayoutEffect(() => { measureRef.current(); }, [zoom, matrix, viewSize?.width, viewSize?.height]);

  // Leaving the lasso drops its selection.
  useEffect(() => { if (tools.tool !== "select") clearSelectionRef.current(); }, [tools.tool]);

  // Size, visibility and input, set up once per surface.
  useEffect(() => {
    const root = rootRef.current;
    const highlight = highlightRef.current;
    const pen = penRef.current;
    const live = liveRef.current;
    if (!root || !highlight || !pen || !live) return;
    const owner = Symbol("ink surface");
    const renderer = new InkRenderer({ highlight, pen }, latest.current.frame);
    rendererRef.current = renderer;
    renderer.setStrokes(latest.current.strokes.map((item) => item.stroke));
    const liveContext = live.getContext("2d", { desynchronized: true }) ?? live.getContext("2d");
    let size: InkCanvasSize = { cssWidth: 0, cssHeight: 0, scale: 1, dpr: 1 };
    let toUnitsMatrix: InkMatrix = IDENTITY_INK_MATRIX;
    let frameRequest = 0;

    // ---- The gesture in progress -------------------------------------------
    let drawing: { samples: InkSample[]; predicted: InkSample[]; style: NonNullable<ReturnType<typeof activeInkStyle>>; width: number } | null = null;
    let erasing: { key: string; last: InkSample; radius: number } | null = null;
    let lasso: InkSample[] | null = null;
    /** Selected strokes being dragged: taken off the committed canvas and drawn live. */
    let moving: { start: InkSample; dx: number; dy: number; strokes: InkStroke[] } | null = null;
    let selection: Set<string> | null = null;

    /** CSS px on the surface to stroke units. */
    const toUnits = (sample: InkSample): InkSample => {
      const x = sample.x / size.scale;
      const y = sample.y / size.scale;
      const [a, b, c, d, e, f] = toUnitsMatrix;
      return { ...sample, x: a * x + c * y + e, y: b * x + d * y + f };
    };
    const unitsPerCss = () => 1 / Math.max(1e-6, size.scale);
    const selected = () => (selection ? renderer.strokes.filter((stroke) => selection!.has(stroke.id)) : []);

    const paintLive = () => {
      frameRequest = 0;
      if (!liveContext) return;
      liveContext.setTransform(1, 0, 0, 1, 0, 0);
      liveContext.clearRect(0, 0, live.width, live.height);
      applyInkTransform(liveContext, size);
      if (drawing) paintLiveStroke(liveContext, [...drawing.samples, ...drawing.predicted], { ...drawing.style, width: drawing.width });
      if (moving) {
        liveContext.save();
        liveContext.translate(moving.dx, moving.dy);
        for (const stroke of moving.strokes) paintStroke(liveContext, stroke);
        liveContext.restore();
      }
      const hairline = unitsPerCss();
      liveContext.globalAlpha = 1;
      liveContext.lineWidth = hairline * 1.25;
      liveContext.setLineDash([hairline * 5, hairline * 4]);
      liveContext.strokeStyle = "#2563eb";
      if (lasso && lasso.length > 1) {
        liveContext.beginPath();
        lasso.forEach((point, index) => (index ? liveContext.lineTo(point.x, point.y) : liveContext.moveTo(point.x, point.y)));
        liveContext.stroke();
      }
      const box = moving ? boundsOf(moving.strokes) : boundsOf(selected());
      if (box) {
        const pad = hairline * 4;
        liveContext.strokeRect(box.x - pad + (moving?.dx ?? 0), box.y - pad + (moving?.dy ?? 0), box.width + pad * 2, box.height + pad * 2);
      }
      liveContext.setLineDash([]);
    };
    const requestPaint = () => { frameRequest ||= requestAnimationFrame(paintLive); };

    const measure = () => {
      const cssWidth = root.clientWidth;
      const cssHeight = root.clientHeight;
      if (!cssWidth || !cssHeight) return;
      const view = latest.current.viewSize ?? latest.current.frame;
      const scale = cssWidth / view.width;
      const dpr = inkCanvasRatio(cssWidth, cssHeight, globalThis.devicePixelRatio || 1, latest.current.zoom, inkPower.onBattery);
      const matrixNow = latest.current.matrix ?? IDENTITY_INK_MATRIX;
      if (cssWidth === size.cssWidth && cssHeight === size.cssHeight && dpr === size.dpr && scale === size.scale && matrixNow === size.matrix) return;
      size = { cssWidth, cssHeight, scale, dpr, matrix: matrixNow };
      toUnitsMatrix = invert(matrixNow);
      renderer.resize(size);
      sizeCanvas(live, size);
      requestPaint();
    };
    measureRef.current = measure;
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(root);

    // Without IntersectionObserver (some test DOMs), surfaces simply keep their canvases.
    const visibility = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) renderer.restore();
      else renderer.release();
    }, { rootMargin: RELEASE_MARGIN });
    visibility?.observe(root);

    // ---- The lasso's selection ------------------------------------------------
    const owners = () => new Map(latest.current.strokes.map((item) => [item.stroke.id, item]));
    const ownerOf = (known: Map<string, MergedInkStroke>, stroke: InkStroke) => known.get(stroke.id) ?? { stroke, author: OWN_AUTHOR };

    function select(ids: string[]) {
      selection = ids.length ? new Set(ids) : null;
      inkSelection.set(owner, ids.length, actions);
      requestPaint();
    }
    /** Swaps the selected strokes for changed copies, as one change. */
    function replaceSelection(next: (stroke: InkStroke) => InkStroke) {
      const current = selected();
      if (!current.length) return;
      const known = owners();
      const replacements = current.map(next);
      const ids = new Set(current.map((stroke) => stroke.id));
      renderer.setStrokes(renderer.strokes.filter((stroke) => !ids.has(stroke.id)).concat(replacements));
      select(replacements.map((stroke) => stroke.id));
      latest.current.onChange({ add: replacements, removed: current.map((stroke) => ownerOf(known, stroke)) });
    }
    const actions = {
      remove() {
        const current = selected();
        if (!current.length) return;
        const known = owners();
        const ids = new Set(current.map((stroke) => stroke.id));
        renderer.setStrokes(renderer.strokes.filter((stroke) => !ids.has(stroke.id)));
        select([]);
        latest.current.onChange({ add: [], removed: current.map((stroke) => ownerOf(known, stroke)) });
      },
      recolor: (color: `#${string}`) => replaceSelection((stroke) => variant(stroke, { color })),
      restyle: (lineStyle: InkLineStyle) => replaceSelection((stroke) => variant(stroke, { lineStyle })),
      copy: () => inkSelection.copy(selected()),
      clear: () => select([]),
    };
    clearSelectionRef.current = () => { if (selection) select([]); };

    const paste = () => {
      const copied = inkSelection.clipboard();
      if (!copied.length) return;
      const offset = PASTE_OFFSET_PX * unitsPerCss();
      const pasted = copied.map((stroke) => variant(stroke, { dx: offset, dy: offset }));
      renderer.setStrokes([...renderer.strokes, ...pasted]);
      select(pasted.map((stroke) => stroke.id));
      latest.current.onChange({ add: pasted, removed: [] });
    };

    const onKey = (event: KeyboardEvent) => {
      if (inkSelection.get().owner !== owner) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Delete" || event.key === "Backspace") actions.remove();
      else if (event.key === "Escape") actions.clear();
      else if (mod && event.key.toLowerCase() === "c") actions.copy();
      else if (mod && event.key.toLowerCase() === "v") paste();
      else return;
      // Before the editor's own keys, which would delete the block holding this ink.
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);

    // ---- Erasing ------------------------------------------------------------
    const eraseAt = (from: InkSample, to: InkSample) => {
      if (!erasing) return;
      const { radius } = erasing;
      const partial = latest.current.tools.eraserMode === "partial";
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(0.5, radius / 2)));
      const known = owners();
      const change: InkChange = { add: [], removed: [], gesture: erasing.key };
      const gone = new Set<string>();

      for (let step = 0; step <= steps; step += 1) {
        const center = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
        // Stroke bounds in the index already include each stroke's reach.
        const area = { x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2 };
        for (const stroke of renderer.near(area).concat(change.add)) {
          if (gone.has(stroke.id)) continue;
          const reach = strokeReach(stroke.brush, stroke.width);
          const samples = strokeSamples(stroke);
          if (!hitTestSamples(samples, reach, center, radius)) continue;
          if (partial) {
            const pieces = splitSamplesByCircle(samples, center, radius + reach);
            if (pieces === null) continue;
            const replacements = pieces.map((piece) => ({ ...stroke, id: createInkId(), points: encodeInkSamples(piece), bounds: sampleBounds(piece) }));
            change.add = change.add.filter((item) => item.id !== stroke.id).concat(replacements);
          } else {
            change.add = change.add.filter((item) => item.id !== stroke.id);
          }
          gone.add(stroke.id);
          // A piece cut earlier in this drag may not have reached the props yet: it is this author's.
          if (renderer.has(stroke.id)) change.removed.push(ownerOf(known, stroke));
        }
      }

      if (!gone.size) return;
      change.add = change.add.filter((stroke) => !gone.has(stroke.id));
      renderer.setStrokes(renderer.strokes.filter((stroke) => !gone.has(stroke.id)).concat(change.add));
      latest.current.onChange(change);
    };

    const detach = attachInkInput(root, {
      enabled: () => latest.current.enabled,
      mouseDraws: () => latest.current.mouseDraws,
      fingerDraws: () => latest.current.tools.drawWithFinger,
      lowLatency: () => latest.current.tools.lowLatency,
      onPan: (dx, dy) => {
        const pan = latest.current.onPan;
        pan?.(dx, dy);
        return Boolean(pan);
      },
      tool: () => {
        const { tool } = latest.current.tools;
        return tool === "eraser" ? "erase" : tool === "select" ? "select" : "draw";
      },
      onStart(kind: InkGestureKind, sample) {
        inkSelection.setPasteTarget(owner, paste);
        const point = toUnits(sample);
        if (kind === "select") {
          const box = boundsOf(selected());
          if (box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
            const taken = selected();
            moving = { start: point, dx: 0, dy: 0, strokes: taken };
            const ids = new Set(taken.map((stroke) => stroke.id));
            renderer.setStrokes(renderer.strokes.filter((stroke) => !ids.has(stroke.id)));
          } else {
            select([]);
            lasso = [point];
          }
          requestPaint();
          return;
        }
        if (selection) select([]);
        const style = activeInkStyle(latest.current.tools) ?? latest.current.tools.styles[latest.current.tools.lastBrush];
        if (kind === "erase") {
          erasing = { key: `erase:${createInkId()}`, last: point, radius: widthInUnits(latest.current.tools.eraserRadius, size.scale) };
          eraseAt(point, point);
          return;
        }
        drawing = { samples: [point], predicted: [], style, width: widthInUnits(style.width, size.scale) };
        requestPaint();
      },
      onMove(samples, predicted) {
        const points = samples.map(toUnits);
        if (lasso) {
          lasso.push(...points);
          requestPaint();
          return;
        }
        if (moving) {
          const last = points.at(-1);
          if (last) {
            moving.dx = last.x - moving.start.x;
            moving.dy = last.y - moving.start.y;
            requestPaint();
          }
          return;
        }
        if (erasing) {
          for (const point of points) {
            eraseAt(erasing.last, point);
            erasing.last = point;
          }
          return;
        }
        if (!drawing) return;
        drawing.samples.push(...points);
        // The predicted tail costs a repaint a frame; on battery it is left out.
        drawing.predicted = inkPower.onBattery ? [] : predicted.map(toUnits);
        if (samples.length) latest.current.onReach?.(Math.max(...samples.map((item) => item.y / size.scale)));
        requestPaint();
      },
      onEnd(cancelled) {
        erasing = null;
        if (lasso) {
          const polygon = lasso;
          lasso = null;
          if (!cancelled && polygon.length > 2) {
            select(renderer.strokes.filter((stroke) => {
              const samples = strokeSamples(stroke);
              return samples.filter((item) => insidePolygon(item, polygon)).length >= samples.length / 2;
            }).map((stroke) => stroke.id));
          }
          requestPaint();
          return;
        }
        if (moving) {
          const { dx, dy, strokes: taken } = moving;
          moving = null;
          renderer.setStrokes([...renderer.strokes, ...taken]);
          // Under a CSS pixel is a click on the selection, not a move.
          if (!cancelled && Math.hypot(dx, dy) >= unitsPerCss()) replaceSelection((stroke) => variant(stroke, { dx, dy }));
          requestPaint();
          return;
        }
        const finished = drawing;
        drawing = null;
        requestPaint();
        if (!finished || cancelled) return;
        // Under a quarter of a device pixel at this zoom: invisible, and 40–70% fewer samples.
        const simplified = simplifySamples(finished.samples, 0.25 / Math.max(0.01, size.scale * size.dpr));
        const stroke: InkStroke = {
          id: createInkId(),
          brush: finished.style.brush,
          color: finished.style.color,
          opacity: finished.style.opacity,
          width: finished.width,
          lineStyle: finished.style.lineStyle,
          points: encodeInkSamples(simplified),
          bounds: sampleBounds(simplified),
          createdAt: new Date().toISOString(),
        };
        renderer.setStrokes([...renderer.strokes, stroke]);
        latest.current.onChange({ add: [stroke], removed: [] });
      },
      onHover(point) {
        const cursor = cursorRef.current;
        if (!cursor) return;
        const tools = latest.current.tools;
        if (!point || !latest.current.enabled || tools.tool === "select") {
          cursor.hidden = true;
          return;
        }
        const brush = activeInkStyle(tools);
        const diameter = brush ? Math.max(4, brush.width * 1.6 * latest.current.zoom) : tools.eraserRadius * 2;
        cursor.hidden = false;
        cursor.style.width = cursor.style.height = `${diameter}px`;
        cursor.style.transform = `translate(${point.x - diameter / 2}px, ${point.y - diameter / 2}px)`;
        cursor.style.borderColor = brush?.color ?? "currentColor";
      },
    });

    measure();

    return () => {
      cancelAnimationFrame(frameRequest);
      detach();
      window.removeEventListener("keydown", onKey, true);
      inkSelection.release(owner);
      resizeObserver.disconnect();
      visibility?.disconnect();
      measureRef.current = () => undefined;
      clearSelectionRef.current = () => undefined;
      rendererRef.current = null;
    };
  }, []);

  return (
    <div ref={rootRef} className={`libera-ink-surface ${className ?? ""}`} style={style} data-ink-tool={tools.tool} data-ink-eraser={tools.eraserMode} data-mouse-draws={(enabled && mouseDraws) || undefined}>
      <canvas ref={highlightRef} className="libera-ink-highlight" aria-hidden />
      <canvas ref={penRef} className="libera-ink-pen" aria-hidden />
      <canvas ref={liveRef} className="libera-ink-live" aria-hidden />
      <div ref={cursorRef} className="libera-ink-cursor" hidden aria-hidden />
    </div>
  );
}
