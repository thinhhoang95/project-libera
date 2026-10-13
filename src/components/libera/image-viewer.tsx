"use client";

import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Info,
  Maximize,
  Minimize,
  MousePointer2,
  Move,
  Pause,
  Pencil,
  Play,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { MouseEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiRequest } from "@/components/libera/api-client";
import { PhotoEditor } from "@/components/libera/photo-editor";
import { copyImage, formatBytes } from "@/components/libera/photo-viewer";
import { imageElementRectToPngFile } from "@/components/libera/screenshot-capture";
import { ScreenshotSnipLayer } from "@/components/libera/screenshot-snip-layer";
import {
  ANNOTATION_UI_SELECTOR,
  DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  MAX_TEXT_ANNOTATION_FONT_SIZE,
  MIN_TEXT_ANNOTATION_FONT_SIZE,
  TextAnnotationLayer,
  clamp,
  createAnnotationId,
  keepEditorFocus,
  nowIso,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";
import { TextAnnotationStyleControls } from "@/components/libera/annotation-style-controls";
import type { ImageTabViewState } from "@/components/libera/types";
import { useCanvasPaneFocused } from "@/components/libera/canvas-pane-context";
import { broadcastSavedAnnotations, useAnnotationSync } from "@/components/libera/annotation-sync";
import { panCenteringRect, rememberFileAnnotations } from "@/lib/annotation-links";
import {
  DEFAULT_PDF_TEXT_COLOR,
  DEFAULT_PDF_TEXT_FONT,
  isHexColor,
} from "@/lib/pdf-annotation-style";
import type { PhotoEdits } from "@/lib/photo-edits";
import type {
  ImageAnnotationsPayload,
  PdfAnnotationRect,
  PdfTextAnnotation,
  PdfTextAnnotationFont,
} from "@/lib/types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_FACTOR = 1.5;
const DOUBLE_CLICK_ZOOM = 2.5;
const SAVE_DEBOUNCE_MS = 350;
const SLIDESHOW_MS = 4000;
const INFO_STORAGE_KEY = "libera.imageViewer.infoOpen";
const iconButton = "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

type ImageViewerProps = {
  alt: string;
  /** False shows the image read-only, without loading or saving text annotations. */
  annotatable?: boolean;
  /** File facts shown in the Info panel. */
  details?: { createdAt?: string; location?: string; size?: number; updatedAt?: string };
  filePath: string;
  initialViewState?: ImageTabViewState;
  screenshotSnipping?: boolean;
  /** The images in this one's folder, in order, this one included. */
  siblings?: Array<{ path: string; src: string }>;
  src?: string;
  onCancelScreenshotSnip?: () => void;
  onCompleteScreenshotSnip?: (file: File) => Promise<void>;
  /** Offers the photo editor; edits are saved as a new file beside this one. */
  onSaveEditedCopy?: (edits: PhotoEdits) => Promise<void>;
  /** Shows a sibling in place of this image. The viewer remounts for it. */
  onShowSibling?: (path: string) => void;
  onViewStateChange?: (viewState: ImageTabViewState) => void;
};

// Stepping to a sibling remounts the viewer for the next file. The slideshow
// and full screen carry over to it, so a slideshow keeps going.
let handoff: { filePath: string; playing: boolean; fullscreen: boolean; at: number } | null = null;

function carriedOver(filePath: string) {
  return handoff?.filePath === filePath && Date.now() - handoff.at < 5000 ? handoff : null;
}

function readInfoOpen() {
  try {
    return window.localStorage.getItem(INFO_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function formatDate(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";
}

type ImageTool = "select" | "text";

type Point = {
  x: number;
  y: number;
};

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function ImageViewer({
  alt,
  annotatable = true,
  details,
  filePath,
  initialViewState,
  screenshotSnipping = false,
  siblings,
  src,
  onCancelScreenshotSnip,
  onCompleteScreenshotSnip,
  onSaveEditedCopy,
  onShowSibling,
  onViewStateChange,
}: ImageViewerProps) {
  const paneFocused = useCanvasPaneFocused();
  const stageRef = useRef<HTMLDivElement>(null);
  const imageFrameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestAnnotationsRef = useRef<PdfTextAnnotation[]>([]);
  const [annotations, setAnnotations] = useState<PdfTextAnnotation[]>([]);
  // The file whose annotations have finished loading (successfully or not).
  const [annotationsLoadedPath, setAnnotationsLoadedPath] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(
    initialViewState?.selectedAnnotationId ?? "",
  );
  const [tool, setTool] = useState<ImageTool>(annotatable ? initialViewState?.tool ?? "select" : "select");
  const [zoom, setZoom] = useState(initialViewState?.zoom ?? 1);
  const [fontSize, setFontSize] = useState(
    initialViewState?.fontSize ?? DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  );
  const [fontFamily, setFontFamily] = useState<PdfTextAnnotationFont>(
    initialViewState?.fontFamily ?? DEFAULT_PDF_TEXT_FONT,
  );
  const [textColor, setTextColor] = useState(
    isHexColor(initialViewState?.textColor) ? initialViewState.textColor : DEFAULT_PDF_TEXT_COLOR,
  );
  const [pan, setPan] = useState<Point>({
    x: initialViewState?.panX ?? 0,
    y: initialViewState?.panY ?? 0,
  });
  // Pointer/wheel events can arrive in a batch before React renders again.
  const transformRef = useRef({ zoom, pan });
  const [isPanning, setIsPanning] = useState(false);
  const [imageSize, setImageSize] = useState<AnnotationSurfaceSize>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [infoOpen, setInfoOpen] = useState(false);
  const [playing, setPlaying] = useState(() => carriedOver(filePath)?.playing ?? false);
  const [fullscreen, setFullscreen] = useState(() => carriedOver(filePath)?.fullscreen ?? false);
  const fullscreenRef = useRef(fullscreen);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const lastPointerRef = useRef<Point | null>(null);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId),
    [annotations, selectedAnnotationId],
  );

  const updateViewState = useCallback((patch: ImageTabViewState) => {
    onViewStateChange?.(patch);
  }, [onViewStateChange]);

  useEffect(() => {
    if (!annotatable) {
      return;
    }

    let active = true;

    queueMicrotask(() => {
      if (active) {
        setError("");
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
        setAnnotationsLoadedPath(filePath);
      })
      .catch((loadError) => {
        if (active) {
          setAnnotationsLoadedPath(filePath);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load image annotations.",
          );
        }
      });

    return () => {
      active = false;

      // Leaving the image (another tab, or the next photo) still saves the
      // last edit instead of dropping it with the debounce.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        const pending = latestAnnotationsRef.current;
        apiRequest<ImageAnnotationsPayload>("/api/image-annotations", {
          method: "PATCH",
          body: JSON.stringify({ path: filePath, annotations: pending }),
        })
          .then((payload) => broadcastSavedAnnotations("image", filePath, payload.annotations))
          .catch(() => undefined);
      }
    };
  }, [annotatable, filePath]);

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
    // Full screen moves the viewer into a portal, with a new frame element.
  }, [src, fullscreen]);

  // Another window showing this image saved annotations: adopt them unless this
  // window has its own edit in flight, which will be saved over them anyway.
  const localSavePendingRef = useRef(false);
  useAnnotationSync<PdfTextAnnotation>("image", filePath, (remoteAnnotations) => {
    if (!annotatable || localSavePendingRef.current) {
      return;
    }

    latestAnnotationsRef.current = remoteAnnotations;
    setAnnotations(remoteAnnotations);
  });

  const saveAnnotations = useCallback(
    (nextAnnotations: PdfTextAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
      setSaveStatus("saving");
      localSavePendingRef.current = true;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        apiRequest<ImageAnnotationsPayload>("/api/image-annotations", {
          method: "PATCH",
          body: JSON.stringify({
            path: filePath,
            annotations: latestAnnotationsRef.current,
          }),
        })
          .then((payload) => {
            localSavePendingRef.current = false;
            latestAnnotationsRef.current = payload.annotations;
            setAnnotations(payload.annotations);
            setSaveStatus("saved");
            broadcastSavedAnnotations("image", filePath, payload.annotations);
          })
          .catch((saveError) => {
            localSavePendingRef.current = false;
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
    transformRef.current = { zoom: 1, pan: { x: 0, y: 0 } };
    setZoom(1);
    setPan({ x: 0, y: 0 });
    lastPointerRef.current = null;
    updateViewState({ panX: 0, panY: 0, zoom: 1 });
  }

  /** Zooms keeping the point under the cursor (or the middle of the view) still. */
  const zoomTo = useCallback((value: number, clientX?: number, clientY?: number) => {
    const current = transformRef.current;
    const nextZoom = clampZoom(value);
    const factor = nextZoom / current.zoom;
    const stage = stageRef.current?.getBoundingClientRect();
    const pointX = stage && clientX !== undefined ? clientX - (stage.left + stage.width / 2) : 0;
    const pointY = stage && clientY !== undefined ? clientY - (stage.top + stage.height / 2) : 0;
    const nextPan = {
      x: pointX - (pointX - current.pan.x) * factor,
      y: pointY - (pointY - current.pan.y) * factor,
    };
    transformRef.current = { zoom: nextZoom, pan: nextPan };
    setZoom(nextZoom);
    setPan(nextPan);
    updateViewState({ panX: nextPan.x, panY: nextPan.y, zoom: nextZoom });
  }, [updateViewState]);

  function zoomBy(factor: number) {
    zoomTo(transformRef.current.zoom * factor);
  }

  useEffect(() => {
    if (annotatable) rememberFileAnnotations(filePath, annotations);
  }, [annotatable, annotations, filePath]);

  // Following a link: select its note once and, when zoomed in, center it.
  const revealSelectedAnnotation = initialViewState?.revealSelectedAnnotation;
  const revealAnnotationId = initialViewState?.selectedAnnotationId ?? "";
  const annotationsLoaded = !annotatable || annotationsLoadedPath === filePath;
  useEffect(() => {
    if (!revealSelectedAnnotation || !annotationsLoaded) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const annotation = latestAnnotationsRef.current.find((current) => current.id === revealAnnotationId);
      if (!annotation) {
        updateViewState({ revealSelectedAnnotation: undefined });
        return;
      }
      const current = transformRef.current;
      const nextPan = current.zoom > 1 && imageSize.width
        ? panCenteringRect(annotation.rect, imageSize, current.zoom)
        : current.pan;
      transformRef.current = { zoom: current.zoom, pan: nextPan };
      setPan(nextPan);
      setSelectedAnnotationId(annotation.id);
      updateViewState({
        panX: nextPan.x,
        panY: nextPan.y,
        revealSelectedAnnotation: undefined,
        selectedAnnotationId: annotation.id,
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [annotationsLoaded, imageSize, revealAnnotationId, revealSelectedAnnotation, updateViewState]);

  // At zoom 1 the image fits the view; this is its share of the real pixels.
  const fitScale = naturalSize.width && imageSize.width ? imageSize.width / naturalSize.width : 1;
  const atFit = zoom === 1 && pan.x === 0 && pan.y === 0;

  function toggleActualSize() {
    if (atFit) {
      zoomTo(1 / fitScale);
    } else {
      resetView();
    }
  }

  // A native listener: React's wheel listeners are passive and cannot stop the
  // page from zooming on a pinch.
  useEffect(() => {
    const stage = stageRef.current;

    if (!stage || screenshotSnipping) {
      return;
    }

    function handleWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      // Pinch gestures arrive as ctrl+wheel with small deltas.
      const intensity = event.ctrlKey ? 0.01 : 0.0025;
      zoomTo(transformRef.current.zoom * Math.exp(-event.deltaY * intensity), event.clientX, event.clientY);
    }

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [fullscreen, screenshotSnipping, zoomTo]);

  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (screenshotSnipping || tool === "text" || (event.target as HTMLElement).closest(ANNOTATION_UI_SELECTOR)) {
      return;
    }

    if (zoom > 1) {
      resetView();
    } else {
      zoomTo(DOUBLE_CLICK_ZOOM, event.clientX, event.clientY);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (screenshotSnipping) {
      return;
    }

    if (event.button !== 0 || (event.target as HTMLElement).closest(ANNOTATION_UI_SELECTOR)) {
      return;
    }

    // Pressing on the image (not a note) lets go of the current note.
    if (selectedAnnotationId) {
      setSelectedAnnotationId("");
      updateViewState({ selectedAnnotationId: "" });
    }

    if (tool === "text") {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    setIsPanning(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (screenshotSnipping) {
      return;
    }

    if (!lastPointerRef.current) {
      return;
    }

    const nextPoint = { x: event.clientX, y: event.clientY };
    const previousPoint = lastPointerRef.current;
    lastPointerRef.current = nextPoint;

    const nextPan = {
      x: transformRef.current.pan.x + nextPoint.x - previousPoint.x,
      y: transformRef.current.pan.y + nextPoint.y - previousPoint.y,
    };
    transformRef.current.pan = nextPan;
    setPan(nextPan);
    updateViewState({ panX: nextPan.x, panY: nextPan.y });
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
    updateViewState({
      fontSize: annotation.fontSize,
      selectedAnnotationId: annotation.id,
    });
  }

  function addTextAnnotation(rect: PdfAnnotationRect) {
    const timestamp = nowIso();
    const annotation: PdfTextAnnotation = {
      id: createAnnotationId(),
      type: "text",
      pageNumber: 1,
      text: "",
      fontSize,
      color: textColor,
      fontFamily,
      rect,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    setSelectedAnnotationId(annotation.id);
    updateViewState({ selectedAnnotationId: annotation.id });
    saveAnnotations([...latestAnnotationsRef.current, annotation]);
    return annotation.id;
  }

  // Reads the latest list: the note layer can report several changes before
  // this component re-renders (e.g. a final edit, then deleting an empty note).
  const updateTextAnnotation = useCallback((id: string, patch: Partial<PdfTextAnnotation>) => {
    saveAnnotations(
      latestAnnotationsRef.current.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              ...patch,
              updatedAt: nowIso(),
            }
          : annotation,
      ),
    );
  }, [saveAnnotations]);

  const deleteAnnotation = useCallback((id: string) => {
    saveAnnotations(latestAnnotationsRef.current.filter((annotation) => annotation.id !== id));

    if (selectedAnnotationId === id) {
      setSelectedAnnotationId("");
      updateViewState({ selectedAnnotationId: "" });
    }
  }, [saveAnnotations, selectedAnnotationId, updateViewState]);

  function updateFontSize(value: number) {
    const nextFontSize = Math.round(
      clamp(value, MIN_TEXT_ANNOTATION_FONT_SIZE, MAX_TEXT_ANNOTATION_FONT_SIZE),
    );
    setFontSize(nextFontSize);
    updateViewState({ fontSize: nextFontSize });

    if (selectedAnnotation) {
      updateTextAnnotation(selectedAnnotation.id, { fontSize: nextFontSize });
    }
  }

  function updateFontFamily(nextFont: PdfTextAnnotationFont) {
    setFontFamily(nextFont);
    updateViewState({ fontFamily: nextFont });

    if (selectedAnnotation) {
      updateTextAnnotation(selectedAnnotation.id, { fontFamily: nextFont });
    }
  }

  function updateTextColor(nextColor: string) {
    setTextColor(nextColor);
    updateViewState({ textColor: nextColor });

    if (selectedAnnotation) {
      updateTextAnnotation(selectedAnnotation.id, { color: nextColor });
    }
  }

  const deleteSelectedAnnotation = useCallback(() => {
    if (selectedAnnotationId) {
      deleteAnnotation(selectedAnnotationId);
    }
  }, [deleteAnnotation, selectedAnnotationId]);

  useEffect(() => {
    function handleDeleteKey(event: KeyboardEvent) {
      const activeElement = document.activeElement;

      if (
        !selectedAnnotationId ||
        !paneFocused ||
        event.defaultPrevented ||
        (activeElement instanceof HTMLElement &&
          (activeElement.isContentEditable || activeElement.matches("input, textarea, select")))
      ) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedAnnotationId("");
        updateViewState({ selectedAnnotationId: "" });
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      event.preventDefault();
      deleteSelectedAnnotation();
    }

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [deleteSelectedAnnotation, paneFocused, selectedAnnotationId, updateViewState]);

  const fileName = filePath.split("/").at(-1) ?? filePath;
  const editable = Boolean(onSaveEditedCopy && src) && !/\.svg$/i.test(filePath);
  const siblingIndex = siblings?.findIndex((sibling) => sibling.path === filePath) ?? -1;
  const siblingCount = siblingIndex >= 0 && onShowSibling ? siblings?.length ?? 0 : 0;
  const previousSibling = siblingCount ? siblings?.[siblingIndex - 1] : undefined;
  const nextSibling = siblingCount ? siblings?.[siblingIndex + 1] : undefined;

  const showSibling = useCallback((path: string | undefined, carry: { playing: boolean; fullscreen: boolean }) => {
    if (!path || path === filePath || !onShowSibling) {
      return;
    }

    handoff = { filePath: path, ...carry, at: Date.now() };
    onShowSibling(path);
  }, [filePath, onShowSibling]);

  // The Info panel stays open or closed across images.
  useEffect(() => {
    queueMicrotask(() => setInfoOpen(readInfoOpen()));
  }, []);

  function toggleInfo() {
    setInfoOpen((open) => {
      try {
        window.localStorage.setItem(INFO_STORAGE_KEY, String(!open));
      } catch {
        // Storage unavailable: the panel still toggles for this image.
      }

      return !open;
    });
  }

  useEffect(() => {
    if (handoff?.filePath === filePath) {
      handoff = null;
    }
  }, [filePath]);

  // Preload the neighbors so stepping through the folder feels instant.
  useEffect(() => {
    for (const neighbor of [previousSibling, nextSibling]) {
      if (neighbor) {
        new Image().src = neighbor.src;
      }
    }
  }, [nextSibling, previousSibling]);

  useEffect(() => {
    if (!playing || editing || siblingCount < 2) {
      return;
    }

    const timer = window.setTimeout(() => {
      showSibling((nextSibling ?? siblings?.[0])?.path, { playing: true, fullscreen });
    }, SLIDESHOW_MS);
    return () => window.clearTimeout(timer);
  }, [editing, fullscreen, nextSibling, playing, showSibling, siblingCount, siblings]);

  useEffect(() => {
    fullscreenRef.current = fullscreen;
  }, [fullscreen]);

  // Full screen fills the screen with the viewer (in a portal, so no panel
  // clips it) and puts the window in full screen. The document, not the viewer,
  // goes full screen so it stays that way when the next photo replaces this one.
  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement) {
        setFullscreen(false);
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);

      // Closing the tab leaves full screen, unless the next photo took it over.
      if (fullscreenRef.current) {
        window.setTimeout(() => {
          if (!document.querySelector("[data-image-viewer-fullscreen]") && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => undefined);
          }
        });
      }
    };
  }, []);

  function toggleFullscreen() {
    if (fullscreen) {
      setFullscreen(false);

      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }

      return;
    }

    setFullscreen(true);

    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function downloadImage() {
    if (!src) {
      return;
    }

    const link = document.createElement("a");
    link.href = src;
    link.download = fileName;
    link.click();
  }

  function copyToClipboard() {
    if (!src) {
      return;
    }

    copyImage(src).then(
      () => setNotice("Copied to the clipboard"),
      () => setNotice("Could not copy this image"),
    );
  }

  function startEditing() {
    setPlaying(false);
    setEditing(true);
  }

  // Viewer shortcuts, like the Gallery's: ← → step through the folder, + − 0
  // zoom, F full screen, I info, E edit, Space slideshow.
  useEffect(() => {
    function handleViewerKey(event: KeyboardEvent) {
      const target = event.target;

      if (
        !paneFocused ||
        editing ||
        screenshotSnipping ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        document.querySelector(".libera-dialog") ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest("input, textarea, select, [role=menu]")))
      ) {
        return;
      }

      const key = event.key;

      if (key === "ArrowLeft" && previousSibling) {
        showSibling(previousSibling.path, { playing, fullscreen });
      } else if (key === "ArrowRight" && nextSibling) {
        showSibling(nextSibling.path, { playing, fullscreen });
      } else if (key === "+" || key === "=") {
        zoomBy(ZOOM_FACTOR);
      } else if (key === "-") {
        zoomBy(1 / ZOOM_FACTOR);
      } else if (key === "0") {
        resetView();
      } else if (key === "f" || key === "F") {
        toggleFullscreen();
      } else if (key === "i" || key === "I") {
        toggleInfo();
      } else if ((key === "e" || key === "E") && editable) {
        startEditing();
      } else if (key === " " && siblingCount > 1 && !(target instanceof HTMLElement && target.closest("button, a"))) {
        setPlaying((value) => !value);
      } else if (key === "Escape" && !selectedAnnotationId && (playing || fullscreen)) {
        // Esc leaves a browser's full screen by itself; this covers the rest.
        if (playing) {
          setPlaying(false);
        } else {
          toggleFullscreen();
        }
      } else {
        return;
      }

      event.preventDefault();
    }

    window.addEventListener("keydown", handleViewerKey);
    return () => window.removeEventListener("keydown", handleViewerKey);
  });

  async function captureScreenshotSnip(rect: PdfAnnotationRect) {
    const image = imageRef.current;

    if (!image || !onCompleteScreenshotSnip) {
      return;
    }

    try {
      await onCompleteScreenshotSnip(
        await imageElementRectToPngFile(image, rect, filePath),
      );
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "Could not capture image screenshot.",
      );
    }
  }

  const naturalDimensions = naturalSize.width ? `${naturalSize.width} × ${naturalSize.height}` : "";
  const infoRows = [
    ["Name", fileName],
    ["Dimensions", naturalDimensions],
    ["Size", details?.size !== undefined ? formatBytes(details.size) : ""],
    ["Created", formatDate(details?.createdAt)],
    ["Modified", formatDate(details?.updatedAt)],
    ["Location", details?.location ?? ""],
  ].filter(([, value]) => value);

  const viewer = (
    <div
      className={`libera-media-viewer libera-image-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-muted ${
        fullscreen ? "fixed inset-0 z-50 bg-background" : ""
      }`}
      data-image-viewer-fullscreen={fullscreen ? "" : undefined}
    >
      <div className="libera-viewer-toolbar flex flex-wrap items-center justify-between gap-3 border-b border-input bg-card px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1" data-pdf-annotation-ui onMouseDown={keepEditorFocus}>
          <Move aria-hidden className="h-4 w-4 shrink-0" />
          {annotatable ? <>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "select"
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            aria-pressed={tool === "select"}
            data-viewer-tool="select"
            onClick={() => {
              setTool("select");
              updateViewState({ tool: "select" });
            }}
          >
            <MousePointer2 aria-hidden className="h-4 w-4" />
            Select
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "text"
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            aria-pressed={tool === "text"}
            data-viewer-tool="text"
            onClick={() => {
              setTool("text");
              updateViewState({ tool: "text" });
            }}
          >
            <Type aria-hidden className="h-4 w-4" />
            Text
          </button>
          <TextAnnotationStyleControls
            color={selectedAnnotation?.color ?? textColor}
            fontFamily={selectedAnnotation?.fontFamily ?? fontFamily}
            fontSize={fontSize}
            onColorChange={updateTextColor}
            onFontFamilyChange={updateFontFamily}
            onFontSizeChange={updateFontSize}
          />
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/40 text-destructive hover:bg-destructive-muted disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label="Delete selected annotation"
            title="Delete selected annotation"
            disabled={!selectedAnnotationId}
            onClick={deleteSelectedAnnotation}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </button>
          </> : <span className="text-xs text-muted-foreground">View only</span>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <span className="mr-2 text-xs text-muted-foreground">
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
            className={iconButton}
            type="button"
            onClick={() => zoomBy(1 / ZOOM_FACTOR)}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out (−)"
          >
            <ZoomOut aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label={atFit ? "Show actual size" : "Fit to view"}
            className="h-8 min-w-14 rounded-lg px-1 text-center text-sm font-medium tabular-nums text-foreground hover:bg-muted"
            type="button"
            onClick={toggleActualSize}
            title={atFit ? "Actual size" : "Fit to view (0)"}
          >
            {atFit ? "Fit" : `${Math.round(zoom * fitScale * 100)}%`}
          </button>
          <button
            aria-label="Zoom in"
            className={iconButton}
            type="button"
            onClick={() => zoomBy(ZOOM_FACTOR)}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in (+)"
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <span aria-hidden className="mx-1 h-6 w-px bg-border" />
          {editable ? (
            <button aria-label="Edit image" className={iconButton} type="button" title="Edit: crop, rotate, adjust. Saves a copy (E)" onClick={startEditing}>
              <Pencil aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
          {siblingCount > 1 ? (
            <button
              aria-label={playing ? "Pause slideshow" : "Play slideshow"}
              className={iconButton}
              type="button"
              title={playing ? "Pause slideshow (Space)" : "Slideshow of this folder (Space)"}
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? <Pause aria-hidden className="h-4 w-4" /> : <Play aria-hidden className="h-4 w-4" />}
            </button>
          ) : null}
          <button aria-label="Copy image" className={iconButton} type="button" title="Copy image" disabled={!src} onClick={copyToClipboard}>
            <Copy aria-hidden className="h-4 w-4" />
          </button>
          <button aria-label="Download image" className={iconButton} type="button" title="Download" disabled={!src} onClick={downloadImage}>
            <Download aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            className={iconButton}
            type="button"
            title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize aria-hidden className="h-4 w-4" /> : <Maximize aria-hidden className="h-4 w-4" />}
          </button>
          <button aria-label="Info" aria-pressed={infoOpen} className={iconButton} type="button" title="Info (I)" onClick={toggleInfo}>
            <Info aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={stageRef}
        className={`relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-6 ${
          screenshotSnipping
            ? "cursor-crosshair"
            : tool === "text"
              ? "cursor-crosshair"
              : isPanning
                ? "cursor-grabbing"
                : "cursor-grab"
        }`}
        onDoubleClick={handleDoubleClick}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        style={{ touchAction: "none" }}
      >
        {src ? (
          <div
            ref={imageFrameRef}
            className="libera-photo-frame relative inline-block rounded-lg bg-card shadow-sm"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: isPanning ? "none" : "transform 120ms ease-out",
              transformOrigin: "center",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
            <img
              ref={imageRef}
              className={`block max-w-full select-none rounded-lg object-contain ${
                fullscreen ? "max-h-[calc(100vh-7rem)]" : "max-h-[calc(100vh-236px)]"
              }`}
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(event) =>
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
            {annotatable ? <TextAnnotationLayer
              annotations={annotations}
              drawing={tool === "text"}
              interactive={tool === "select"}
              pageSize={imageSize}
              selectedAnnotationId={selectedAnnotationId}
              documentPath={filePath}
              newAnnotationFontSize={fontSize}
              onAddAnnotation={addTextAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onExitTextEditing={() => {
                setTool("select");
                updateViewState({ tool: "select" });
              }}
              onSelectAnnotation={selectAnnotation}
              onUpdateAnnotation={updateTextAnnotation}
            /> : null}
            <ScreenshotSnipLayer
              active={screenshotSnipping}
              pageSize={imageSize}
              onCancel={onCancelScreenshotSnip ?? (() => undefined)}
              onCapture={captureScreenshotSnip}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Image preview is unavailable.</p>
        )}
      </div>
      {/* Outside the stage, so pressing them never starts a pan. */}
      {previousSibling ? (
        <button
          aria-label="Previous image"
          className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          type="button"
          title="Previous image in this folder (←)"
          onClick={() => showSibling(previousSibling.path, { playing, fullscreen })}
        >
          <ChevronLeft aria-hidden className="h-6 w-6" />
        </button>
      ) : null}
      {nextSibling ? (
        <button
          aria-label="Next image"
          className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          type="button"
          title="Next image in this folder (→)"
          onClick={() => showSibling(nextSibling.path, { playing, fullscreen })}
        >
          <ChevronRight aria-hidden className="h-6 w-6" />
        </button>
      ) : null}
      {siblingCount > 1 ? (
        <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-0.5 text-xs tabular-nums text-white">
          {siblingIndex + 1} of {siblingCount}
        </span>
      ) : null}
      {notice ? (
        <div role="status" className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">
          {notice}
        </div>
      ) : null}
      </div>
      {infoOpen ? (
        <aside aria-label="Image info" className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-card p-4 text-sm max-sm:hidden">
          <h2 className="text-sm font-semibold">Info</h2>
          <dl className="space-y-3">
            {infoRows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
          {annotatable ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {annotations.length === 1 ? "1 text note" : `${annotations.length} text notes`} on this image.
            </p>
          ) : null}
        </aside>
      ) : null}
      </div>
    </div>
  );

  return (
    <>
      {fullscreen ? createPortal(viewer, document.body) : viewer}
      {editing && src && onSaveEditedCopy
        ? createPortal(
            <div role="dialog" aria-modal="true" aria-label={`Edit ${fileName}`} className="fixed inset-0 z-[60] flex flex-col bg-neutral-950 text-white">
              <PhotoEditor
                src={src}
                copyOnly
                onCancel={() => setEditing(false)}
                onSave={async (edits) => {
                  await onSaveEditedCopy(edits);
                  setEditing(false);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
