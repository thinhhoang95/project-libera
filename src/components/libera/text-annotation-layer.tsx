"use client";

import type { PointerEvent } from "react";
import { useRef, useState } from "react";
import type { PdfAnnotationRect, PdfTextAnnotation } from "@/lib/types";

export const DEFAULT_TEXT_ANNOTATION_FONT_SIZE = 8;
export const MIN_TEXT_ANNOTATION_FONT_SIZE = 4;
export const MAX_TEXT_ANNOTATION_FONT_SIZE = 72;

export type AnnotationSurfaceSize = {
  width: number;
  height: number;
};

type DraftTextBox = {
  startX: number;
  startY: number;
  rect: PdfAnnotationRect;
};

type TextAnnotationLayerProps = {
  annotations: PdfTextAnnotation[];
  drawing: boolean;
  interactive: boolean;
  pageSize: AnnotationSurfaceSize;
  selectedAnnotationId: string;
  textScale?: number;
  onAddAnnotation: (rect: PdfAnnotationRect) => void;
  onSelectAnnotation: (annotation: PdfTextAnnotation) => void;
  onUpdateAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function createAnnotationId() {
  return globalThis.crypto?.randomUUID?.() ?? `annotation-${Date.now()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeRect(rect: PdfAnnotationRect): PdfAnnotationRect {
  const x = clamp(rect.x, 0, 0.999);
  const y = clamp(rect.y, 0, 0.999);
  const width = clamp(rect.width, 0.001, 1 - x);
  const height = clamp(rect.height, 0.001, 1 - y);

  return {
    x,
    y,
    width,
    height,
  };
}

export function rectStyle(rect: PdfAnnotationRect, size: AnnotationSurfaceSize) {
  return {
    left: `${rect.x * size.width}px`,
    top: `${rect.y * size.height}px`,
    width: `${rect.width * size.width}px`,
    height: `${rect.height * size.height}px`,
  };
}

function rectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PdfAnnotationRect {
  return normalizeRect({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  });
}

function getPointerPosition(
  event: PointerEvent<HTMLElement>,
  bounds: DOMRect,
): { x: number; y: number } {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function defaultTextBoxRect(rect: PdfAnnotationRect) {
  return rect.width < 0.02 || rect.height < 0.01
    ? normalizeRect({
        x: rect.x,
        y: rect.y,
        width: 0.22,
        height: 0.055,
      })
    : rect;
}

export function TextAnnotationLayer({
  annotations,
  drawing,
  interactive,
  pageSize,
  selectedAnnotationId,
  textScale = 1,
  onAddAnnotation,
  onSelectAnnotation,
  onUpdateAnnotation,
}: TextAnnotationLayerProps) {
  const draftRef = useRef<DraftTextBox | null>(null);
  const [draftTextBox, setDraftTextBox] = useState<DraftTextBox | null>(null);

  function startTextBox(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || event.button !== 0) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const start = getPointerPosition(event, bounds);
    const draft = {
      startX: start.x,
      startY: start.y,
      rect: {
        x: start.x,
        y: start.y,
        width: 0.001,
        height: 0.001,
      },
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    draftRef.current = draft;
    setDraftTextBox(draft);
  }

  function updateTextBox(event: PointerEvent<HTMLDivElement>) {
    if (!draftRef.current) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const current = getPointerPosition(event, bounds);
    const nextDraft = {
      ...draftRef.current,
      rect: rectFromPoints(
        draftRef.current.startX,
        draftRef.current.startY,
        current.x,
        current.y,
      ),
    };

    draftRef.current = nextDraft;
    setDraftTextBox(nextDraft);
  }

  function finishTextBox(event: PointerEvent<HTMLDivElement>) {
    if (!draftRef.current) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const rect = defaultTextBoxRect(draftRef.current.rect);
    draftRef.current = null;
    setDraftTextBox(null);
    onAddAnnotation(rect);
  }

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20">
        {annotations.map((annotation) => (
          <textarea
            key={annotation.id}
            className={`absolute resize-none overflow-hidden border bg-white/80 p-1 leading-tight text-zinc-950 outline-none ${
              interactive ? "pointer-events-auto" : "pointer-events-none"
            } ${
              selectedAnnotationId === annotation.id
                ? "border-zinc-950 ring-2 ring-zinc-950/20"
                : "border-zinc-500/60"
            }`}
            value={annotation.text}
            aria-label="Text annotation"
            autoFocus={selectedAnnotationId === annotation.id}
            spellCheck={false}
            style={{
              ...rectStyle(annotation.rect, pageSize),
              fontSize: `${annotation.fontSize * textScale}px`,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelectAnnotation(annotation);
            }}
            onFocus={() => onSelectAnnotation(annotation)}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, {
                text: event.target.value,
              })
            }
          />
        ))}
      </div>

      <div
        className={`absolute inset-0 z-30 ${
          drawing ? "cursor-crosshair" : "pointer-events-none"
        }`}
        onPointerCancel={finishTextBox}
        onPointerDown={startTextBox}
        onPointerMove={updateTextBox}
        onPointerUp={finishTextBox}
      >
        {draftTextBox ? (
          <div
            className="absolute border border-zinc-950 bg-white/40"
            style={rectStyle(draftTextBox.rect, pageSize)}
          />
        ) : null}
      </div>
    </>
  );
}
