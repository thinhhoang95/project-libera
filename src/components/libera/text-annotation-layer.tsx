"use client";

import { Move } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useRef, useState } from "react";
import type { PdfAnnotationRect, PdfTextAnnotation } from "@/lib/types";

export const DEFAULT_TEXT_ANNOTATION_FONT_SIZE = 8;
export const MIN_TEXT_ANNOTATION_FONT_SIZE = 4;
export const MAX_TEXT_ANNOTATION_FONT_SIZE = 72;
const MIN_TEXT_BOX_WIDTH = 0.03;
const MIN_TEXT_BOX_HEIGHT = 0.02;

export type AnnotationSurfaceSize = {
  width: number;
  height: number;
};

type DraftTextBox = {
  startX: number;
  startY: number;
  rect: PdfAnnotationRect;
};

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type ActiveTransform = {
  focusOnFinish?: HTMLTextAreaElement;
  handle?: ResizeHandle;
  id: string;
  mode: "move" | "resize";
  moved: boolean;
  startPointer: {
    x: number;
    y: number;
  };
  startRect: PdfAnnotationRect;
};

type TextAnnotationLayerProps = {
  annotations: PdfTextAnnotation[];
  drawing: boolean;
  interactive: boolean;
  pageSize: AnnotationSurfaceSize;
  selectedAnnotationId: string;
  textScale?: number;
  onAddAnnotation: (rect: PdfAnnotationRect) => void;
  onExitTextEditing: () => void;
  onSelectAnnotation: (annotation: PdfTextAnnotation) => void;
  onUpdateAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
};

const RESIZE_HANDLES: {
  className: string;
  handle: ResizeHandle;
  label: string;
}[] = [
  {
    handle: "nw",
    label: "Resize text annotation from top left",
    className: "left-0 top-0 cursor-nwse-resize",
  },
  {
    handle: "n",
    label: "Resize text annotation from top",
    className: "left-1/2 top-0 -translate-x-1/2 cursor-ns-resize",
  },
  {
    handle: "ne",
    label: "Resize text annotation from top right",
    className: "right-0 top-0 cursor-nesw-resize",
  },
  {
    handle: "e",
    label: "Resize text annotation from right",
    className: "right-0 top-1/2 -translate-y-1/2 cursor-ew-resize",
  },
  {
    handle: "se",
    label: "Resize text annotation from bottom right",
    className: "bottom-0 right-0 cursor-nwse-resize",
  },
  {
    handle: "s",
    label: "Resize text annotation from bottom",
    className: "bottom-0 left-1/2 -translate-x-1/2 cursor-ns-resize",
  },
  {
    handle: "sw",
    label: "Resize text annotation from bottom left",
    className: "bottom-0 left-0 cursor-nesw-resize",
  },
  {
    handle: "w",
    label: "Resize text annotation from left",
    className: "left-0 top-1/2 -translate-y-1/2 cursor-ew-resize",
  },
];

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

function moveRect(
  rect: PdfAnnotationRect,
  deltaX: number,
  deltaY: number,
): PdfAnnotationRect {
  return {
    x: clamp(rect.x + deltaX, 0, 1 - rect.width),
    y: clamp(rect.y + deltaY, 0, 1 - rect.height),
    width: rect.width,
    height: rect.height,
  };
}

