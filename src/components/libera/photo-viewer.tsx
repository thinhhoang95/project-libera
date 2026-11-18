"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import {
  AppWindow,
  ArchiveRestore,
  ArrowLeft,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderDown,
  FolderInput,
  ImagePlus,
  Info,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Minus,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Save,
  ScanSearch,
  Sparkles,
  Star,
  Trash2,
  UserPlus,
} from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { useAppMenuPhoto, withMenuActions } from "@/components/libera/app-menu";
import { galleryText, useRegisterGalleryTranslator } from "@/components/libera/gallery-i18n";
import { useGalleryPhotoDetails } from "@/components/libera/gallery-store";
import { toolbarCommands, usePaletteCommands } from "@/components/libera/command-palette/commands";
import { DetectionTool } from "@/components/libera/detection/detection-tool";
import { notebookSaveMenuItems, openImageSaveMenu, runImageSaveMenuAction, subscribeImageSaved } from "@/components/libera/image-save";
import { commandMenuItems, disabledMenu, menuCommands, type NativeMenuEntry } from "@/components/libera/native-menu";
import { PhotoEditor } from "@/components/libera/photo-editor";
import { PhotoInkLayer } from "@/components/libera/ink/photo-ink-layer";
import { pendingSaves } from "@/components/libera/pending-saves";
import { useCanvasViewStateCapture } from "@/components/libera/canvas-view-state";
import type { PhotoRegion } from "@/lib/collab/album-comments";
import { archiveRawUrl, canChangeSharedPhotos, galleryRawUrl, sizedGalleryUrl, type GalleryAlbum, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

const MAX_ZOOM = 8;
// How long pan/zoom must pause before the tab's stored view follows it.
const VIEW_STATE_DELAY_MS = 200;
const SLIDESHOW_MS = 4000;
const toolButton = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/85 hover:bg-white/10 hover:text-white disabled:opacity-40";

/** A file size in B, kB or MB, with the unit names and number format of `locale` (the interface language). */
export function formatBytes(bytes: number, locale?: string) {
  const [unit, value, digits] = bytes < 1024 ? ["byte", bytes, 0] as const
    : bytes < 1024 * 1024 ? ["kilobyte", bytes / 1024, 0] as const : ["megabyte", bytes / 1024 / 1024, 1] as const;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

/** Copies a photo to the clipboard, as PNG. */
export async function copyImage(url: string) {
  const blob = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(galleryText("photoViewer.loadPhotoFailed"));
    return response.blob();
  });
  // The clipboard takes PNG everywhere; convert other formats first.
  let png = blob;
  if (blob.type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error(galleryText("photoViewer.copyPhotoFailed")))), "image/png"));
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export type PhotoViewerViewState = { transform: Transform; infoOpen: boolean; infoScrollTop: number };

type Transform = { scale: number; x: number; y: number };
const FIT: Transform = { scale: 1, x: 0, y: 0 };

/** Areas drawn over the photo (comments on part of a shared photo), and drawing a new one. */
export type PhotoOverlay = {
  regions: Array<{ id: string; region: PhotoRegion; active: boolean }>;
  /** While set, dragging over the photo draws an area instead of panning. */
  onPick?: (region: PhotoRegion | null) => void;
};

/** Zoomable, pannable photo. `scale` 1 fits the photo in the stage. */
/** Ink over the photo (ink/photo-ink-layer.tsx); archived photos have none here. */
type PhotoInk = { drawing: boolean; toolbarSlot: HTMLElement | null; onEdited: (gallery: GalleryContents) => void };

