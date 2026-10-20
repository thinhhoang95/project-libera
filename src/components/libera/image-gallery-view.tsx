"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowUpWideNarrow,
  AppWindow,
  ArchiveRestore,
  Check,
  FolderInput,
  FolderMinus,
  FolderPlus,
  ImagePlus,
  Images,
  LayoutGrid,
  Lock,
  PanelBottom,
  PanelRight,
  Pencil,
  Plus,
  Rows3,
  Sparkles,
  Star,
  StarOff,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { ArchiveUnlock, moveToArchive, useProtectedArchive } from "@/components/libera/gallery-archive";
import { applyGallery, refreshGallery, reusePrompt, sendToReferences, useGallery } from "@/components/libera/gallery-store";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { PhotoViewer, type PhotoViewerChat, type PhotoViewerViewState } from "@/components/libera/photo-viewer";
import type { GalleryTabPlacement } from "@/components/libera/gallery-tabs";
import {
  DEFAULT_GALLERY_ZOOM,
  GALLERY_GAP,
  GALLERY_ZOOM_LEVELS,
  justifiedRows,
  photoRatio,
  type GalleryLayoutMode,
} from "@/lib/gallery-layout";
import { archiveRawUrl, galleryRawUrl, type GalleryAlbum, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

type GalleryView = { kind: "photos" } | { kind: "starred" } | { kind: "albums" } | { kind: "album"; id: string } | { kind: "archive" };

// The gallery unmounts while another left panel is open. Remember where the
// reader was, so coming back lands on the same view, photo and scroll offset.
const session = {
  view: { kind: "photos" } as GalleryView, viewingId: null as string | null,
  scroll: new Map<string, number>(), photoViews: new Map<string, PhotoViewerViewState>(),
  selection: new Set<string>(), anchor: null as string | null,
};
type SortOrder = "newest" | "oldest";
type LayoutPreferences = { mode: GalleryLayoutMode; zoom: number };
type Dialog =
  | { kind: "create-album"; photoIds: string[] }
  | { kind: "rename-album"; album: GalleryAlbum }
  | { kind: "delete-album"; album: GalleryAlbum }
  | { kind: "delete-photos"; ids: string[]; archived?: boolean };
type AlbumMenuState = { photoIds: string[]; x: number; y: number; excludeAlbumId?: string };
type OpenMenuState = { photo: GalleryPhoto; x: number; y: number };
/** A right-click on a photo; it acts on the whole selection when the photo is part of it. */
type PhotoMenuState = { photo: GalleryPhoto; photoIds: string[]; x: number; y: number };

const UPLOAD_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg)$/i;
const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg";
// Requests stay small so a large drop shows progress and one bad batch costs little.
const UPLOAD_BATCH_FILES = 8;
const UPLOAD_BATCH_BYTES = 48 * 1024 * 1024;
type UploadResult = { added: string[]; failed: Array<{ name: string; error: string }>; gallery: GalleryContents };

function hasFiles(event: { dataTransfer: DataTransfer | null }) {
  return Boolean(event.dataTransfer?.types.includes("Files"));
}

function uploadBatches(files: File[]) {
  const batches: File[][] = [];
  let bytes = 0;
  for (const file of files) {
    const last = batches.at(-1);
    if (!last || last.length >= UPLOAD_BATCH_FILES || bytes + file.size > UPLOAD_BATCH_BYTES) {
      batches.push([file]);
      bytes = file.size;
    } else {
      last.push(file);
      bytes += file.size;
    }
  }
  return batches;
}

const SORT_STORAGE_KEY = "libera.gallery.sort";
const LAYOUT_STORAGE_KEY = "libera.gallery.layout";
const iconButton = "libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-40";
const toolbarButton = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-muted disabled:opacity-50";
const secondary = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50";
const primary = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const destructive = "rounded-lg bg-destructive px-4 py-2 text-sm text-white disabled:opacity-50";

function readStored<T>(key: string, parse: (value: string) => T | null, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return (value ? parse(value) : null) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function clampZoom(zoom: number) {
  return Math.min(GALLERY_ZOOM_LEVELS.length - 1, Math.max(0, Math.round(zoom)));
}

function parseLayout(value: string): LayoutPreferences | null {
  const parsed = JSON.parse(value) as Partial<LayoutPreferences>;
  if ((parsed.mode !== "grid" && parsed.mode !== "justified") || typeof parsed.zoom !== "number") return null;
  return { mode: parsed.mode, zoom: clampZoom(parsed.zoom) };
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return "Today";
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function groupByDay(photos: GalleryPhoto[]) {
  const groups: Array<{ key: string; label: string; photos: GalleryPhoto[] }> = [];
  for (const photo of photos) {
    const date = new Date(photo.createdAt);
    const key = dayKey(date);
    const last = groups.at(-1);
    if (last?.key === key) last.photos.push(photo);
    else groups.push({ key, label: dayLabel(date), photos: [photo] });
  }
  return groups;
}

async function galleryRequest<T extends { gallery?: GalleryContents }>(url: string, method: string, body: unknown) {
  const response = await apiRequest<T>(url, { method, body: JSON.stringify(body) });
  applyGallery(response.gallery);
  return response;
}

function menuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(8, Math.min(rect.left, window.innerWidth - 240)), y: rect.bottom + 4 };
}