function resizeRect(
  rect: PdfAnnotationRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
): PdfAnnotationRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) {
    left = clamp(rect.x + deltaX, 0, right - MIN_TEXT_BOX_WIDTH);
  }

  if (handle.includes("e")) {
    right = clamp(rect.x + rect.width + deltaX, left + MIN_TEXT_BOX_WIDTH, 1);
  }

  if (handle.includes("n")) {
    top = clamp(rect.y + deltaY, 0, bottom - MIN_TEXT_BOX_HEIGHT);
  }

  if (handle.includes("s")) {
    bottom = clamp(rect.y + rect.height + deltaY, top + MIN_TEXT_BOX_HEIGHT, 1);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function TextAnnotationLayer({
  annotations,
  drawing,
  interactive,
  pageSize,
  selectedAnnotationId,
  textScale = 1,
  onAddAnnotation,
  onExitTextEditing,
  onSelectAnnotation,
  onUpdateAnnotation,
}: TextAnnotationLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<DraftTextBox | null>(null);
  const activeTransformRef = useRef<ActiveTransform | null>(null);
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

  function startAnnotationTransform(
    event: PointerEvent<HTMLElement>,
    annotation: PdfTextAnnotation,
    mode: ActiveTransform["mode"],
    options: {
      focusOnFinish?: HTMLTextAreaElement;
      handle?: ResizeHandle;
    } = {},
  ) {
    if (!interactive || !layerRef.current) {
      return;
    }

    const pointer = getPointerPosition(
      event,
      layerRef.current.getBoundingClientRect(),
    );

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectAnnotation(annotation);

    activeTransformRef.current = {
      focusOnFinish: options.focusOnFinish,
      handle: options.handle,
      id: annotation.id,
      mode,
      moved: false,
      startPointer: pointer,
      startRect: annotation.rect,
    };
  }

  function updateAnnotationTransform(event: PointerEvent<HTMLElement>) {
    const transform = activeTransformRef.current;

    if (!transform || !layerRef.current) {
      return;
    }

    const pointer = getPointerPosition(
      event,
      layerRef.current.getBoundingClientRect(),
    );
    const deltaX = pointer.x - transform.startPointer.x;
    const deltaY = pointer.y - transform.startPointer.y;
    const moved = Math.abs(deltaX) > 0.001 || Math.abs(deltaY) > 0.001;
    const rect =
      transform.mode === "move"
        ? moveRect(transform.startRect, deltaX, deltaY)
        : resizeRect(transform.startRect, transform.handle ?? "se", deltaX, deltaY);

    activeTransformRef.current = {
      ...transform,
      moved: transform.moved || moved,
    };
    onUpdateAnnotation(transform.id, { rect });
  }

  function finishAnnotationTransform(event: PointerEvent<HTMLElement>) {
    const transform = activeTransformRef.current;

    if (!transform) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    activeTransformRef.current = null;

    if (!transform.moved && transform.focusOnFinish) {
      transform.focusOnFinish.focus();
    }
  }

  function handleTextAreaPointerDown(
    event: PointerEvent<HTMLTextAreaElement>,
    annotation: PdfTextAnnotation,
  ) {
    event.stopPropagation();

    if (
      selectedAnnotationId !== annotation.id ||
      document.activeElement === event.currentTarget
    ) {
      return;
    }

    startAnnotationTransform(event, annotation, "move", {
      focusOnFinish: event.currentTarget,
    });
  }

  function handleTextAreaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    onExitTextEditing();
  }

  return (
    <>
      <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20">
        {annotations.map((annotation) => {
          const selected = selectedAnnotationId === annotation.id;

          return (
            <div
              key={annotation.id}
              data-pdf-annotation-id={annotation.id}
              className={`absolute ${
                interactive ? "pointer-events-auto" : "pointer-events-none"
              }`}
              style={rectStyle(annotation.rect, pageSize)}
            >
              <textarea
                className={`h-full w-full resize-none overflow-hidden border bg-white/80 p-1 leading-tight text-foreground outline-none ${
                  selected
                    ? "border-foreground ring-2 ring-foreground/20"
                    : "border-input/60"
                }`}
                value={annotation.text}
                aria-label="Text annotation"
                autoFocus={selected}
                spellCheck={false}
                style={{
                  fontSize: `${annotation.fontSize * textScale}px`,
                }}
                onPointerDown={(event) => handleTextAreaPointerDown(event, annotation)}
                onPointerMove={updateAnnotationTransform}
                onPointerUp={finishAnnotationTransform}
                onPointerCancel={finishAnnotationTransform}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectAnnotation(annotation);
                }}
                onFocus={() => onSelectAnnotation(annotation)}
                onKeyDown={handleTextAreaKeyDown}
                onChange={(event) =>
                  onUpdateAnnotation(annotation.id, {
                    text: event.target.value,
                  })
                }
              />

              {selected && interactive ? (
                <>
                  <button
                    aria-label="Move text annotation"
                    className="absolute right-1 top-1 z-20 inline-flex h-5 w-5 items-center justify-center rounded border border-input bg-white/90 text-foreground shadow-sm hover:bg-muted"
                    type="button"
                    title="Move text annotation"
                    onPointerDown={(event) =>
                      startAnnotationTransform(event, annotation, "move")
                    }
                    onPointerMove={updateAnnotationTransform}
                    onPointerUp={finishAnnotationTransform}
                    onPointerCancel={finishAnnotationTransform}
                  >
                    <Move aria-hidden className="h-3.5 w-3.5" />
                  </button>
                  {RESIZE_HANDLES.map((handle) => (
                    <button
                      key={handle.handle}
                      aria-label={handle.label}
                      className={`absolute z-20 h-3 w-3 rounded-full border border-foreground bg-card shadow-sm ${handle.className}`}
                      type="button"
                      title={handle.label}
                      onPointerDown={(event) =>
                        startAnnotationTransform(event, annotation, "resize", {
                          handle: handle.handle,
                        })
                      }
                      onPointerMove={updateAnnotationTransform}
                      onPointerUp={finishAnnotationTransform}
                      onPointerCancel={finishAnnotationTransform}
                    />
                  ))}
                </>
              ) : null}
            </div>
          );
        })}
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
            className="absolute border border-foreground bg-white/40"
            style={rectStyle(draftTextBox.rect, pageSize)}
          />
        ) : null}
      </div>
    </>
  );
}