function ZoomableImage({ photo, rawUrl, transform, onTransform, onFitScale, overlay, ink }: {
  photo: GalleryPhoto;
  rawUrl: PhotoUrl;
  transform: Transform;
  onTransform: (transform: Transform) => void;
  onFitScale: (fitScale: number) => void;
  overlay?: PhotoOverlay | null;
  ink?: PhotoInk | null;
}) {
  const t = useTranslations("photoViewer");
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; start: Transform } | null>(null);
  const [loadedSrc, setLoadedSrc] = useState("");
  const [previewEdge, setPreviewEdge] = useState(2048);
  const src = transform.scale > 1 ? rawUrl(photo) : sizedGalleryUrl(rawUrl(photo), previewEdge);
  const loaded = loadedSrc === src;
  const [dragging, setDragging] = useState(false);
  // Where the photo is inside the stage (after zoom and pan), for the overlay.
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const measureBox = useCallback(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const image = imageRef.current?.getBoundingClientRect();
    if (!stage || !image || !image.width) return setBox(null);
    setBox({ left: image.left - stage.left, top: image.top - stage.top, width: image.width, height: image.height });
  }, []);
  // The transform animates for 80 ms; measure again once it has settled.
  useLayoutEffect(() => {
    if (!overlay && !ink) return;
    measureBox();
    const timer = window.setTimeout(measureBox, 120);
    return () => window.clearTimeout(timer);
  }, [measureBox, overlay, ink, transform, loaded]);

  const clampPan = useCallback((next: Transform): Transform => {
    const stage = stageRef.current?.getBoundingClientRect();
    const image = imageRef.current;
    if (!stage || !image || next.scale <= 1) return { ...next, x: 0, y: 0 };
    const width = image.offsetWidth * next.scale;
    const height = image.offsetHeight * next.scale;
    const limitX = Math.max(0, (width - stage.width) / 2);
    const limitY = Math.max(0, (height - stage.height) / 2);
    return { scale: next.scale, x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) };
  }, []);

  /** Zoom keeping the point under the cursor still. */
  const zoomAt = useCallback((scale: number, clientX?: number, clientY?: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    const nextScale = Math.min(MAX_ZOOM, Math.max(1, scale));
    if (!stage) return;
    const pointX = clientX === undefined ? 0 : clientX - (stage.left + stage.width / 2);
    const pointY = clientY === undefined ? 0 : clientY - (stage.top + stage.height / 2);
    const factor = nextScale / transform.scale;
    onTransform(clampPan({ scale: nextScale, x: pointX - (pointX - transform.x) * factor, y: pointY - (pointY - transform.y) * factor }));
  }, [clampPan, onTransform, transform]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      // Pinch gestures arrive as ctrl+wheel with small deltas.
      const intensity = event.ctrlKey ? 0.01 : 0.0025;
      zoomAt(transform.scale * Math.exp(-event.deltaY * intensity), event.clientX, event.clientY);
    }
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [transform.scale, zoomAt]);

  const reportFit = useCallback(() => {
    const image = imageRef.current;
    if (image?.naturalWidth) onFitScale(image.offsetWidth / (photo.width || image.naturalWidth));
    const stage = stageRef.current;
    if (stage?.clientWidth && stage.clientHeight) setPreviewEdge(Math.max(stage.clientWidth, stage.clientHeight) * Math.min(2, window.devicePixelRatio || 1));
    measureBox();
  }, [measureBox, onFitScale, photo.width]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(reportFit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [reportFit]);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || transform.scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, start: transform };
    setDragging(true);
  }

  function pointerEnd() {
    dragRef.current = null;
    setDragging(false);
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    onTransform(clampPan({ ...drag.start, x: drag.start.x + event.clientX - drag.x, y: drag.start.y + event.clientY - drag.y }));
  }

  return <div ref={stageRef} className={`relative flex min-h-0 min-w-0 flex-1 touch-none items-center justify-center overflow-hidden ${transform.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
    // Quick taps while drawing are ink, not a zoom.
    onDoubleClick={(event) => { if (!ink?.drawing) { if (transform.scale > 1) onTransform(FIT); else zoomAt(2.5, event.clientX, event.clientY); } }}>
    {/* The thumbnail shows at once while the full photo loads. */}
    {!loaded && /* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */
      <img src={rawUrl(photo, true)} alt="" aria-hidden className="absolute max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] object-contain blur-[2px]" />}
    {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
    <img ref={imageRef} key={`${photo.id}-${photo.updatedAt}`} src={src} alt={photo.prompt ?? photo.name} draggable={false} decoding="async" fetchPriority="high"
      className={`max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] select-none object-contain transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
      style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transition: dragging ? "none" : "transform 80ms ease-out, opacity 150ms" }}
      onLoad={() => { setLoadedSrc(src); reportFit(); }} />
    {ink && box && loaded && <div className="absolute" style={box} data-photo-ink>
      <PhotoInkLayer photoId={photo.id} version={photo.updatedAt} drawing={ink.drawing} toolbarSlot={ink.toolbarSlot} onEdited={ink.onEdited} inSharedAlbum={Boolean(photo.shared)}
        onPan={(dx, dy) => onTransform(clampPan({ ...transform, x: transform.x + dx, y: transform.y + dy }))} />
    </div>}
    {overlay && box && <div className="pointer-events-none absolute" style={box} data-photo-overlay>
      {overlay.regions.map((item) => <span key={item.id} aria-hidden
        className={`absolute rounded-sm border-2 ${item.active ? "border-amber-300 bg-amber-300/15" : "border-white/70 bg-white/5"}`}
        style={{ left: `${item.region.x * 100}%`, top: `${item.region.y * 100}%`, width: `${item.region.width * 100}%`, height: `${item.region.height * 100}%` }} />)}
      {overlay.onPick && <div role="application" aria-label={t("dragOverPhoto")} className="pointer-events-auto absolute inset-0 cursor-crosshair bg-black/20"
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;
          setDrawing({ x0: x, y0: y, x1: x, y1: y });
        }}
        onPointerMove={(event) => {
          if (!drawing) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setDrawing({ ...drawing, x1: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y1: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) });
        }}
        onPointerUp={() => {
          if (!drawing) return;
          const region = { x: Math.min(drawing.x0, drawing.x1), y: Math.min(drawing.y0, drawing.y1), width: Math.abs(drawing.x1 - drawing.x0), height: Math.abs(drawing.y1 - drawing.y0) };
          setDrawing(null);
          // A click without a drag means the whole photo.
          overlay.onPick?.(region.width > 0.01 && region.height > 0.01 ? region : null);
        }}
        onDoubleClick={(event) => event.stopPropagation()}>
        {drawing && <span className="absolute rounded-sm border-2 border-amber-300 bg-amber-300/20"
          style={{ left: `${Math.min(drawing.x0, drawing.x1) * 100}%`, top: `${Math.min(drawing.y0, drawing.y1) * 100}%`, width: `${Math.abs(drawing.x1 - drawing.x0) * 100}%`, height: `${Math.abs(drawing.y1 - drawing.y0) * 100}%` }} />}
      </div>}
    </div>}
  </div>;
}

