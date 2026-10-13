"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  ImagePlus,
  Info,
  Maximize,
  Minimize,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { PhotoEditor } from "@/components/libera/photo-editor";
import { galleryRawUrl, type GalleryAlbum, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

const MAX_ZOOM = 8;
const SLIDESHOW_MS = 4000;
const toolButton = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/85 hover:bg-white/10 hover:text-white disabled:opacity-40";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function copyImage(url: string) {
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

type Transform = { scale: number; x: number; y: number };
const FIT: Transform = { scale: 1, x: 0, y: 0 };

/** Zoomable, pannable photo. `scale` 1 fits the photo in the stage. */
function ZoomableImage({ photo, transform, onTransform, onFitScale }: {
  photo: GalleryPhoto;
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
      <img src={galleryRawUrl(photo, true)} alt="" aria-hidden className="absolute max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] object-contain blur-[2px]" />}
    {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
    <img ref={imageRef} key={`${photo.id}-${photo.updatedAt}`} src={galleryRawUrl(photo)} alt={photo.prompt ?? photo.name} draggable={false}
      className={`max-h-[calc(100%-3rem)] max-w-[calc(100%-3rem)] select-none object-contain transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
      style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transition: dragging ? "none" : "transform 80ms ease-out, opacity 150ms" }}
      onLoad={() => { setLoaded(true); reportFit(); }} />
  </div>;
}

export type PhotoViewerActions = {
  onToggleStar: (photo: GalleryPhoto) => void;
  onDelete: (photo: GalleryPhoto) => void;
  onAddToAlbum: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  /** Offers to open the photo as an editor tab, alone or beside the focused panel. */
  onOpenInCanvas?: (photo: GalleryPhoto, anchor: HTMLElement) => void;
  onRevert: (photo: GalleryPhoto) => Promise<void>;
  onReusePrompt: (photo: GalleryPhoto) => void;
  onUseAsReference: (photo: GalleryPhoto) => void;
  onEdited: (result: { id: string; gallery: GalleryContents }) => void;
};

export function PhotoViewer({ photos, index, albums, onNavigate, onClose, actions }: {
  photos: GalleryPhoto[];
  index: number;
  albums: GalleryAlbum[];
  onNavigate: (photo: GalleryPhoto) => void;
  onClose: () => void;
  actions: PhotoViewerActions;
}) {
  const photo = photos[index];
  const [transform, setTransform] = useState<Transform>(FIT);
  const [fitScale, setFitScale] = useState(1);
  const [infoOpen, setInfoOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const hasPrevious = index > 0;
  const hasNext = index < photos.length - 1;

  const go = useCallback((offset: number) => {
    const next = photos[index + offset];
    if (next) { onNavigate(next); setTransform(FIT); }
  }, [index, onNavigate, photos]);

  // Preload neighbors so moving through photos feels instant.
  useEffect(() => {
    for (const neighbor of [photos[index - 1], photos[index + 1]]) if (neighbor) new Image().src = galleryRawUrl(neighbor);
  }, [index, photos]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (hasNext) go(1);
      else if (photos[0]) { onNavigate(photos[0]); setTransform(FIT); }
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

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => undefined);
  }

  function zoomBy(factor: number) {
    setTransform((current) => (current.scale * factor <= 1 ? FIT : { ...current, scale: Math.min(MAX_ZOOM, current.scale * factor) }));
  }

  useEffect(() => {
    if (editing) return;
    function handleKey(event: KeyboardEvent) {
      if (document.querySelector(".libera-dialog") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [role=menu]")) return;
      const key = event.key;
      if (key === "Escape") { if (!document.fullscreenElement) onClose(); }
      else if (key === "ArrowLeft") go(-1);
      else if (key === "ArrowRight") go(1);
      else if (key === "+" || key === "=") zoomBy(1.5);
      else if (key === "-") zoomBy(1 / 1.5);
      else if (key === "0") setTransform(FIT);
      else if (key === "s" || key === "S") actions.onToggleStar(photo);
      else if ((key === "e" || key === "E") && !photo.name.toLowerCase().endsWith(".svg")) setEditing(true);
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

  const viewer = <div ref={rootRef} role="dialog" aria-modal="true" aria-label={photo.name} className="fixed inset-0 z-40 flex flex-col bg-neutral-950 text-white">
    {editing ? <PhotoEditor photo={photo} onCancel={() => setEditing(false)} onSaved={(result, mode) => {
      setEditing(false);
      setTransform(FIT);
      actions.onEdited(result);
      setNotice(mode === "copy" ? "Saved as a copy" : "Saved. You can revert to the original from Info.");
    }} /> : <>
      <header className="flex items-center gap-1 px-2 py-2">
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
        <button className={toolButton} aria-label={photo.starred ? "Unstar" : "Star"} aria-pressed={photo.starred} title={photo.starred ? "Unstar (S)" : "Star (S)"} onClick={() => actions.onToggleStar(photo)}>
          <Star className={`h-5 w-5 ${photo.starred ? "fill-amber-400 text-amber-400" : ""}`} />
        </button>
        {editable && <button className={toolButton} aria-label="Edit" title="Edit: crop, rotate, adjust (E)" onClick={() => { setPlaying(false); setEditing(true); }}><Pencil className="h-4 w-4" /></button>}
        <button className={toolButton} aria-label="Add to album" title="Add to album" onClick={(event) => actions.onAddToAlbum(photo, event.currentTarget)}><FolderInput className="h-4 w-4" /></button>
        {actions.onOpenInCanvas && <button className={toolButton} aria-label="Open in tab" aria-haspopup="menu" title="Open in an editor tab, or beside the current one"
          onClick={(event) => { setPlaying(false); actions.onOpenInCanvas?.(photo, event.currentTarget); }}><AppWindow className="h-4 w-4" /></button>}
        <button className={toolButton} aria-label={playing ? "Pause slideshow" : "Play slideshow"} title={playing ? "Pause slideshow (Space)" : "Slideshow (Space)"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <a className={toolButton} aria-label="Download" title="Download" href={galleryRawUrl(photo)} download={photo.name}><Download className="h-4 w-4" /></a>
        <button className={toolButton} aria-label="Copy image" title="Copy image" onClick={() => copyImage(galleryRawUrl(photo)).then(() => setNotice("Copied to the clipboard"), () => setNotice("Could not copy this photo"))}><Copy className="h-4 w-4" /></button>
        <button className={toolButton} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title="Full screen (F)" onClick={toggleFullscreen}>{fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</button>
        <button className={toolButton} aria-label="Info" aria-pressed={infoOpen} title="Info (I)" onClick={() => setInfoOpen((open) => !open)}><Info className={`h-4 w-4 ${infoOpen ? "text-white" : ""}`} /></button>
        <button className={toolButton} aria-label="Delete photo" title="Delete (Del)" onClick={() => actions.onDelete(photo)}><Trash2 className="h-4 w-4" /></button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <ZoomableImage key={photo.id} photo={photo} transform={transform} onTransform={setTransform} onFitScale={setFitScale} />
          {hasPrevious && <button className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label="Previous photo" title="Previous (←)" onClick={() => go(-1)}><ChevronLeft className="h-6 w-6" /></button>}
          {hasNext && <button className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60" aria-label="Next photo" title="Next (→)" onClick={() => go(1)}><ChevronRight className="h-6 w-6" /></button>}
          {notice && <div role="status" className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-black shadow-lg">{notice}</div>}
        </div>
        {infoOpen && <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-l border-white/10 p-5 max-md:hidden">
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
            {photo.prompt && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onReusePrompt(photo)}><Sparkles className="h-4 w-4" />Reuse prompt</button>}
            <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => actions.onUseAsReference(photo)}><ImagePlus className="h-4 w-4" />Use as reference</button>
            {photo.edited && <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
              onClick={() => actions.onRevert(photo).then(() => { setTransform(FIT); setNotice("Reverted to the original"); }, () => setNotice("Could not revert this photo"))}><RotateCcw className="h-4 w-4" />Revert to original</button>}
          </div>
        </aside>}
      </div>
    </>}
  </div>;
  return createPortal(viewer, document.body);
}
