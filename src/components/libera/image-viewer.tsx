"use client";

import {
  MousePointer2,
  Move,
  RotateCcw,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { PointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import {
  DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  MAX_TEXT_ANNOTATION_FONT_SIZE,
  MIN_TEXT_ANNOTATION_FONT_SIZE,
  TextAnnotationLayer,
  clamp,
  createAnnotationId,
  nowIso,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";
import type { ImageAnnotationsPayload, PdfAnnotationRect, PdfTextAnnotation } from "@/lib/types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;
const SAVE_DEBOUNCE_MS = 350;

type ImageViewerProps = {
  alt: string;
  filePath: string;
  src?: string;
};

type ImageTool = "select" | "text";

type Point = {
  x: number;
  y: number;
};

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function ImageViewer({ alt, filePath, src }: ImageViewerProps) {
  const imageFrameRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestAnnotationsRef = useRef<PdfTextAnnotation[]>([]);
  const [annotations, setAnnotations] = useState<PdfTextAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState("");
  const [tool, setTool] = useState<ImageTool>("select");
  const [zoom, setZoom] = useState(1);
  const [fontSize, setFontSize] = useState(DEFAULT_TEXT_ANNOTATION_FONT_SIZE);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [imageSize, setImageSize] = useState<AnnotationSurfaceSize>({ width: 0, height: 0 });
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const lastPointerRef = useRef<Point | null>(null);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId),
    [annotations, selectedAnnotationId],
  );

  useEffect(() => {
    let active = true;

    queueMicrotask(() => {
      if (active) {
        setError("");
        setSelectedAnnotationId("");
      }
    });

    apiRequest<ImageAnnotationsPayload>(
      `/api/image-annotations?path=${encodeURIComponent(filePath)}`,
    )
      .then((payload) => {
        if (!active) {
          return;
        }

        latestAnnotationsRef.current = payload.annotations;
        setAnnotations(payload.annotations);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load image annotations.",
          );
        }
      });

    return () => {
      active = false;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [filePath]);

  useEffect(() => {
    const imageFrame = imageFrameRef.current;

    if (!imageFrame) {
      return;
    }

    function updateImageSize() {
      if (!imageFrame) {
        return;
      }

      setImageSize({
        width: imageFrame.offsetWidth,
        height: imageFrame.offsetHeight,
      });
    }

    updateImageSize();
    const observer = new ResizeObserver(updateImageSize);
    observer.observe(imageFrame);
    window.addEventListener("resize", updateImageSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateImageSize);
    };
  }, [src]);

  const saveAnnotations = useCallback(
    (nextAnnotations: PdfTextAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
      setSaveStatus("saving");

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        apiRequest<ImageAnnotationsPayload>("/api/image-annotations", {
          method: "PATCH",
          body: JSON.stringify({
            path: filePath,
            annotations: latestAnnotationsRef.current,
          }),
        })
          .then((payload) => {
            latestAnnotationsRef.current = payload.annotations;
            setAnnotations(payload.annotations);
            setSaveStatus("saved");
          })
          .catch((saveError) => {
            setSaveStatus("error");
            setError(
              saveError instanceof Error
                ? saveError.message
                : "Could not save image annotations.",
            );
          });
      }, SAVE_DEBOUNCE_MS);
    },
    [filePath],
  );

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    lastPointerRef.current = null;
  }

  function changeZoom(delta: number) {
    setZoom((currentZoom) => clampZoom(currentZoom + delta));
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (tool === "text" || event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    setIsPanning(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!lastPointerRef.current) {
      return;
    }

    const nextPoint = { x: event.clientX, y: event.clientY };
    const previousPoint = lastPointerRef.current;
    lastPointerRef.current = nextPoint;

    setPan((currentPan) => ({
      x: currentPan.x + nextPoint.x - previousPoint.x,
      y: currentPan.y + nextPoint.y - previousPoint.y,
    }));
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    lastPointerRef.current = null;
    setIsPanning(false);
  }

  function selectAnnotation(annotation: PdfTextAnnotation) {
    setSelectedAnnotationId(annotation.id);
    setFontSize(annotation.fontSize);
  }

  function addTextAnnotation(rect: PdfAnnotationRect) {
    const timestamp = nowIso();
    const annotation: PdfTextAnnotation = {
      id: createAnnotationId(),
      type: "text",
      pageNumber: 1,
      text: "",
      fontSize,
      rect,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    setSelectedAnnotationId(annotation.id);
    saveAnnotations([...annotations, annotation]);
  }

  function updateTextAnnotation(id: string, patch: Partial<PdfTextAnnotation>) {
    saveAnnotations(
      annotations.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              ...patch,
              updatedAt: nowIso(),
            }
          : annotation,
      ),
    );
  }

  function updateFontSize(value: number) {
    const nextFontSize = Math.round(
      clamp(value, MIN_TEXT_ANNOTATION_FONT_SIZE, MAX_TEXT_ANNOTATION_FONT_SIZE),
    );
    setFontSize(nextFontSize);

    if (selectedAnnotation) {
      updateTextAnnotation(selectedAnnotation.id, { fontSize: nextFontSize });
    }
  }

  const deleteSelectedAnnotation = useCallback(() => {
    if (!selectedAnnotationId) {
      return;
    }

    saveAnnotations(
      annotations.filter((annotation) => annotation.id !== selectedAnnotationId),
    );
    setSelectedAnnotationId("");
  }, [annotations, saveAnnotations, selectedAnnotationId]);

  useEffect(() => {
    function handleDeleteKey(event: KeyboardEvent) {
      if (
        !selectedAnnotationId ||
        (event.key !== "Delete" && event.key !== "Backspace")
      ) {
        return;
      }

      const activeElement = document.activeElement;

      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }

      event.preventDefault();
      deleteSelectedAnnotation();
    }

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [deleteSelectedAnnotation, selectedAnnotationId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-200">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <Move aria-hidden className="h-4 w-4 shrink-0" />
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium ${
              tool === "select"
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-300 hover:bg-zinc-50"
            }`}
            type="button"
            onClick={() => setTool("select")}
          >
            <MousePointer2 aria-hidden className="h-4 w-4" />
            Select
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium ${
              tool === "text"
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-300 hover:bg-zinc-50"
            }`}
            type="button"
            onClick={() => setTool("text")}
          >
            <Type aria-hidden className="h-4 w-4" />
            Text
          </button>
          <label className="ml-2 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-300 px-2 text-sm">
            Size
            <input
              className="w-14 border-0 bg-transparent text-sm outline-none"
              min={MIN_TEXT_ANNOTATION_FONT_SIZE}
              max={MAX_TEXT_ANNOTATION_FONT_SIZE}
              type="number"
              value={fontSize}
              onChange={(event) => updateFontSize(Number(event.target.value))}
            />
          </label>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label="Delete selected annotation"
            title="Delete selected annotation"
            disabled={!selectedAnnotationId}
            onClick={deleteSelectedAnnotation}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-2 text-xs text-zinc-500">
            {saveStatus === "saving"
              ? "Saving"
              : saveStatus === "saved"
                ? "Saved"
                : saveStatus === "error"
                  ? "Save failed"
                  : ""}
          </span>
          <button
            aria-label="Zoom out"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 text-sm font-medium hover:bg-zinc-50"
            type="button"
            onClick={() => changeZoom(-ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out"
          >
            <ZoomOut aria-hidden className="h-4 w-4" />
          </button>
          <span className="min-w-14 text-center text-sm font-medium text-zinc-700">
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 text-sm font-medium hover:bg-zinc-50"
            type="button"
            onClick={() => changeZoom(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in"
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label="Reset image view"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 text-sm font-medium hover:bg-zinc-50"
            type="button"
            onClick={resetView}
            title="Reset image view"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6 ${
          tool === "text" ? "cursor-crosshair" : isPanning ? "cursor-grabbing" : "cursor-grab"
        }`}
        onDoubleClick={resetView}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onWheel={handleWheel}
        style={{ touchAction: "none" }}
      >
        {src ? (
          <div
            ref={imageFrameRef}
            className="relative inline-block rounded-md bg-white shadow-sm"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: isPanning ? "none" : "transform 120ms ease-out",
              transformOrigin: "center",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
            <img
              className="block max-h-[calc(100vh-236px)] max-w-full select-none rounded-md object-contain"
              src={src}
              alt={alt}
              draggable={false}
            />
            <TextAnnotationLayer
              annotations={annotations}
              drawing={tool === "text"}
              interactive={tool === "select"}
              pageSize={imageSize}
              selectedAnnotationId={selectedAnnotationId}
              onAddAnnotation={addTextAnnotation}
              onExitTextEditing={() => setTool("select")}
              onSelectAnnotation={selectAnnotation}
              onUpdateAnnotation={updateTextAnnotation}
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Image preview is unavailable.</p>
        )}
      </div>
    </div>
  );
}
