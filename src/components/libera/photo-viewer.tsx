"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ArchiveRestore,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  ImagePlus,
  Info,
  Lock,
  Maximize,
  Minimize,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { DetectionTool } from "@/components/libera/detection/detection-tool";
import { openImageSaveMenu, subscribeImageSaved } from "@/components/libera/image-save";
import { PhotoEditor } from "@/components/libera/photo-editor";
import { galleryRawUrl, type GalleryAlbum, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

const MAX_ZOOM = 8;
const SLIDESHOW_MS = 4000;
const toolButton = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/85 hover:bg-white/10 hover:text-white disabled:opacity-40";

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Copies a photo to the clipboard, as PNG. */
export async function copyImage(url: string) {
  const blob = await fetch(url).then((response) => {
    if (!response.ok) throw new Error("Could not load the photo.");
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
    png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Could not copy the photo."))), "image/png"));
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export type PhotoViewerViewState = { transform: Transform; infoOpen: boolean; infoScrollTop: number };

type Transform = { scale: number; x: number; y: number };
const FIT: Transform = { scale: 1, x: 0, y: 0 };

/** Zoomable, pannable photo. `scale` 1 fits the photo in the stage. */
function ZoomableImage({ photo, rawUrl, transform, onTransform, onFitScale }: {
  photo: GalleryPhoto;
  rawUrl: PhotoUrl;
  transform: Transform;
  onTransform: (transform: Transform) => void;
  onFitScale: (fitScale: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; start: Transform } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);

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
    if (image?.naturalWidth) onFitScale(image.offsetWidth / image.naturalWidth);
  }, [onFitScale]);

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
    onDoubleClick={(event) => (transform.scale > 1 ? onTransform(FIT) : zoomAt(2.5, event.clientX, event.clientY))}>
    {/* The thumbnail shows at once while the full photo loads. */}
    {!loaded && /* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */
      <img src={rawUrl(photo, true)} alt="" aria-hidden className="absolute max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] object-contain blur-[2px]" />}
    {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
    <img ref={imageRef} key={`${photo.id}-${photo.updatedAt}`} src={rawUrl(photo)} alt={photo.prompt ?? photo.name} draggable={false}
      className={`max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] select-none object-contain transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
      style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transition: dragging ? "none" : "transform 80ms ease-out, opacity 150ms" }}
      onLoad={() => { setLoaded(true); reportFit(); }} />
  </div>;
}

/** Builds a photo's URL; archived photos are served from the archive's own route. */
type PhotoUrl = (photo: GalleryPhoto, thumbnail?: boolean) => string;

/** Actions left out are not offered, as in the Protected Archive. */
export type PhotoViewerActions = {
  onToggleStar?: (photo: GalleryPhoto) => void;
  onDelete: (photo: GalleryPhoto) => void;
  onAddToAlbum?: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  /** Offers to open the photo as an editor tab, alone or beside the focused panel. */
  onOpenInCanvas?: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  onRevert?: (photo: GalleryPhoto) => Promise<void>;
  onReusePrompt?: (photo: GalleryPhoto) => void;
  onUseAsReference?: (photo: GalleryPhoto) => void;
  onEdited?: (result: { id: string; gallery: GalleryContents }) => void;
  /** Sends the photo to the Protected Archive. */
  onArchive?: (photo: GalleryPhoto) => void;
  /** Puts an archived photo back in the gallery. */
  onRestore?: (photo: GalleryPhoto) => void;
};

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

export function PhotoViewer({ photos, index, albums, onNavigate, onClose, actions, chat, initialViewState, onViewStateChange, rawUrl = galleryRawUrl }: {
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
}) {
  const photo = photos[index];
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
  const [detecting, setDetecting] = useState(false);
  const [playing, setPlaying] = useState(false);
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
  useLayoutEffect(() => {
    onViewStateChange?.({ transform, infoOpen, infoScrollTop: infoScrollRef.current });
  }, [transform, infoOpen, onViewStateChange]);
  const hasPrevious = index > 0;
  const hasNext = index < photos.length - 1;

  const go = useCallback((offset: number) => {
    const next = photos[index + offset];
    if (next) onNavigate(next);
  }, [index, onNavigate, photos]);

  // Preload neighbors so moving through photos feels instant.
  useEffect(() => {
    for (const neighbor of [photos[index - 1], photos[index + 1]]) if (neighbor) new Image().src = rawUrl(neighbor);
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
      else if (key === "Delete" || key === "Backspace") actions.onDelete(photo);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
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
      setNotice(mode === "copy" ? "Saved as a copy" : "Saved. You can revert to the original from Info.");
    }} /> : <>
      <header className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-2" data-command-toolbar="Photo">
        <button className={toolButton} aria-label="Back to gallery" title="Back (Esc)" onClick={onClose}><ArrowLeft className="h-5 w-5" /></button>
        <div className="mr-auto min-w-0 px-2">
          <p className="truncate text-sm font-medium">{new Date(photo.createdAt).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</p>
          <p className="truncate text-xs text-white/50">{new Date(photo.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {index + 1} of {photos.length}</p>
        </div>
        <div className="flex items-center rounded-lg bg-white/5" role="group" aria-label="Zoom">
          <button className={toolButton} aria-label="Zoom out" title="Zoom out (−)" disabled={transform.scale <= 1} onClick={() => zoomBy(1 / 1.5)}><Minus className="h-4 w-4" /></button>
          <button className="min-w-14 rounded-lg px-1 text-xs tabular-nums text-white/80 hover:bg-white/10" title={transform.scale > 1 ? "Fit to screen (0)" : "Actual size"}
            onClick={() => setTransform(transform.scale > 1 ? FIT : { scale: Math.min(MAX_ZOOM, Math.max(1, 1 / fitScale)), x: 0, y: 0 })}>{transform.scale > 1 ? `${percent}%` : "Fit"}</button>
          <button className={toolButton} aria-label="Zoom in" title="Zoom in (+)" disabled={transform.scale >= MAX_ZOOM} onClick={() => zoomBy(1.5)}><Plus className="h-4 w-4" /></button>
        </div>
        <span className="mx-1 h-6 w-px bg-white/10" />
        {actions.onToggleStar && <button className={toolButton} aria-label={photo.starred ? "Unstar" : "Star"} aria-pressed={photo.starred} title={photo.starred ? "Unstar (S)" : "Star (S)"} onClick={() => actions.onToggleStar?.(photo)}>
          <Star className={`h-5 w-5 ${photo.starred ? "fill-amber-400 text-amber-400" : ""}`} />
        </button>}
        {editable && actions.onEdited && <button className={toolButton} aria-label="Edit" title="Edit: crop, rotate, adjust (E)" onClick={() => { setPlaying(false); setEditing(true); }}><Pencil className="h-4 w-4" /></button>}
        <button className={toolButton} aria-label="Detection and Segmentation" title="Detection and Segmentation: find, outline and count objects"
          onClick={() => { setPlaying(false); if (document.fullscreenElement) void document.exitFullscreen(); setDetecting(true); }}><ScanSearch className="h-4 w-4" /></button>
        {actions.onAddToAlbum && <button className={toolButton} aria-label="Add to album" title="Add to album" onClick={(event) => actions.onAddToAlbum?.(photo, event.currentTarget)}><FolderInput className="h-4 w-4" /></button>}
        {actions.onArchive && <button className={toolButton} aria-label="Move to Protected Archive" title="Move to Protected Archive" onClick={() => { setPlaying(false); actions.onArchive?.(photo); }}><Lock className="h-4 w-4" /></button>}
        {actions.onRestore && <button className={toolButton} aria-label="Restore to gallery" title="Restore to gallery" onClick={() => { setPlaying(false); actions.onRestore?.(photo); }}><ArchiveRestore className="h-4 w-4" /></button>}
        {actions.onOpenInCanvas && <button className={toolButton} aria-label="Open in tab" aria-haspopup="menu" title="Open in an editor tab, or beside the current one"
          onClick={(event) => { setPlaying(false); actions.onOpenInCanvas?.(photo, event.currentTarget); }}><AppWindow className="h-4 w-4" /></button>}
        <button className={toolButton} aria-label={playing ? "Pause slideshow" : "Play slideshow"} title={playing ? "Pause slideshow (Space)" : "Slideshow (Space)"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button className={toolButton} aria-label="Save photo" aria-haspopup="menu" title="Save to computer or a notebook folder"
          onClick={(event) => { setPlaying(false); void openImageSaveMenu(event.currentTarget, "notebook", { name: photo.name, src: rawUrl(photo) }); }}><Download className="h-4 w-4" /></button>
        <button className={toolButton} aria-label="Copy image" title="Copy image" onClick={() => copyImage(rawUrl(photo)).then(() => setNotice("Copied to the clipboard"), () => setNotice("Could not copy this photo"))}><Copy className="h-4 w-4" /></button>
        <button className={toolButton} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title="Full screen (F)" onClick={toggleFullscreen}>{fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</button>
        {chat && <button className={toolButton} aria-label="Ask AI about this photo" aria-pressed={chat.open} title="Ask AI about this photo (⌘/Ctrl+Shift+B)" onClick={toggleChat}><Sparkles className={`h-4 w-4 ${chat.open ? "text-white" : ""}`} /></button>}
        <button className={toolButton} aria-label="Info" aria-pressed={infoOpen} title="Info (I)" onClick={() => setInfoOpen((open) => !open)}><Info className={`h-4 w-4 ${infoOpen ? "text-white" : ""}`} /></button>
        <button className={toolButton} aria-label="Delete photo" title="Delete (Del)" onClick={() => actions.onDelete(photo)}><Trash2 className="h-4 w-4" /></button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <ZoomableImage key={photo.id} photo={photo} rawUrl={rawUrl} transform={transform} onTransform={setTransform} onFitScale={setFitScale} />
          {hasPrevious && <button className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label="Previous photo" title="Previous (←)" onClick={() => go(-1)}><ChevronLeft className="h-6 w-6" /></button>}
          {hasNext && <button className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label="Next photo" title="Next (→)" onClick={() => go(1)}><ChevronRight className="h-6 w-6" /></button>}
          {notice && <div role="status" className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-black shadow-lg">{notice}</div>}
        </div>
        {infoOpen && <aside ref={infoRef} onScroll={(event) => {
          infoScrollRef.current = event.currentTarget.scrollTop;
          infoPositionsRef.current.set(photo.id, infoScrollRef.current);
          onViewStateChange?.({ transform, infoOpen, infoScrollTop: infoScrollRef.current });
        }} className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-l border-white/10 p-5 max-md:hidden">
          <h2 className="text-sm font-semibold">Info</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs uppercase tracking-wider text-white/50">Created</dt><dd>{new Date(photo.createdAt).toLocaleString()}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">Details</dt><dd>{photo.width && photo.height ? `${photo.width} × ${photo.height} · ` : ""}{formatBytes(photo.size)}{photo.edited ? " · Edited" : ""}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">Albums</dt><dd className="mt-1 flex flex-wrap gap-1.5">
              {photoAlbums.length ? photoAlbums.map((album) => <span key={album.id} className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs">{album.name}</span>) : <span className="text-white/60">Not in an album</span>}
            </dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-white/50">On disk</dt><dd className="break-all text-white/80">gallery/{photo.path}</dd></div>
            {photo.model && <div><dt className="text-xs uppercase tracking-wider text-white/50">Model</dt><dd className="break-all">{photo.model}</dd></div>}
            {photo.prompt && <div><dt className="text-xs uppercase tracking-wider text-white/50">Prompt</dt><dd className="whitespace-pre-wrap leading-relaxed">{photo.prompt}</dd></div>}
          </dl>
          <div className="flex flex-col gap-2">
            {photo.prompt && actions.onReusePrompt && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onReusePrompt?.(photo)}><Sparkles className="h-4 w-4" />Reuse prompt</button>}
            {actions.onUseAsReference && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onUseAsReference?.(photo)}><ImagePlus className="h-4 w-4" />Use as reference</button>}
            {photo.edited && actions.onRevert && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
              onClick={() => actions.onRevert?.(photo).then(() => { setTransform(FIT); setNotice("Reverted to the original"); }, () => setNotice("Could not revert this photo"))}><RotateCcw className="h-4 w-4" />Revert to original</button>}
          </div>
        </aside>}
      </div>
    </>}
    {detecting && <DetectionTool src={rawUrl(photo)} name={photo.name} source={`gallery/${photo.path}`} onClose={() => setDetecting(false)} />}
  </div>;
  return createPortal(viewer, document.body);
}