export function ImageGalleryView({ onOpenInCanvas, chat, onViewingPhotoChange }: {
  /** Opens a photo as an editor tab, or beside the focused panel, like a notebook image. */
  onOpenInCanvas?: (photo: GalleryPhoto, placement: GalleryTabPlacement) => void;
  /** The app's AI chat panel, which the photo viewer can open beside the photo. */
  chat?: PhotoViewerChat;
  /** Reports the photo open in the viewer so the AI chat can take it as context. */
  onViewingPhotoChange?: (photo: GalleryPhoto | null) => void;
} = {}) {
  const gallery = useGallery();
  const [requestedView, setView] = useState<GalleryView>(() => session.view);
  const [sort, setSort] = useState<SortOrder>(() => readStored(SORT_STORAGE_KEY, (value) => (value === "oldest" ? "oldest" : value === "newest" ? "newest" : null), "newest"));
  const [layout, setLayout] = useState<LayoutPreferences>(() => readStored(LAYOUT_STORAGE_KEY, parseLayout, { mode: "grid", zoom: DEFAULT_GALLERY_ZOOM }));
  const [selection, setSelected] = useState<Set<string>>(() => new Set(session.selection));
  const [anchor, setAnchor] = useState<string | null>(() => session.anchor);
  const [viewingId, setViewingId] = useState<string | null>(() => session.viewingId);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [albumMenu, setAlbumMenu] = useState<AlbumMenuState | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenuState | null>(null);
  const [photoMenu, setPhotoMenu] = useState<PhotoMenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [dropping, setDropping] = useState(false);
  const dragDepthRef = useRef(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef(0);
  const restoredScrollRef = useRef<string | null>(null);

  useEffect(() => { void refreshGallery(); }, []);

  const contents = gallery.contents;
  const albumById = useMemo(() => new Map(contents?.albums.map((album) => [album.id, album])), [contents]);
  const photoById = useMemo(() => new Map(contents?.photos.map((photo) => [photo.id, photo])), [contents]);

  // An album deleted elsewhere falls back to the album list.
  const view: GalleryView = requestedView.kind === "album" && contents && !albumById.has(requestedView.id) ? { kind: "albums" } : requestedView;
  const currentAlbum = view.kind === "album" ? albumById.get(view.id) : undefined;
  const viewKey = view.kind === "album" ? `album:${view.id}` : view.kind;
  const inArchive = view.kind === "archive";
  const archive = useProtectedArchive(inArchive);

  const photos = useMemo(() => {
    const all = viewKey === "archive" ? archive.photos : contents?.photos ?? [];
    const albumId = viewKey.startsWith("album:") ? viewKey.slice(6) : null;
    const visible = albumId ? all.filter((photo) => photo.albumIds.includes(albumId))
      : viewKey === "starred" ? all.filter((photo) => photo.starred)
        : all;
    return [...visible].sort((first, second) => sort === "newest"
      ? second.createdAt.localeCompare(first.createdAt) || second.name.localeCompare(first.name)
      : first.createdAt.localeCompare(second.createdAt) || first.name.localeCompare(second.name));
  }, [archive.photos, contents, sort, viewKey]);
  const groups = useMemo(() => groupByDay(photos), [photos]);
  const starredCount = useMemo(() => contents?.photos.filter((photo) => photo.starred).length ?? 0, [contents]);

  // Selections for photos that left the view no longer count.
  const selected = useMemo(() => {
    const present = new Set(photos.map((photo) => photo.id));
    return new Set([...selection].filter((id) => present.has(id)));
  }, [photos, selection]);
  const selecting = selected.size > 0;
  const selectedPhotos = photos.filter((photo) => selected.has(photo.id));
  const allSelectedStarred = selectedPhotos.length > 0 && selectedPhotos.every((photo) => photo.starred);

  const viewingIndex = viewingId ? photos.findIndex((photo) => photo.id === viewingId) : -1;
  const showGrid = view.kind !== "albums" && (!inArchive || archive.unlocked);

  // The archive locks when the gallery closes, so nothing about it is remembered.
  useLayoutEffect(() => { session.view = requestedView.kind === "archive" ? { kind: "photos" } : requestedView; }, [requestedView]);
  useLayoutEffect(() => { session.viewingId = inArchive ? null : viewingId; }, [inArchive, viewingId]);
  // Protected Archive photos are never offered to the AI chat.
  const chatPhoto = !inArchive && viewingIndex >= 0 ? photos[viewingIndex] : null;
  useEffect(() => { onViewingPhotoChange?.(chatPhoto); }, [chatPhoto, onViewingPhotoChange]);
  useEffect(() => () => onViewingPhotoChange?.(null), [onViewingPhotoChange]);

  useLayoutEffect(() => {
    session.selection = inArchive ? new Set() : selection;
    session.anchor = inArchive ? null : anchor;
  }, [anchor, inArchive, selection]);
  useEffect(() => {
    if (!contents) return;
    for (const id of session.photoViews.keys()) if (!photoById.has(id)) session.photoViews.delete(id);
  }, [contents, photoById]);

  // Tile heights follow from the photos and the pane width, so the saved
  // offset can be restored as soon as both are known.
  useLayoutEffect(() => {
    if (restoredScrollRef.current === viewKey || !contents || !width) return;
    if (scrollRef.current) scrollRef.current.scrollTop = session.scroll.get(viewKey) ?? 0;
    restoredScrollRef.current = viewKey;
  }, [contents, width, viewKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const changeLayout = useCallback((change: (current: LayoutPreferences) => Partial<LayoutPreferences>) => {
    setLayout((current) => {
      const next = { ...current, ...change(current) };
      const merged = { ...next, zoom: clampZoom(next.zoom) };
      store(LAYOUT_STORAGE_KEY, JSON.stringify(merged));
      return merged;
    });
  }, []);

  // Pinch, or ⌘/Ctrl + scroll, over the grid shows fewer or more photos.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelRef.current += event.deltaY;
      if (Math.abs(wheelRef.current) < 40) return;
      const step = wheelRef.current > 0 ? -1 : 1;
      wheelRef.current = 0;
      changeLayout((current) => ({ zoom: current.zoom + step }));
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [changeLayout]);

  function openView(next: GalleryView) {
    if (scrollRef.current) session.scroll.set(viewKey, scrollRef.current.scrollTop);
    setView(next);
    setSelected(new Set());
    setAnchor(null);
    setAlbumMenu(null);
  }

  function toggleSelection(photo: GalleryPhoto, event: ReactMouseEvent | null) {
    setSelected((current) => {
      const next = new Set(current);
      if (event?.shiftKey && anchor) {
        const start = photos.findIndex((item) => item.id === anchor);
        const end = photos.findIndex((item) => item.id === photo.id);
        if (start >= 0 && end >= 0) {
          for (const item of photos.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(item.id);
          return next;
        }
      }
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      return next;
    });
    setAnchor(photo.id);
  }

  function toggleGroup(group: GalleryPhoto[]) {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = group.every((photo) => next.has(photo.id));
      for (const photo of group) {
        if (allSelected) next.delete(photo.id);
        else next.add(photo.id);
      }
      return next;
    });
  }

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      void refreshGallery();
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const setStarred = useCallback((ids: string[], starred: boolean) => run(() => galleryRequest("/api/gallery/photos", "PATCH", { ids, starred })), [run]);

  async function addToAlbum(albumId: string, photoIds: string[]) {
    setAlbumMenu(null);
    if (await run(() => galleryRequest("/api/gallery/albums/photos", "PATCH", { id: albumId, add: photoIds }))) setSelected(new Set());
  }

  async function removeFromAlbum(albumId: string, photoIds: string[]) {
    if (await run(() => galleryRequest("/api/gallery/albums/photos", "PATCH", { id: albumId, remove: photoIds }))) setSelected(new Set());
  }

  /** Photos left the view: stay in the viewer on the next photo, as photo apps do. */
  function stepPast(ids: string[]) {
    setSelected(new Set());
    if (viewingId && ids.includes(viewingId)) {
      const next = photos.slice(viewingIndex + 1).find((photo) => !ids.includes(photo.id)) ?? photos.slice(0, viewingIndex).reverse().find((photo) => !ids.includes(photo.id));
      setViewingId(next?.id ?? null);
    }
  }

  async function deletePhotos(ids: string[], archived = false) {
    const done = await run(() => (archived ? archive.remove(ids) : galleryRequest("/api/gallery/photos", "DELETE", { ids })));
    if (!done) return;
    setDialog(null);
    stepPast(ids);
  }

  const photoCount = (count: number) => `${count} ${count === 1 ? "photo" : "photos"}`;

  async function sendToArchive(ids: string[]) {
    setPhotoMenu(null);
    let archived = 0;
    if (!(await run(async () => { archived = await moveToArchive(ids); }))) return;
    stepPast(ids);
    setNotice(`Moved ${photoCount(archived)} to the Protected Archive`);
  }

  async function restoreFromArchive(ids: string[]) {
    setPhotoMenu(null);
    if (!(await run(() => archive.restore(ids)))) return;
    stepPast(ids);
    setNotice(`Restored ${photoCount(ids.length)} to the gallery`);
  }

  function openPhotoMenu(photo: GalleryPhoto, event: ReactMouseEvent) {
    event.preventDefault();
    const photoIds = selected.has(photo.id) ? [...selected] : [photo.id];
    setPhotoMenu({ photo, photoIds, x: Math.min(event.clientX, window.innerWidth - 240), y: event.clientY });
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** Adds photos from the computer to `albumId`, or to the top of the gallery. */
  async function uploadPhotos(files: File[], albumId = "") {
    if (upload) return;
    const images = files.filter((file) => UPLOAD_EXTENSIONS.test(file.name));
    const skipped = files.length - images.length;
    if (!images.length) {
      setError(files.length ? "Only PNG, JPEG, WebP, GIF and SVG images can be added to the gallery." : "");
      return;
    }
    setError("");
    setNotice("");
    setUpload({ done: 0, total: images.length });
    const failed: UploadResult["failed"] = [];
    let added = 0;
    try {
      for (const batch of uploadBatches(images)) {
        const body = new FormData();
        body.set("albumId", albumId);
        for (const file of batch) body.append("files", file, file.name);
        try {
          const result = await apiRequest<UploadResult>("/api/gallery/photos/upload", { method: "POST", body });
          applyGallery(result.gallery);
          added += result.added.length;
          failed.push(...result.failed);
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : "Could not add this photo.";
          failed.push(...batch.map((file) => ({ name: file.name, error: message })));
        }
        setUpload((current) => current && { ...current, done: current.done + batch.length });
      }
    } finally {
      setUpload(null);
    }
    const album = albumId ? albumById.get(albumId) : undefined;
    if (added) setNotice(`Added ${added} ${added === 1 ? "photo" : "photos"}${album ? ` to ${album.name}` : ""}`);
    const problems = [
      ...(failed.length ? [failed.length === 1 ? `${failed[0].name}: ${failed[0].error}` : `${failed.length} photos could not be added (${failed.slice(0, 3).map((item) => item.name).join(", ")}${failed.length > 3 ? ", …" : ""}). ${failed[0].error}`] : []),
      ...(skipped ? [`${skipped} ${skipped === 1 ? "file was" : "files were"} skipped because ${skipped === 1 ? "it is not an image" : "they are not images"}.`] : []),
    ];
    if (problems.length) setError(problems.join(" "));
  }

  // Photos dropped anywhere on the gallery go to the album being shown.
  const uploadTargetAlbum = currentAlbum;
  const dropHandlers = {
    onDragEnter(event: ReactDragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDropping(true);
    },
    onDragOver(event: ReactDragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = upload ? "none" : "copy";
    },
    onDragLeave(event: ReactDragEvent) {
      if (!hasFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDropping(false);
    },
    onDrop(event: ReactDragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDropping(false);
      void uploadPhotos([...event.dataTransfer.files], uploadTargetAlbum?.id);
    },
  };

  function openAlbumMenu(photoIds: string[], element: HTMLElement) {
    setAlbumMenu({ photoIds, ...menuPosition(element), excludeAlbumId: currentAlbum?.id });
  }

  function openInCanvas(photo: GalleryPhoto, placement: GalleryTabPlacement) {
    setOpenMenu(null);
    setPhotoMenu(null);
    setViewingId(null);
    setSelected(new Set());
    onOpenInCanvas?.(photo, placement);
  }

  // Esc clears the selection, ⌘A selects all, and + / − change the thumbnail size.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (viewingId || dialog || albumMenu || openMenu || photoMenu || !showGrid || document.querySelector(".libera-dialog, [data-libera-overlay]")) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === "Escape" && selecting) setSelected(new Set());
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && photos.length) setSelected(new Set(photos.map((photo) => photo.id)));
      else if (plain && (event.key === "+" || event.key === "=")) changeLayout((current) => ({ zoom: current.zoom + 1 }));
      else if (plain && event.key === "-") changeLayout((current) => ({ zoom: current.zoom - 1 }));
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [albumMenu, changeLayout, dialog, openMenu, photoMenu, photos, selecting, showGrid, viewingId]);

  const title = view.kind === "album" ? currentAlbum?.name ?? "" : view.kind === "albums" ? "Albums" : view.kind === "starred" ? "Starred" : inArchive ? "Protected Archive" : "Photos";
  const size = GALLERY_ZOOM_LEVELS[layout.zoom];

  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background" {...(inArchive ? {} : dropHandlers)}>
    <input ref={uploadInputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" aria-hidden tabIndex={-1}
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        void uploadPhotos(files, uploadTargetAlbum?.id);
      }} />
    <header className="libera-window-drag-region flex min-h-14 flex-wrap items-center gap-2 border-b border-border px-4 py-2" data-command-toolbar="Gallery">
      {selecting ? <>
        <button className={iconButton} aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}><X className="h-4 w-4" /></button>
        <h2 className="mr-auto text-sm font-semibold">{selected.size} selected</h2>
        {inArchive ? <button className={toolbarButton} disabled={busy} title="Put back in the gallery, in the albums they came from" onClick={() => void restoreFromArchive([...selected])}><ArchiveRestore className="h-4 w-4" />Restore</button> : <>
        <button className={toolbarButton} disabled={busy} onClick={() => void setStarred([...selected], !allSelectedStarred)}>
          {allSelectedStarred ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}{allSelectedStarred ? "Unstar" : "Star"}
        </button>
        <button className={toolbarButton} disabled={busy} aria-haspopup="menu" onClick={(event) => openAlbumMenu([...selected], event.currentTarget)}><FolderInput className="h-4 w-4" />Add to album</button>
        {currentAlbum && <button className={toolbarButton} disabled={busy} onClick={() => void removeFromAlbum(currentAlbum.id, [...selected])}><FolderMinus className="h-4 w-4" />Remove from album</button>}
        {onOpenInCanvas && selectedPhotos.length === 1 && <button className={toolbarButton} disabled={busy} aria-haspopup="menu" title="Open in an editor tab, or beside the current one"
          onClick={(event) => setOpenMenu({ photo: selectedPhotos[0], ...menuPosition(event.currentTarget) })}><AppWindow className="h-4 w-4" />Open in tab</button>}
        <button className={toolbarButton} disabled={busy} title="Send to the panel as reference photos" onClick={() => {
          sendToReferences(selectedPhotos.map((photo) => ({ name: photo.name, url: galleryRawUrl(photo) })));
          setSelected(new Set());
        }}><ImagePlus className="h-4 w-4" />Use as reference</button>
        <button className={toolbarButton} disabled={busy} title="Hide in the Protected Archive, which needs your password to open" onClick={() => void sendToArchive([...selected])}><Lock className="h-4 w-4" />Archive</button>
        </>}
        <button className={`${toolbarButton} text-destructive`} disabled={busy} onClick={() => setDialog({ kind: "delete-photos", ids: [...selected], archived: inArchive })}><Trash2 className="h-4 w-4" />Delete</button>
      </> : <>
        {view.kind === "album" && <button className={iconButton} aria-label="Back to albums" title="Back to albums" onClick={() => openView({ kind: "albums" })}><ArrowLeft className="h-4 w-4" /></button>}
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {showGrid && contents && <p className="truncate text-xs text-muted-foreground">{photos.length} {photos.length === 1 ? "photo" : "photos"}{currentAlbum ? ` · gallery/${currentAlbum.folder}` : inArchive ? " · Hidden from the gallery" : ""}</p>}
        </div>
        {view.kind !== "album" && <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Gallery sections">
          {(["photos", "starred", "albums", "archive"] as const).map((kind) => <button key={kind} role="tab" aria-selected={view.kind === kind}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition ${view.kind === kind ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => openView({ kind })}>{kind === "photos" ? "Photos" : kind === "starred" ? <><Star className="h-3 w-3" />Starred</> : kind === "albums" ? "Albums" : <><Lock className="h-3 w-3" />Archive</>}</button>)}
        </div>}
        {showGrid && <>
          <div className="flex items-center rounded-lg border border-border" role="group" aria-label="Thumbnail size">
            <button className={iconButton} aria-label="Smaller thumbnails" title="Show more photos (−)" disabled={layout.zoom === 0} onClick={() => changeLayout((current) => ({ zoom: current.zoom - 1 }))}><ZoomOut className="h-4 w-4" /></button>
            <input type="range" aria-label="Thumbnail size" className="w-20 accent-[var(--primary)] max-sm:hidden" min={0} max={GALLERY_ZOOM_LEVELS.length - 1} value={layout.zoom}
              onChange={(event) => { const zoom = Number(event.target.value); changeLayout(() => ({ zoom })); }} />
            <button className={iconButton} aria-label="Larger thumbnails" title="Show fewer, larger photos (+)" disabled={layout.zoom === GALLERY_ZOOM_LEVELS.length - 1} onClick={() => changeLayout((current) => ({ zoom: current.zoom + 1 }))}><ZoomIn className="h-4 w-4" /></button>
          </div>
          <button className={iconButton} aria-label={layout.mode === "grid" ? "Square grid. Switch to original shapes" : "Original shapes. Switch to square grid"} title={layout.mode === "grid" ? "Square grid (click for original shapes)" : "Original shapes (click for square grid)"}
            onClick={() => changeLayout((current) => ({ mode: current.mode === "grid" ? "justified" : "grid" }))}>{layout.mode === "grid" ? <LayoutGrid className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}</button>
          <button className={iconButton} aria-label={sort === "newest" ? "Newest first. Show oldest first" : "Oldest first. Show newest first"} title={sort === "newest" ? "Newest first" : "Oldest first"}
            onClick={() => { const next = sort === "newest" ? "oldest" : "newest"; setSort(next); store(SORT_STORAGE_KEY, next); }}>
            {sort === "newest" ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpWideNarrow className="h-4 w-4" />}
          </button>
        </>}
        {inArchive ? archive.unlocked && <button className={toolbarButton} title="Lock the archive now" onClick={archive.lock}><Lock className="h-4 w-4" />Lock</button>
          : <button className={toolbarButton} disabled={Boolean(upload)} title={currentAlbum ? `Add photos from your computer to ${currentAlbum.name}` : "Add photos from your computer"}
          onClick={() => uploadInputRef.current?.click()}><Upload className="h-4 w-4" />{upload ? `Adding ${upload.done} of ${upload.total}…` : "Upload"}</button>}
        {view.kind === "starred" && starredCount > 0 && <button className={toolbarButton} disabled={busy} title="Create an album from all starred photos" onClick={() => setDialog({ kind: "create-album", photoIds: photos.map((photo) => photo.id) })}><FolderPlus className="h-4 w-4" />Create album</button>}
        {currentAlbum ? <>
          <button className={iconButton} aria-label="Rename album" title="Rename album" disabled={busy} onClick={() => setDialog({ kind: "rename-album", album: currentAlbum })}><Pencil className="h-4 w-4" /></button>
          <button className={iconButton} aria-label="Delete album" title="Delete album" data-tone="destructive" disabled={busy} onClick={() => setDialog({ kind: "delete-album", album: currentAlbum })}><Trash2 className="h-4 w-4" /></button>
        </> : view.kind !== "starred" && !inArchive && <button className={iconButton} aria-label="New album" title="New album" disabled={busy} onClick={() => setDialog({ kind: "create-album", photoIds: [] })}><FolderPlus className="h-4 w-4" /></button>}
      </>}
    </header>

    {(error || gallery.error) && <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive-muted px-4 py-2 text-sm text-destructive"><span className="mr-auto">{error || gallery.error}</span><button aria-label="Dismiss" onClick={() => setError("")}><X className="h-4 w-4" /></button></div>}
    {notice && <div role="status" className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">{notice}</div>}
    {upload && <div role="status" aria-live="polite" className="sr-only">Adding {upload.done} of {upload.total} photos</div>}
    {/* Over the album list the cards stay visible, so each one can take a drop. */}
    {dropping && !upload && <div aria-hidden className={`pointer-events-none absolute z-30 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary text-sm font-medium ${view.kind === "albums" ? "inset-x-2 bottom-2 bg-card px-4 py-3 shadow-lg" : "inset-2 flex-col bg-background/85"}`}>
      <Upload className={view.kind === "albums" ? "h-5 w-5 text-primary" : "h-8 w-8 text-primary"} />
      {view.kind === "albums" ? "Drop on an album to add photos to it, or anywhere to add them to Photos" : `Drop to add photos to ${uploadTargetAlbum ? uploadTargetAlbum.name : "Photos"}`}
    </div>}

    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-4 pb-8" onScroll={(event) => { if (restoredScrollRef.current === viewKey) session.scroll.set(viewKey, event.currentTarget.scrollTop); }}>
      {!contents ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{gallery.loading ? "Opening your gallery…" : ""}</p>
        : view.kind === "albums" ? <AlbumGrid contents={contents} photoById={photoById} onOpen={(id) => openView({ kind: "album", id })} onCreate={() => setDialog({ kind: "create-album", photoIds: [] })}
          onDropFiles={(albumId, files) => { dragDepthRef.current = 0; setDropping(false); void uploadPhotos(files, albumId); }} />
        : inArchive && !archive.unlocked ? <ArchiveUnlock onUnlock={archive.unlock} />
        : !photos.length ? <EmptyPhotos view={view.kind} onUpload={view.kind === "starred" || inArchive ? undefined : () => uploadInputRef.current?.click()} />
        : groups.map((group) => {
          const allSelected = group.photos.every((photo) => selected.has(photo.id));
          return <section key={group.key} className="pt-5">
            <div className="group/day mb-2 flex items-center gap-2">
              <button type="button" aria-label={`${allSelected ? "Deselect" : "Select"} photos from ${group.label}`}
                className={`flex h-5 w-5 items-center justify-center rounded-full border transition ${allSelected ? "border-primary bg-primary text-primary-foreground" : `border-muted-foreground/50 ${selecting ? "" : "opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100"}`}`}
                onClick={() => toggleGroup(group.photos)}>{allSelected && <Check className="h-3 w-3" />}</button>
              <h3 className="text-sm font-medium">{group.label}</h3>
            </div>
            <PhotoGroup photos={group.photos} mode={layout.mode} size={size} width={width - 32} selected={selected} selecting={selecting}
              thumbnailUrl={inArchive ? archiveRawUrl : galleryRawUrl}
              onToggle={toggleSelection} onOpen={(photo) => setViewingId(photo.id)} onStar={inArchive ? undefined : (photo) => void setStarred([photo.id], !photo.starred)}
              onContextMenu={openPhotoMenu} />
          </section>;
        })}
    </div>

    {viewingIndex >= 0 && contents && <PhotoViewer initialViewState={inArchive ? undefined : session.photoViews.get(photos[viewingIndex].id)}
      onViewStateChange={inArchive ? undefined : (state) => { session.photoViews.set(photos[viewingIndex].id, state); }}
      rawUrl={inArchive ? archiveRawUrl : galleryRawUrl} photos={photos} index={viewingIndex} albums={contents.albums}
      onNavigate={(photo) => setViewingId(photo.id)} onClose={() => setViewingId(null)} chat={inArchive ? undefined : chat}
      actions={inArchive ? {
        onDelete: (photo) => setDialog({ kind: "delete-photos", ids: [photo.id], archived: true }),
        onRestore: (photo) => void restoreFromArchive([photo.id]),
      } : {
        onToggleStar: (photo) => void setStarred([photo.id], !photo.starred),
        onDelete: (photo) => setDialog({ kind: "delete-photos", ids: [photo.id] }),
        onAddToAlbum: (photo, element) => openAlbumMenu([photo.id], element),
        onOpenInCanvas: onOpenInCanvas ? (photo, element) => setOpenMenu({ photo, ...menuPosition(element) }) : undefined,
        onRevert: async (photo) => { await galleryRequest("/api/gallery/photos/edit", "POST", { id: photo.id, action: "revert" }); },
        onReusePrompt: (photo) => { reusePrompt(photo.prompt ?? ""); setViewingId(null); },
        onUseAsReference: (photo) => { sendToReferences([{ name: photo.name, url: galleryRawUrl(photo) }]); setViewingId(null); },
        onEdited: (result) => { applyGallery(result.gallery); setViewingId(result.id); },
        onArchive: (photo) => void sendToArchive([photo.id]),
      }} />}

    {albumMenu && contents && <AlbumMenu state={albumMenu} albums={contents.albums.filter((album) => album.id !== albumMenu.excludeAlbumId)}
      onClose={() => setAlbumMenu(null)}
      onPick={(albumId) => void addToAlbum(albumId, albumMenu.photoIds)}
      onCreate={() => { setDialog({ kind: "create-album", photoIds: albumMenu.photoIds }); setAlbumMenu(null); }} />}

    {photoMenu && <PhotoMenu state={photoMenu} archived={inArchive} onClose={() => setPhotoMenu(null)}
      onOpenInCanvas={onOpenInCanvas && ((placement) => openInCanvas(photoMenu.photo, placement))}
      onArchive={() => void sendToArchive(photoMenu.photoIds)}
      onRestore={() => void restoreFromArchive(photoMenu.photoIds)}
      onDelete={() => { setDialog({ kind: "delete-photos", ids: photoMenu.photoIds, archived: inArchive }); setPhotoMenu(null); }} />}

    {openMenu && <OpenInCanvasMenu state={openMenu} onClose={() => setOpenMenu(null)} onPick={(placement) => openInCanvas(openMenu.photo, placement)} />}

    {dialog?.kind === "create-album" && <AlbumNameDialog title="New album" busy={busy} error={error}
      submitLabel={dialog.photoIds.length ? `Create with ${dialog.photoIds.length} ${dialog.photoIds.length === 1 ? "photo" : "photos"}` : "Create album"}
      note={dialog.photoIds.length
        ? "A folder with the album's name is created in your gallery, and these photos are moved into it. They stay in any other albums they belong to."
        : "A folder with the album's name is created in your gallery."}
      onClose={() => { setDialog(null); setError(""); }}
      onSubmit={async (name) => {
        let created: GalleryAlbum | undefined;
        const done = await run(async () => { created = (await galleryRequest<{ album: GalleryAlbum; gallery: GalleryContents }>("/api/gallery/albums", "POST", { name, photoIds: dialog.photoIds })).album; });
        if (!done) return;
        setDialog(null);
        setSelected(new Set());
        if (created && !viewingId) openView({ kind: "album", id: created.id });
      }} />}
    {dialog?.kind === "rename-album" && <AlbumNameDialog title="Rename album" initialName={dialog.album.name} submitLabel="Rename" busy={busy} error={error}
      note="The album's folder is renamed too, unless another folder already has that name."
      onClose={() => { setDialog(null); setError(""); }}
      onSubmit={async (name) => {
        if (await run(() => galleryRequest("/api/gallery/albums", "PATCH", { id: dialog.album.id, name }))) setDialog(null);
      }} />}
    {dialog?.kind === "delete-album" && <ModalDialog open title={`Delete “${dialog.album.name}”?`} description="Only the album is removed. Its photos stay in your gallery, in the same place on disk."
      onClose={() => { if (!busy) { setDialog(null); setError(""); } }}
      footer={<>
        <button className={secondary} disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
        <button className={destructive} disabled={busy} onClick={() => void run(() => galleryRequest("/api/gallery/albums", "DELETE", { id: dialog.album.id })).then((done) => { if (done) { setDialog(null); openView({ kind: "albums" }); } })}>Delete album</button>
      </>}>
      <p className="text-sm text-muted-foreground">{dialog.album.count} {dialog.album.count === 1 ? "photo stays" : "photos stay"} in Photos and in the folder gallery/{dialog.album.folder}.</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </ModalDialog>}
    {dialog?.kind === "delete-photos" && <ModalDialog open title={dialog.ids.length === 1 ? "Delete this photo?" : `Delete ${dialog.ids.length} photos?`} description={dialog.archived ? "They are removed from the Protected Archive and from your disk. This cannot be undone." : "They are removed from your disk and from every album. This cannot be undone."}
      onClose={() => { if (!busy) { setDialog(null); setError(""); } }}
      footer={<>
        <button className={secondary} disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
        <button className={destructive} disabled={busy} autoFocus onClick={() => void deletePhotos(dialog.ids, dialog.archived)}>{busy ? "Deleting…" : "Delete"}</button>
      </>}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">Photos saved to notebook folders are not affected.</p>}
    </ModalDialog>}
  </div>;
}

function PhotoGroup({ photos, mode, size, width, selected, selecting, thumbnailUrl, onToggle, onOpen, onStar, onContextMenu }: {
  photos: GalleryPhoto[];
  mode: GalleryLayoutMode;
  size: number;
  width: number;
  selected: Set<string>;
  selecting: boolean;
  thumbnailUrl: (photo: GalleryPhoto, thumbnail: boolean) => string;
  onToggle: (photo: GalleryPhoto, event: ReactMouseEvent) => void;
  onOpen: (photo: GalleryPhoto) => void;
  onStar?: (photo: GalleryPhoto) => void;
  onContextMenu?: (photo: GalleryPhoto, event: ReactMouseEvent) => void;
}) {
  const tile = (photo: GalleryPhoto, style: CSSProperties) => <PhotoTile key={photo.id} photo={photo} thumbnail={thumbnailUrl(photo, true)} style={style} compact={size < 100}
    selected={selected.has(photo.id)} selecting={selecting}
    onToggle={(event) => onToggle(photo, event)} onOpen={() => onOpen(photo)} onStar={onStar && (() => onStar(photo))}
    onContextMenu={onContextMenu && ((event) => onContextMenu(photo, event))} />;

  if (mode === "grid" || width <= 0) {
    return <div className="grid" style={{ gap: GALLERY_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(${size}px, 100%), 1fr))` }}>
      {photos.map((photo) => tile(photo, { aspectRatio: "1 / 1" }))}
    </div>;
  }

  const ratios = photos.map((photo) => photoRatio(photo.width, photo.height));
  return <div className="flex flex-col" style={{ gap: GALLERY_GAP }}>
    {justifiedRows(ratios, width, size).map((row) => <div key={row.start} className="flex" style={{ gap: GALLERY_GAP, height: row.height }}>
      {photos.slice(row.start, row.end).map((photo, offset) => tile(photo, { width: ratios[row.start + offset] * row.height, height: row.height, flex: "none" }))}
    </div>)}
  </div>;
}

function PhotoTile({ photo, thumbnail, style, compact, selected, selecting, onToggle, onOpen, onStar, onContextMenu }: {
  photo: GalleryPhoto;
  thumbnail: string;
  style: CSSProperties;
  compact: boolean;
  selected: boolean;
  selecting: boolean;
  onToggle: (event: ReactMouseEvent) => void;
  onOpen: () => void;
  onStar?: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
}) {
  return <div className={`group/tile relative overflow-hidden ${selected ? "rounded-lg bg-primary/10" : "bg-muted"}`} style={style} onContextMenu={onContextMenu}>
    <button type="button" className="block h-full w-full" aria-label={photo.prompt ? `Open “${photo.prompt.slice(0, 80)}”` : `Open ${photo.name}`}
      onClick={(event) => (selecting || event.shiftKey || event.metaKey || event.ctrlKey ? onToggle(event) : onOpen())}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
      <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false}
        className={`h-full w-full object-cover transition-transform duration-150 ${selected ? "scale-[0.86] rounded-lg" : ""}`} />
    </button>
    <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/40 to-transparent opacity-0 transition-opacity ${selected ? "" : "group-hover/tile:opacity-100"}`} />
    <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${photo.name}`}
      className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${selected ? "border-primary bg-primary text-primary-foreground opacity-100" : `border-white/90 bg-black/10 text-transparent hover:text-white/90 ${selecting ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100"}`}`}
      onClick={(event) => { event.stopPropagation(); onToggle(event); }}>
      <Check className="h-3.5 w-3.5" />
    </button>
    {!compact && !selecting && onStar && <button type="button" aria-label={photo.starred ? `Unstar ${photo.name}` : `Star ${photo.name}`} aria-pressed={photo.starred}
      className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full text-white opacity-0 transition hover:bg-black/30 focus-visible:opacity-100 group-hover/tile:opacity-100"
      onClick={(event) => { event.stopPropagation(); onStar(); }}>
      <Star className={`h-4 w-4 drop-shadow ${photo.starred ? "fill-amber-400 text-amber-400" : ""}`} />
    </button>}
    {photo.starred && !selected && <Star aria-label="Starred" className="pointer-events-none absolute bottom-1.5 left-1.5 h-4 w-4 fill-amber-400 text-amber-400 drop-shadow" />}
  </div>;
}

function AlbumGrid({ contents, photoById, onOpen, onCreate, onDropFiles }: { contents: GalleryContents; photoById: Map<string, GalleryPhoto>; onOpen: (id: string) => void; onCreate: () => void; onDropFiles: (albumId: string, files: File[]) => void }) {
  const [dropTarget, setDropTarget] = useState("");
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 pt-5">
    <button type="button" className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onCreate}>
      <Plus className="h-6 w-6" />New album
    </button>
    {contents.albums.map((album) => {
      const cover = album.coverId ? photoById.get(album.coverId) : undefined;
      return <button key={album.id} type="button" className="group text-left" onClick={() => onOpen(album.id)}
        onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropTarget(album.id); }}
        onDragLeave={() => setDropTarget((current) => (current === album.id ? "" : current))}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget("");
          onDropFiles(album.id, [...event.dataTransfer.files]);
        }}>
        <span className={`block aspect-square overflow-hidden rounded-xl bg-muted ${dropTarget === album.id ? "ring-4 ring-primary" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
          {cover ? <img src={galleryRawUrl(cover, true)} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" />
            : <span className="flex h-full items-center justify-center text-muted-foreground"><Images className="h-8 w-8" /></span>}
        </span>
        <span className="mt-2 block truncate text-sm font-medium">{album.name}</span>
        <span className="block text-xs text-muted-foreground">{album.count} {album.count === 1 ? "item" : "items"}</span>
      </button>;
    })}
  </div>;
}

function EmptyPhotos({ view, onUpload }: { view: GalleryView["kind"]; onUpload?: () => void }) {
  const copy = view === "archive"
    ? { title: "The Protected Archive is empty", body: "Select photos, or right-click one, and choose Archive. They disappear from Photos, albums and pickers, and only show here after you enter your password." }
    : view === "starred"
    ? { title: "No starred photos yet", body: "Star the photos you love: hover a photo and click its star, or press S in the viewer. They gather here, ready to become an album." }
    : view === "album"
      ? { title: "This album is empty", body: "Select photos in Photos or Starred and choose Add to album, or generate straight into this album from the panel." }
      : { title: "Your gallery is waiting", body: "Describe an image in the panel on the left and press Generate. New images land here." };
  return <div className="mx-auto mt-16 max-w-sm text-center">
    {view === "archive" ? <Lock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /> : view === "starred" ? <Star className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /> : <Sparkles className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />}
    <p className="text-sm font-medium">{copy.title}</p>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.body}</p>
    {onUpload && <>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">You can also drop photos here from your computer.</p>
      <button type="button" className={`${secondary} mt-4 inline-flex items-center gap-2`} onClick={onUpload}><Upload className="h-4 w-4" />Upload photos</button>
    </>}
  </div>;
}

function PopupMenu({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) { if (!ref.current?.contains(event.target as Node)) onClose(); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); onClose(); } }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape, true);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape, true); };
  }, [onClose]);
  // Menus differ in height; open upward as far as needed to stay on screen.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu) menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  }, [y]);
  return createPortal(<div ref={ref} role="menu" aria-label={label} className="fixed z-50 max-h-72 w-56 overflow-auto rounded-xl border border-border bg-card p-1 text-foreground shadow-lg" style={{ left: x, top: Math.min(y, window.innerHeight - 140) }}>
    {children}
  </div>, document.body);
}

const menuItem = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted";

function AlbumMenu({ state, albums, onPick, onCreate, onClose }: { state: AlbumMenuState; albums: GalleryAlbum[]; onPick: (albumId: string) => void; onCreate: () => void; onClose: () => void }) {
  return <PopupMenu x={state.x} y={state.y} label="Add to album" onClose={onClose}>
    <button role="menuitem" className={menuItem} onClick={onCreate}><Plus className="h-4 w-4" />New album…</button>
    {albums.length > 0 && <div className="my-1 border-t border-border" />}
    {albums.map((album) => <button key={album.id} role="menuitem" className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted" onClick={() => onPick(album.id)}>{album.name}</button>)}
  </PopupMenu>;
}

function OpenInCanvasMenu({ state, onPick, onClose }: { state: OpenMenuState; onPick: (placement: GalleryTabPlacement) => void; onClose: () => void }) {
  return <PopupMenu x={state.x} y={state.y} label={`Open ${state.photo.name}`} onClose={onClose}>
    <button role="menuitem" className={menuItem} onClick={() => onPick("tab")}><AppWindow className="h-4 w-4" />Open in tab</button>
    <button role="menuitem" className={menuItem} onClick={() => onPick("right")}><PanelRight className="h-4 w-4" />Open to the right</button>
    <button role="menuitem" className={menuItem} onClick={() => onPick("bottom")}><PanelBottom className="h-4 w-4" />Open below</button>
  </PopupMenu>;
}

function PhotoMenu({ state, archived, onOpenInCanvas, onArchive, onRestore, onDelete, onClose }: {
  state: PhotoMenuState;
  archived: boolean;
  onOpenInCanvas?: (placement: GalleryTabPlacement) => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const count = state.photoIds.length;
  const these = count === 1 ? "" : ` ${count} photos`;
  return <PopupMenu x={state.x} y={state.y} label={count === 1 ? state.photo.name : `${count} photos`} onClose={onClose}>
    {archived ? <>
      <button role="menuitem" className={menuItem} onClick={onRestore}><ArchiveRestore className="h-4 w-4" />Restore{these} to gallery</button>
      <button role="menuitem" className={`${menuItem} text-destructive`} onClick={onDelete}><Trash2 className="h-4 w-4" />Delete{these}…</button>
    </> : <>
      {onOpenInCanvas && count === 1 && <>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("tab")}><AppWindow className="h-4 w-4" />Open in tab</button>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("right")}><PanelRight className="h-4 w-4" />Open to the right</button>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("bottom")}><PanelBottom className="h-4 w-4" />Open below</button>
        <div className="my-1 border-t border-border" />
      </>}
      <button role="menuitem" className={menuItem} onClick={onArchive}><Lock className="h-4 w-4" />Move{these} to Protected Archive</button>
    </>}
  </PopupMenu>;
}

export function AlbumNameDialog({ title, initialName = "", submitLabel, note, busy, error, onClose, onSubmit }: {
  title: string;
  initialName?: string;
  submitLabel: string;
  note: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  return <ModalDialog open title={title} onClose={() => { if (!busy) onClose(); }}
    footer={<><button className={secondary} disabled={busy} onClick={onClose}>Cancel</button><button className={primary} type="submit" form="gallery-album-form" disabled={busy || !name.trim()}>{busy ? "Saving…" : submitLabel}</button></>}>
    <form id="gallery-album-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onSubmit(name.trim()); }}>
      <label className="block text-sm font-medium" htmlFor="gallery-album-name">Album name</label>
      <input autoFocus id="gallery-album-name" maxLength={120} placeholder="e.g. Cover ideas" value={name} onChange={(event) => setName(event.target.value)}
        className="mt-2 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  </ModalDialog>;
}
