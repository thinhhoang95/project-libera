"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { encodeInkSamples, sampleBounds, strokeSamples } from "@/lib/ink/codec";
import { hitTestSamples, simplifySamples, splitSamplesByCircle, strokeReach } from "@/lib/ink/geometry";
import { widthInUnits } from "@/lib/ink/tools";
import { createInkId, type InkFrame, type InkSample, type InkStroke, type MergedInkStroke } from "@/lib/ink/types";
import { attachInkInput, type InkGestureKind } from "./ink-input";
import { InkRenderer, inkCanvasRatio, paintLiveStroke, sizeCanvas } from "./ink-renderer";
import { activeInkStyle, type InkToolsState } from "./use-ink-tools";

/*
 * One ink surface: committed strokes (ink-renderer), the stroke being drawn
 * on a desynchronized live canvas, and pointer input (ink-input). React
 * renders it once; strokes and tools are read through refs, so a pen sample
 * never re-renders anything (docs/ink-plan.md, "Rendering engine").
 */

export type InkChange = {
  add: InkStroke[];
  /** Strokes erased (or cut by the partial eraser), with whose file held them. */
  removed: MergedInkStroke[];
  /** One eraser drag shares a key, for one undo step. */
  gesture?: string;
};

type Props = {
  frame: InkFrame;
  strokes: readonly MergedInkStroke[];
  tools: InkToolsState;
  /** Whether a mouse draws here now (a pen always does). */
  mouseDraws: boolean;
  onChange: (change: InkChange) => void;
  /** The lowest point (in units) a pen has reached in the current stroke. */
  onReach?: (y: number) => void;
  className?: string;
  style?: CSSProperties;
};

/** The author of strokes this surface made itself, before the host has them (use-ink-document maps it). */
export const OWN_AUTHOR = "";

/** Surfaces this far outside the viewport give up their canvases. */
const RELEASE_MARGIN = "1500px 0px";