/** Builds a photo's URL; archived photos are served from the archive's own route. */
type PhotoUrl = (photo: GalleryPhoto, thumbnail?: boolean) => string;

/** Actions left out are not offered, as in the Protected Archive. */
export type PhotoViewerActions = {
  onToggleStar?: (photo: GalleryPhoto) => void;
  onDelete: (photo: GalleryPhoto) => void;
  onAddToAlbum?: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  /** What `onAddToAlbum`'s popup offers, for the menu bar and the palette. */
  albumChoices?: (photo: GalleryPhoto) => NativeMenuEntry[];
  /** Offers to open the photo as an editor tab, alone or beside the focused panel. */
  onOpenInCanvas?: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  /** What `onOpenInCanvas`'s popup offers, for the menu bar and the palette. */
  openChoices?: (photo: GalleryPhoto) => NativeMenuEntry[];
  onRevert?: (photo: GalleryPhoto) => Promise<void>;
  onReusePrompt?: (photo: GalleryPhoto) => void;
  onUseAsReference?: (photo: GalleryPhoto) => void;
  onEdited?: (result: { id: string; gallery: GalleryContents }) => void;
  /** Sends the photo to the Protected Archive. */
  onArchive?: (photo: GalleryPhoto) => void;
  /** Puts an archived photo back in the gallery. */
  onRestore?: (photo: GalleryPhoto) => void;
  /** Shares the photo on its own (collaboration). */
  onShare?: (photo: GalleryPhoto) => void;
  /** Copies a shared album's photo into this gallery. */
  onSaveToGallery?: (photo: GalleryPhoto) => void;
};

/**
 * A shared album photo's details in the Info panel (caption, who added it,
 * comments). It can draw comment areas over the photo.
 */
export type PhotoViewerShared = (photo: GalleryPhoto, setOverlay: (overlay: PhotoOverlay | null) => void) => ReactNode;

/** The AI chat panel, offered beside the viewer for photos it may see. */
export type PhotoViewerChat = { open: boolean; onToggle: () => void };

/** The viewer covers the window; with the AI chat open it leaves the chat panel's column uncovered. */
function useChatPanelInset(rootRef: RefObject<HTMLDivElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const panel = open ? document.getElementById("document-chat-panel") : null;
    if (!panel) { root.style.right = ""; return; }
    const measure = () => { root.style.right = `${Math.max(0, window.innerWidth - panel.getBoundingClientRect().left)}px`; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); root.style.right = ""; };
  }, [rootRef, open]);
}