export function InkSurface({ frame, strokes, tools, mouseDraws, onChange, onReach, className, style }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const penRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<InkRenderer | null>(null);
  const scaleRef = useRef(1);
  const latest = useRef({ strokes, tools, mouseDraws, onChange, onReach, frame });
  useLayoutEffect(() => { latest.current = { strokes, tools, mouseDraws, onChange, onReach, frame }; });

  // Committed strokes follow the props.
  useLayoutEffect(() => {
    rendererRef.current?.setStrokes(strokes.map((item) => item.stroke));
  }, [strokes]);

  // Size, visibility and input, set up once per surface.
  useEffect(() => {
    const root = rootRef.current;
    const highlight = highlightRef.current;
    const pen = penRef.current;
    const live = liveRef.current;
    if (!root || !highlight || !pen || !live) return;
    const renderer = new InkRenderer({ highlight, pen }, latest.current.frame);
    rendererRef.current = renderer;
    renderer.setStrokes(latest.current.strokes.map((item) => item.stroke));
    const liveContext = live.getContext("2d", { desynchronized: true }) ?? live.getContext("2d");
    let size = { cssWidth: 0, cssHeight: 0, scale: 1, dpr: 1 };

    const measure = () => {
      const cssWidth = root.clientWidth;
      const cssHeight = root.clientHeight;
      if (!cssWidth || !cssHeight) return;
      const scale = cssWidth / latest.current.frame.width;
      const dpr = inkCanvasRatio(cssWidth, cssHeight);
      if (cssWidth === size.cssWidth && cssHeight === size.cssHeight && dpr === size.dpr) return;
      size = { cssWidth, cssHeight, scale, dpr };
      scaleRef.current = scale;
      renderer.resize(size);
      sizeCanvas(live, size);
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(root);
    measure();

    const visibility = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) renderer.restore();
      else renderer.release();
    }, { rootMargin: RELEASE_MARGIN });
    visibility.observe(root);

    // ---- The gesture in progress -------------------------------------------
    let drawing: { samples: InkSample[]; predicted: InkSample[]; style: NonNullable<ReturnType<typeof activeInkStyle>>; width: number } | null = null;
    let erasing: { key: string; last: InkSample; radius: number } | null = null;
    let frameRequest = 0;

    const toUnits = (sample: InkSample): InkSample => ({ ...sample, x: sample.x / scaleRef.current, y: sample.y / scaleRef.current });

    const paintLive = () => {
      frameRequest = 0;
      if (!liveContext) return;
      liveContext.setTransform(1, 0, 0, 1, 0, 0);
      liveContext.clearRect(0, 0, live.width, live.height);
      if (!drawing) return;
      const ratio = size.dpr * size.scale;
      liveContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintLiveStroke(liveContext, [...drawing.samples, ...drawing.predicted], { ...drawing.style, width: drawing.width });
    };
    const requestPaint = () => { frameRequest ||= requestAnimationFrame(paintLive); };

    const eraseAt = (from: InkSample, to: InkSample) => {
      if (!erasing) return;
      const { radius } = erasing;
      const partial = latest.current.tools.eraserMode === "partial";
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(0.5, radius / 2)));
      const merged = new Map(latest.current.strokes.map((item) => [item.stroke.id, item]));
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
          change.removed.push(merged.get(stroke.id) ?? { stroke, author: OWN_AUTHOR });
        }
      }

      if (!gone.size) return;
      change.add = change.add.filter((stroke) => !gone.has(stroke.id));
      renderer.setStrokes(renderer.strokes.filter((stroke) => !gone.has(stroke.id)).concat(change.add));
      latest.current.onChange(change);
    };

    const detach = attachInkInput(root, {
      mouseDraws: () => latest.current.mouseDraws,
      fingerDraws: () => latest.current.tools.drawWithFinger,
      tool: () => (latest.current.tools.tool === "eraser" ? "erase" : "draw"),
      onStart(kind: InkGestureKind, sample) {
        const point = toUnits(sample);
        const style = activeInkStyle(latest.current.tools) ?? latest.current.tools.styles[latest.current.tools.lastBrush];
        if (kind === "erase") {
          erasing = { key: `erase:${createInkId()}`, last: point, radius: widthInUnits(latest.current.tools.eraserRadius, scaleRef.current) };
          eraseAt(point, point);
          return;
        }
        drawing = { samples: [point], predicted: [], style, width: widthInUnits(style.width, scaleRef.current) };
        requestPaint();
      },
      onMove(samples, predicted) {
        const points = samples.map(toUnits);
        if (erasing) {
          for (const point of points) {
            eraseAt(erasing.last, point);
            erasing.last = point;
          }
          return;
        }
        if (!drawing) return;
        drawing.samples.push(...points);
        drawing.predicted = predicted.map(toUnits);
        const lowest = Math.max(...points.map((point) => point.y));
        latest.current.onReach?.(lowest);
        requestPaint();
      },
      onEnd(cancelled) {
        erasing = null;
        const finished = drawing;
        drawing = null;
        requestPaint();
        if (!finished || cancelled) return;
        // Under a quarter of a device pixel at this zoom: invisible, and 40–70% fewer samples.
        const samples = simplifySamples(finished.samples, 0.25 / Math.max(0.01, size.scale * size.dpr));
        const stroke: InkStroke = {
          id: createInkId(),
          brush: finished.style.brush,
          color: finished.style.color,
          opacity: finished.style.opacity,
          width: finished.width,
          lineStyle: finished.style.lineStyle,
          points: encodeInkSamples(samples),
          bounds: sampleBounds(samples),
          createdAt: new Date().toISOString(),
        };
        renderer.setStrokes([...renderer.strokes, stroke]);
        latest.current.onChange({ add: [stroke], removed: [] });
      },
      onHover(point) {
        const cursor = cursorRef.current;
        if (!cursor) return;
        if (!point) {
          cursor.hidden = true;
          return;
        }
        const tools = latest.current.tools;
        const style = activeInkStyle(tools);
        const diameter = style ? Math.max(4, style.width * 1.6) : tools.eraserRadius * 2;
        cursor.hidden = false;
        cursor.style.width = cursor.style.height = `${diameter}px`;
        cursor.style.transform = `translate(${point.x - diameter / 2}px, ${point.y - diameter / 2}px)`;
        cursor.style.borderColor = style?.color ?? "currentColor";
      },
    });

    return () => {
      cancelAnimationFrame(frameRequest);
      detach();
      resizeObserver.disconnect();
      visibility.disconnect();
      rendererRef.current = null;
    };
  }, []);

  return (
    <div ref={rootRef} className={`libera-ink-surface ${className ?? ""}`} style={style} data-ink-tool={tools.tool} data-ink-eraser={tools.eraserMode} data-mouse-draws={mouseDraws || undefined}>
      <canvas ref={highlightRef} className="libera-ink-highlight" aria-hidden />
      <canvas ref={penRef} className="libera-ink-pen" aria-hidden />
      <canvas ref={liveRef} className="libera-ink-live" aria-hidden />
      <div ref={cursorRef} className="libera-ink-cursor" hidden aria-hidden />
    </div>
  );
}