export function PhotoViewer({ photos, index, albums, onNavigate: navigateTo, onClose: close, actions, chat, initialViewState, onViewStateChange, rawUrl = galleryRawUrl, sharedDetails, menusBlocked = false }: {
  photos: GalleryPhoto[];
  index: number;
  albums: GalleryAlbum[];
  onNavigate: (photo: GalleryPhoto) => void;
  onClose: () => void;
  actions: PhotoViewerActions;
  chat?: PhotoViewerChat;
  rawUrl?: PhotoUrl;
  initialViewState?: PhotoViewerViewState;
  onViewStateChange?: (state: PhotoViewerViewState) => void;
  sharedDetails?: PhotoViewerShared;
  /** A dialog is open over the viewer, so its Photo menu waits. */
  menusBlocked?: boolean;
}) {
  const t = useTranslations("photoViewer");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  useRegisterGalleryTranslator();
  const photo = useGalleryPhotoDetails(photos[index], rawUrl === archiveRawUrl);
  const [overlay, setOverlay] = useState<PhotoOverlay | null>(null);
  // A viewer or commenter of a shared album only looks.
  const locked = Boolean(photo?.shared) && !canChangeSharedPhotos(photo?.shared);
  const [transformState, setTransformState] = useState({ id: photo.id, value: initialViewState?.transform ?? FIT });
  const transform = transformState.id === photo.id ? transformState.value : initialViewState?.transform ?? FIT;
  const setTransform = useCallback((action: Transform | ((value: Transform) => Transform)) => {
    setTransformState((current) => {
      const previous = current.id === photo.id ? current.value : initialViewState?.transform ?? FIT;
      return { id: photo.id, value: typeof action === "function" ? action(previous) : action };
    });
  }, [photo.id, initialViewState?.transform]);
  const [fitScale, setFitScale] = useState(1);
  const [infoOpen, setInfoOpen] = useState(initialViewState?.infoOpen ?? true);
  const [editing, setEditing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [inkToolbarSlot, setInkToolbarSlot] = useState<HTMLElement | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Leaving a photo with unsaved ink (pending-saves.ts) asks first: Save, Discard or keep drawing.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [leaveError, setLeaveError] = useState("");
  const guarded = useCallback((action: () => void) => {
    if (!pendingSaves.isDirty(`gallery:${photo.id}`)) return action();
    setPlaying(false);
    setLeaveError("");
    setLeaving(() => action);
  }, [photo.id]);
  const onNavigate = useCallback((next: GalleryPhoto) => guarded(() => navigateTo(next)), [guarded, navigateTo]);
  const onClose = useCallback(() => guarded(close), [guarded, close]);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLElement>(null);
  const infoScrollRef = useRef(initialViewState?.infoScrollTop ?? 0);
  const infoPositionsRef = useRef(new Map<string, number>());
  const initialInfoScrollTop = initialViewState?.infoScrollTop;
  const chatOpen = !!chat?.open && !editing;
  useChatPanelInset(rootRef, chatOpen);
  useLayoutEffect(() => {
    infoScrollRef.current = infoPositionsRef.current.get(photo.id) ?? initialInfoScrollTop ?? 0;
    if (infoRef.current) infoRef.current.scrollTop = infoScrollRef.current;
  }, [photo.id, infoOpen, initialInfoScrollTop]);
  // Pan and zoom change on every pointer move or wheel tick; the stored view
  // follows once they pause, and on unmount or capture.
  const onViewStateChangeRef = useRef(onViewStateChange);
  const latestViewRef = useRef({ transform, infoOpen });
  const viewStateTimerRef = useRef<number | null>(null);
  const viewStatePendingRef = useRef(false);
  const reportedInfoOpenRef = useRef<boolean | null>(null);
  const reportViewState = useCallback(() => {
    if (viewStateTimerRef.current !== null) {
      window.clearTimeout(viewStateTimerRef.current);
      viewStateTimerRef.current = null;
    }
    if (!viewStatePendingRef.current) return;
    viewStatePendingRef.current = false;
    const latest = latestViewRef.current;
    onViewStateChangeRef.current?.({ transform: latest.transform, infoOpen: latest.infoOpen, infoScrollTop: infoScrollRef.current });
  }, []);
  useLayoutEffect(() => { onViewStateChangeRef.current = onViewStateChange; });
  useLayoutEffect(() => {
    latestViewRef.current = { transform, infoOpen };
    viewStatePendingRef.current = true;
    if (reportedInfoOpenRef.current !== infoOpen) {
      reportedInfoOpenRef.current = infoOpen;
      reportViewState();
      return;
    }
    if (viewStateTimerRef.current !== null) window.clearTimeout(viewStateTimerRef.current);
    viewStateTimerRef.current = window.setTimeout(reportViewState, VIEW_STATE_DELAY_MS);
  }, [transform, infoOpen, reportViewState]);
  useCanvasViewStateCapture(reportViewState);
  useLayoutEffect(() => reportViewState, [reportViewState]);
  const hasPrevious = index > 0;
  const hasNext = index < photos.length - 1;

  const go = useCallback((offset: number) => {
    const next = photos[index + offset];
    if (next) onNavigate(next);
  }, [index, onNavigate, photos]);

  // Only bounded previews are speculative. Cancel obsolete work on every step.
  useEffect(() => {
    if (rawUrl !== galleryRawUrl) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      for (const neighbor of [photos[index - 1], photos[index + 1]]) if (neighbor) {
        void fetch(sizedGalleryUrl(rawUrl(neighbor)), { signal: controller.signal, cache: "force-cache" })
          .then(async (response) => { if (response.ok) await response.blob(); else await response.body?.cancel(); }).catch(() => undefined);
      }
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [index, photos, rawUrl]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (hasNext) go(1);
      else if (photos[0]) { onNavigate(photos[0]); }
    }, SLIDESHOW_MS);
    return () => window.clearTimeout(timer);
  }, [go, hasNext, onNavigate, photos, playing, index]);

  useEffect(() => {
    function changed() { setFullscreen(document.fullscreenElement === rootRef.current); }
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Saving to a notebook folder finishes in the app's folder picker, which reports back here.
  const photoUrl = photo ? rawUrl(photo) : "";
  useEffect(() => subscribeImageSaved((saved) => { if (saved.src === photoUrl) setNotice(saved.message); }), [photoUrl]);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => undefined);
  }

  function toggleChat() {
    if (!chat) return;
    // Full screen would hide the chat panel.
    if (!chat.open && document.fullscreenElement) void document.exitFullscreen();
    setPlaying(false);
    chat.onToggle();
  }

  function zoomBy(factor: number) {
    setTransform((current) => (current.scale * factor <= 1 ? FIT : { ...current, scale: Math.min(MAX_ZOOM, current.scale * factor) }));
  }

  function actualSize() {
    setTransform({ scale: Math.min(MAX_ZOOM, Math.max(1, 1 / fitScale)), x: 0, y: 0 });
  }

  function startEditing() {
    setPlaying(false);
    setDrawing(false);
    setEditing(true);
  }

  function toggleDrawing() {
    setPlaying(false);
    setDrawing((value) => !value);
  }

  function startDetecting() {
    setPlaying(false);
    if (document.fullscreenElement) void document.exitFullscreen();
    setDetecting(true);
  }

  function copyPhoto() {
    void copyImage(rawUrl(photo)).then(() => setNotice(t("copied")), () => setNotice(t("copyFailed")));
  }

  function revertPhoto() {
    void actions.onRevert?.(photo).then(() => { setTransform(FIT); setNotice(t("revertedToOriginal")); }, () => setNotice(t("revertFailed")));
  }

  /** The Save photo menu's choices, for the menu bar and the palette. */
  function saveChoices() {
    const source = { name: photo.name, src: rawUrl(photo) };
    return withMenuActions(notebookSaveMenuItems(), (id) => {
      setPlaying(false);
      void runImageSaveMenuAction(id, source).then((message) => { if (message) setNotice(message); });
    });
  }

  useEffect(() => {
    if (editing) return;
    function handleKey(event: KeyboardEvent) {
      if (document.querySelector(".libera-dialog, [data-libera-overlay]") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [role=menu], #document-chat-panel")) return;
      const key = event.key;
      if (key === "Escape") { if (!document.fullscreenElement) onClose(); }
      else if (key === "ArrowLeft") go(-1);
      else if (key === "ArrowRight") go(1);
      else if (key === "+" || key === "=") zoomBy(1.5);
      else if (key === "-") zoomBy(1 / 1.5);
      else if (key === "0") setTransform(FIT);
      else if (key === "s" || key === "S") actions.onToggleStar?.(photo);
      else if ((key === "e" || key === "E") && actions.onEdited && !photo.name.toLowerCase().endsWith(".svg")) setEditing(true);
      else if (key === "i" || key === "I") setInfoOpen((open) => !open);
      else if (key === "f" || key === "F") toggleFullscreen();
      else if (key === " ") setPlaying((value) => !value);
      else if ((key === "Delete" || key === "Backspace") && !locked) actions.onDelete(photo);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  // The viewer's own command group: its palette commands, its toolbar's data-command-toolbar, and the filter that keeps
  // that toolbar out of the Tools submenus all read this one value, so they still match once it is translated.
  const photoGroup = t("paletteGroup");

  // Moving between photos and the Info panel's actions, for the command palette; the toolbar's buttons are read from the page.
  usePaletteCommands(rootRef, () => {
    if (!photo || editing || detecting) return [];
    const group = photoGroup;
    return [
      { id: "photo:previous", title: t("palettePreviousPhoto"), group, icon: ChevronLeft, shortcut: "←", disabled: !hasPrevious, run: () => go(-1) },
      { id: "photo:next", title: t("paletteNextPhoto"), group, icon: ChevronRight, shortcut: "→", disabled: !hasNext, run: () => go(1) },
      { id: "photo:first", title: t("paletteFirstPhoto"), group, icon: ChevronFirst, disabled: !hasPrevious, run: () => onNavigate(photos[0]) },
      { id: "photo:last", title: t("paletteLastPhoto"), group, icon: ChevronLast, disabled: !hasNext, run: () => onNavigate(photos[photos.length - 1]) },
      { id: "photo:fit", title: t("paletteFitToScreen"), group, icon: Minimize2, shortcut: "0", checked: transform.scale <= 1, run: () => setTransform(FIT) },
      { id: "photo:actual-size", title: t("paletteActualSize"), group, icon: Maximize2, keywords: "100% zoom pixels", run: actualSize },
      ...(photo.prompt && actions.onReusePrompt ? [{ id: "photo:reuse-prompt", title: t("paletteReusePrompt"), group, icon: Sparkles, keywords: "generate again", run: () => actions.onReusePrompt?.(photo) }] : []),
      ...(actions.onUseAsReference ? [{ id: "photo:use-as-reference", title: t("paletteUseAsReference"), group, icon: ImagePlus, run: () => actions.onUseAsReference?.(photo) }] : []),
      ...(photo.edited && actions.onRevert && !locked ? [{
        id: "photo:revert", title: t("paletteRevert"), group, icon: RotateCcw, keywords: "undo edits", run: revertPhoto,
      }] : []),
      ...menuCommands(actions.albumChoices?.(photo) ?? [], { group, icon: FolderInput, keywords: "album" }, (label) => t("paletteAddToAlbum", { label })),
      ...menuCommands(actions.openChoices?.(photo) ?? [], { group, icon: AppWindow, keywords: "canvas split pane" }),
      ...menuCommands(saveChoices(), { group, icon: Download, keywords: "download export" }),
    ];
  });

  // The tools' own toolbars change without the viewer rendering; render so the menu bar follows them.
  const [, setToolState] = useState(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new MutationObserver(() => setToolState((state) => state + 1));
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "aria-pressed", "aria-checked"] });
    return () => observer.disconnect();
  }, []);

  // Every button of the viewer's toolbar, and the Ink and Detection toolbars while those are open.
  useAppMenuPhoto("viewer", () => {
    if (!photo) return [];
    const root = rootRef.current;
    const tools = root ? toolbarCommands(root).filter((command) => command.groupId !== "photo") : [];
    const toolMenus = [...new Set(tools.map((command) => command.group!))].map((group): NativeMenuEntry => ({
      id: `tools:${group}`, label: group, submenu: commandMenuItems(tools.filter((command) => command.group === group)),
    }));
    if (editing || detecting) return toolMenus;
    const editable = !photo.name.toLowerCase().endsWith(".svg");
    const albumChoices = actions.albumChoices?.(photo);
    const openChoices = actions.openChoices?.(photo);
    const items: NativeMenuEntry[] = [
      { id: "back", label: t("menuBackToGallery"), onSelect: onClose },
      { type: "separator" },
      { id: "previous", label: t("menuPreviousPhoto"), enabled: hasPrevious, onSelect: () => go(-1) },
      { id: "next", label: t("menuNextPhoto"), enabled: hasNext, onSelect: () => go(1) },
      { id: "first", label: t("menuFirstPhoto"), enabled: hasPrevious, onSelect: () => onNavigate(photos[0]) },
      { id: "last", label: t("menuLastPhoto"), enabled: hasNext, onSelect: () => onNavigate(photos[photos.length - 1]) },
      { type: "separator" },
      { id: "zoom-in", label: t("menuZoomIn"), enabled: transform.scale < MAX_ZOOM, onSelect: () => zoomBy(1.5) },
      { id: "zoom-out", label: t("menuZoomOut"), enabled: transform.scale > 1, onSelect: () => zoomBy(1 / 1.5) },
      { id: "fit", label: t("menuFitToScreen"), type: "checkbox", checked: transform.scale <= 1, onSelect: () => setTransform(FIT) },
      { id: "actual-size", label: t("menuActualSize"), onSelect: actualSize },
      { type: "separator" },
      ...(actions.onToggleStar ? [{ id: "star", label: photo.starred ? t("menuUnstar") : t("menuStar"), onSelect: () => actions.onToggleStar?.(photo) }] : []),
      ...(editable && actions.onEdited ? [{ id: "edit", label: t("menuEdit"), onSelect: startEditing }] : []),
      ...(editable && actions.onEdited && !locked ? [{ id: "draw", label: t("menuDraw"), type: "checkbox" as const, checked: drawing, onSelect: toggleDrawing }] : []),
      ...toolMenus,
      { id: "detection", label: t("menuDetection"), onSelect: startDetecting },
      { type: "separator" },
      ...(albumChoices ? [{ id: "add-to-album", label: t("menuAddToAlbum"), submenu: albumChoices }] : []),
      ...(actions.onShare && !photo.shared && editable ? [{ id: "share", label: t("menuSharePhoto"), onSelect: () => { setPlaying(false); actions.onShare?.(photo); } }] : []),
      ...(actions.onSaveToGallery && photo.shared ? [{ id: "save-to-gallery", label: t("menuSaveToGallery"), onSelect: () => actions.onSaveToGallery?.(photo) }] : []),
      ...(actions.onArchive && !photo.shared ? [{ id: "archive", label: t("menuMoveToArchive"), onSelect: () => { setPlaying(false); actions.onArchive?.(photo); } }] : []),
      ...(actions.onRestore ? [{ id: "restore", label: t("menuRestore"), onSelect: () => { setPlaying(false); actions.onRestore?.(photo); } }] : []),
      ...(openChoices ? [{ id: "open", label: t("menuOpenIn"), submenu: openChoices }] : []),
      { type: "separator" },
      { id: "slideshow", label: playing ? t("menuPauseSlideshow") : t("menuPlaySlideshow"), onSelect: () => setPlaying((value) => !value) },
      { id: "save", label: t("menuSavePhoto"), submenu: saveChoices() },
      { id: "copy", label: t("menuCopyImage"), onSelect: copyPhoto },
      { id: "full-screen", label: fullscreen ? t("menuExitFullScreen") : t("menuFullScreen"), onSelect: toggleFullscreen },
      ...(chat ? [{ id: "ask-ai", label: t("menuAskAi"), type: "checkbox" as const, checked: chat.open, onSelect: toggleChat }] : []),
      { id: "info", label: t("menuInfo"), type: "checkbox", checked: infoOpen, onSelect: () => setInfoOpen((open) => !open) },
      { type: "separator" },
      ...(photo.prompt && actions.onReusePrompt ? [{ id: "reuse-prompt", label: t("menuReusePrompt"), onSelect: () => actions.onReusePrompt?.(photo) }] : []),
      ...(actions.onUseAsReference ? [{ id: "use-as-reference", label: t("menuUseAsReference"), onSelect: () => actions.onUseAsReference?.(photo) }] : []),
      ...(photo.edited && actions.onRevert && !locked ? [{ id: "revert", label: t("menuRevertToOriginal"), onSelect: revertPhoto }] : []),
      ...(!locked ? [{ type: "separator" as const }, { id: "delete", label: t("menuDelete"), onSelect: () => actions.onDelete(photo) }] : []),
    ];
    return menusBlocked ? disabledMenu(items) : items;
  });

  if (!photo) return null;
  const photoAlbums = albums.filter((album) => photo.albumIds.includes(album.id));
  const percent = Math.round(transform.scale * fitScale * 100);
  const editable = !photo.name.toLowerCase().endsWith(".svg");

  const viewer = <div ref={rootRef} role="dialog" aria-modal={!chatOpen} aria-label={photo.name} data-command-scope="3" className="fixed inset-0 z-40 flex flex-col bg-neutral-950 text-white">
    {editing ? <PhotoEditor src={galleryRawUrl(photo)} onCancel={() => setEditing(false)} onSave={async (edits, mode) => {
      const result = await apiRequest<{ id: string; gallery: GalleryContents }>("/api/gallery/photos/edit", { method: "POST", body: JSON.stringify({ id: photo.id, edits, mode }) });
      setEditing(false);
      setTransform(FIT);
      actions.onEdited?.(result);
      setNotice(mode === "copy" ? t("savedAsCopy") : t("savedRevertable"));
    }} /> : <>
      <header className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-2" data-command-toolbar={photoGroup} data-command-toolbar-id="photo">
        <button className={toolButton} aria-label={t("backToGallery")} title={t("backTitle")} onClick={onClose}><ArrowLeft className="h-5 w-5" /></button>
        <div className="mr-auto min-w-0 px-2">
          <p className="truncate text-sm font-medium">{format.dateTime(new Date(photo.createdAt), { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</p>
          <p className="truncate text-xs text-white/50">{t("subtitle", { time: format.dateTime(new Date(photo.createdAt), { hour: "numeric", minute: "2-digit" }), current: index + 1, total: photos.length })}</p>
        </div>
        <div className="flex items-center rounded-lg bg-white/5" role="group" aria-label={t("zoomGroup")}>
          <button className={toolButton} aria-label={t("zoomOut")} title={t("zoomOutTitle")} disabled={transform.scale <= 1} onClick={() => zoomBy(1 / 1.5)}><Minus className="h-4 w-4" /></button>
          {/* The palette lists Fit to screen and Actual size on their own. */}
          <button className="min-w-14 rounded-lg px-1 text-xs tabular-nums text-white/80 hover:bg-white/10" title={transform.scale > 1 ? t("fitToScreenTitle") : t("actualSizeTitle")} data-command-skip=""
            onClick={() => { if (transform.scale > 1) setTransform(FIT); else actualSize(); }}>{transform.scale > 1 ? format.number(percent / 100, { style: "percent" }) : t("fitLabel")}</button>
          <button className={toolButton} aria-label={t("zoomIn")} title={t("zoomInTitle")} disabled={transform.scale >= MAX_ZOOM} onClick={() => zoomBy(1.5)}><Plus className="h-4 w-4" /></button>
        </div>
        <span className="mx-1 h-6 w-px bg-white/10" />
        {actions.onToggleStar && <button className={toolButton} aria-label={photo.starred ? t("unstar") : t("star")} aria-pressed={photo.starred} title={photo.starred ? t("unstarTitle") : t("starTitle")} onClick={() => actions.onToggleStar?.(photo)}>
          <Star className={`h-5 w-5 ${photo.starred ? "fill-amber-400 text-amber-400" : ""}`} />
        </button>}
        {editable && actions.onEdited && <button className={toolButton} aria-label={t("edit")} title={t("editTitle")} onClick={startEditing}><Pencil className="h-4 w-4" /></button>}
        {editable && actions.onEdited && !locked && <button className={toolButton} aria-label={t("draw")} aria-pressed={drawing} title={drawing ? t("stopDrawing") : t("drawOnPhoto")}
          onClick={toggleDrawing}><PenLine className={`h-4 w-4 ${drawing ? "text-white" : ""}`} /></button>}
        <button className={toolButton} aria-label={t("detection")} title={t("detectionTitle")}
          onClick={startDetecting}><ScanSearch className="h-4 w-4" /></button>
        {actions.onAddToAlbum && <button className={toolButton} aria-label={t("addToAlbum")} title={t("addToAlbumTitle")} onClick={(event) => actions.onAddToAlbum?.(photo, event.currentTarget)}><FolderInput className="h-4 w-4" /></button>}
        {actions.onShare && !photo.shared && editable && <button className={toolButton} aria-label={t("sharePhoto")} title={t("sharePhotoTitle")} onClick={() => { setPlaying(false); actions.onShare?.(photo); }}><UserPlus className="h-4 w-4" /></button>}
        {actions.onSaveToGallery && photo.shared && <button className={toolButton} aria-label={t("saveToGallery")} title={t("saveToGalleryTitle")} onClick={() => actions.onSaveToGallery?.(photo)}><FolderDown className="h-4 w-4" /></button>}
        {actions.onArchive && !photo.shared && <button className={toolButton} aria-label={t("moveToArchive")} title={t("moveToArchive")} onClick={() => { setPlaying(false); actions.onArchive?.(photo); }}><Lock className="h-4 w-4" /></button>}
        {actions.onRestore && <button className={toolButton} aria-label={t("restoreToGallery")} title={t("restoreToGalleryTitle")} onClick={() => { setPlaying(false); actions.onRestore?.(photo); }}><ArchiveRestore className="h-4 w-4" /></button>}
        {actions.onOpenInCanvas && <button className={toolButton} aria-label={t("openInTab")} aria-haspopup="menu" title={t("openInTabTitle")}
          onClick={(event) => { setPlaying(false); actions.onOpenInCanvas?.(photo, event.currentTarget); }}><AppWindow className="h-4 w-4" /></button>}
        <button className={toolButton} aria-label={playing ? t("pauseSlideshow") : t("playSlideshow")} title={playing ? t("pauseSlideshowTitle") : t("slideshowTitle")} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button className={toolButton} aria-label={t("savePhoto")} aria-haspopup="menu" title={t("savePhotoTitle")}
          onClick={(event) => { setPlaying(false); void openImageSaveMenu(event.currentTarget, "notebook", { name: photo.name, src: rawUrl(photo) }); }}><Download className="h-4 w-4" /></button>
        <button className={toolButton} aria-label={t("copyImage")} title={t("copyImageTitle")} onClick={copyPhoto}><Copy className="h-4 w-4" /></button>
        <button className={toolButton} aria-label={fullscreen ? t("exitFullScreen") : t("fullScreen")} title={t("fullScreenTitle")} onClick={toggleFullscreen}>{fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</button>
        {chat && <button className={toolButton} aria-label={t("askAiAboutPhoto")} aria-pressed={chat.open} title={t("askAiAboutPhotoTitle")} onClick={toggleChat}><Sparkles className={`h-4 w-4 ${chat.open ? "text-white" : ""}`} /></button>}
        <button className={toolButton} aria-label={t("info")} aria-pressed={infoOpen} title={t("infoTitle")} onClick={() => setInfoOpen((open) => !open)}><Info className={`h-4 w-4 ${infoOpen ? "text-white" : ""}`} /></button>
        {!locked && <button className={toolButton} aria-label={t("deletePhoto")} title={photo.shared ? t("deleteSharedPhotoTitle") : t("deletePhotoTitle")} onClick={() => actions.onDelete(photo)}><Trash2 className="h-4 w-4" /></button>}
      </header>
      {drawing && <div ref={setInkToolbarSlot} className="libera-photo-ink-bar" data-command-toolbar={t("inkGroup")} />}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <ZoomableImage key={photo.id} photo={photo} rawUrl={rawUrl} transform={transform} onTransform={setTransform} onFitScale={setFitScale} overlay={photo.shared ? overlay : null}
            ink={editable && actions.onEdited && !locked ? { drawing, toolbarSlot: inkToolbarSlot, onEdited: (gallery) => { setDrawing(false); actions.onEdited?.({ id: photo.id, gallery }); setNotice(t("inkDrawn")); } } : null} />
          {hasPrevious && <button className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label={t("previousPhoto")} title={t("previousPhotoTitle")} onClick={() => go(-1)}><ChevronLeft className="h-6 w-6" /></button>}
          {hasNext && <button className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label={t("nextPhoto")} title={t("nextPhotoTitle")} onClick={() => go(1)}><ChevronRight className="h-6 w-6" /></button>}
          {notice && <div role="status" className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-black shadow-lg">{notice}</div>}
          {leaving && <div role="alertdialog" aria-label={t("unsavedInk")} className="libera-photo-ink-notice">
            <span>{leaveError || t("unsavedInkMessage")}</span>
            <button type="button" onClick={() => {
              void pendingSaves.save(`gallery:${photo.id}`).then(() => { const action = leaving; setLeaving(null); action(); }, (error: unknown) => setLeaveError(error instanceof Error ? error.message : t("inkSaveFailed")));
            }}><Save aria-hidden className="h-3.5 w-3.5" />{tCommon("save")}</button>
            <button type="button" onClick={() => { pendingSaves.discard(`gallery:${photo.id}`); const action = leaving; setLeaving(null); action(); }}><Trash2 aria-hidden className="h-3.5 w-3.5" />{t("discard")}</button>
            <button type="button" onClick={() => setLeaving(null)}><PenLine aria-hidden className="h-3.5 w-3.5" />{t("keepDrawing")}</button>
          </div>}
        </div>
        {infoOpen && <aside ref={infoRef} onScroll={(event) => {
          infoScrollRef.current = event.currentTarget.scrollTop;
          infoPositionsRef.current.set(photo.id, infoScrollRef.current);
          if (infoPositionsRef.current.size > 64) infoPositionsRef.current.delete(infoPositionsRef.current.keys().next().value!);
          viewStatePendingRef.current = true;
          reportViewState();
        }} className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-l border-white/10 p-5 max-md:hidden">
          <h2 className="text-sm font-semibold">{t("infoHeading")}</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("created")}</dt><dd>{format.dateTime(new Date(photo.createdAt), { dateStyle: "medium", timeStyle: "medium" })}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("details")}</dt><dd>{t("detailsLine", { hasDimensions: photo.width && photo.height ? "yes" : "no", width: String(photo.width ?? 0), height: String(photo.height ?? 0), size: formatBytes(photo.size, locale), edited: photo.edited ? "yes" : "no" })}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("albums")}</dt><dd className="mt-1 flex flex-wrap gap-1.5">
              {photoAlbums.length ? photoAlbums.map((album) => <span key={album.id} className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs">{album.name}</span>) : <span className="text-white/60">{t("notInAlbum")}</span>}
            </dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("onDisk")}</dt><dd className="break-all text-white/80">gallery/{photo.path}</dd></div>
            {photo.model && <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("model")}</dt><dd className="break-all">{photo.model}</dd></div>}
            {photo.prompt && <div><dt className="text-xs uppercase tracking-wider text-white/50">{t("prompt")}</dt><dd className="whitespace-pre-wrap leading-relaxed">{photo.prompt}</dd></div>}
          </dl>
          {photo.shared && sharedDetails?.(photo, setOverlay)}
          <div className="flex flex-col gap-2">
            {photo.prompt && actions.onReusePrompt && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onReusePrompt?.(photo)}><Sparkles className="h-4 w-4" />{t("reusePromptButton")}</button>}
            {actions.onUseAsReference && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onUseAsReference?.(photo)}><ImagePlus className="h-4 w-4" />{t("useAsReferenceButton")}</button>}
            {photo.edited && actions.onRevert && !locked && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
              onClick={revertPhoto}><RotateCcw className="h-4 w-4" />{t("revertToOriginalButton")}</button>}
          </div>
        </aside>}
      </div>
    </>}
    {detecting && <DetectionTool src={rawUrl(photo)} name={photo.name} source={`gallery/${photo.path}`} onClose={() => setDetecting(false)} />}
  </div>;
  return createPortal(viewer, document.body);
}
