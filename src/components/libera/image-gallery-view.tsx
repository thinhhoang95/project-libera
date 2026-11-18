"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFormatter, useTranslations } from "next-intl";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowUpWideNarrow,
  AppWindow,
  ArchiveRestore,
  CalendarDays,
  CalendarSearch,
  FolderDown,
  FolderInput,
  FolderMinus,
  FolderPlus,
  ImagePlus,
  Images,
  LayoutGrid,
  ListFilter,
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
  UserPlus,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { useAppMenuGallery, useAppMenuPhoto } from "@/components/libera/app-menu";
import { usePaletteCommands, type PaletteCommand } from "@/components/libera/command-palette/commands";
import { ArchiveUnlock, moveToArchive, useProtectedArchive } from "@/components/libera/gallery-archive";
import { galleryText, useRegisterGalleryTranslator } from "@/components/libera/gallery-i18n";
import {
  applyGallery, refreshGallery, reusePrompt, sendToReferences, settleSharedAlbumRequest, subscribeSharedAlbumRequests, useGallery,
} from "@/components/libera/gallery-store";
import { useCollabShell } from "@/components/libera/collab/collab-provider";
import { SharedPhotoDetails, ShareGalleryDialog, useAlbumMembers } from "@/components/libera/gallery-sharing";
import { contributorName, describeFilter, FilterButton, GroupingButton, JumpToDateButton, TimelineSeeker, type Contributor } from "@/components/libera/gallery-timeline";
import { parsePhotoAnchor } from "@/lib/collab/album-comments";
import type { Thread } from "@/lib/collab/protocol/api";
import { collabClient } from "@/lib/collab/ui/client";
import { useCollabStatus, useHostEvents } from "@/lib/collab/ui/hooks";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { commandMenuItems, disabledMenu, menuCommands, type NativeMenuEntry } from "@/components/libera/native-menu";
import { VirtualPhotoGrid } from "@/components/libera/virtual-photo-grid";
import { PhotoViewer, type PhotoViewerChat, type PhotoViewerViewState } from "@/components/libera/photo-viewer";
import type { GalleryTabPlacement } from "@/components/libera/gallery-tabs";
import {
  DEFAULT_GALLERY_ZOOM,
  GALLERY_ZOOM_LEVELS,
  galleryRows,
  type GalleryLayoutMode,
} from "@/lib/gallery-layout";
import {
  filterCount, filterPhotos, GALLERY_GROUPINGS, groupPhotos, ME, nearestPhoto, NO_FILTER, photoContributor, toDay, type GalleryFilter, type GalleryGrouping,
} from "@/lib/gallery-timeline";
import { archiveRawUrl, canChangeSharedPhotos, galleryRawUrl, type GalleryAlbum, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

type GalleryView = { kind: "photos" } | { kind: "starred" } | { kind: "albums" } | { kind: "shared" } | { kind: "album"; id: string } | { kind: "archive" };

// The gallery unmounts while another left panel is open. Remember where the
// reader was, so coming back lands on the same view, photo and scroll offset.
const session = {
  view: { kind: "photos" } as GalleryView, viewingId: null as string | null,
  scroll: new Map<string, number>(), photoViews: new Map<string, PhotoViewerViewState>(),
  selection: new Set<string>(), anchor: null as string | null,
  filter: NO_FILTER as GalleryFilter,
};
type SortOrder = "newest" | "oldest";
type LayoutPreferences = { mode: GalleryLayoutMode; zoom: number };
type Dialog =
  | { kind: "create-album"; photoIds: string[] }
  | { kind: "rename-album"; album: GalleryAlbum }
  | { kind: "delete-album"; album: GalleryAlbum }
  | { kind: "delete-photos"; ids: string[]; archived?: boolean }
  | { kind: "share"; album?: GalleryAlbum; photo?: GalleryPhoto };
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
const GROUPING_STORAGE_KEY = "libera.gallery.grouping";
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

async function galleryRequest<T extends { gallery?: GalleryContents }>(url: string, method: string, body: unknown) {
  const response = await apiRequest<T>(url, { method, body: JSON.stringify(body) });
  applyGallery(response.gallery);
  return response;
}

function menuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(8, Math.min(rect.left, window.innerWidth - 240)), y: rect.bottom + 4 };
}

function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const ref = useRef(callback);
  useLayoutEffect(() => { ref.current = callback; });
  return useCallback((...args: Args) => ref.current(...args), []);
}

function rememberPhotoView(id: string, state: PhotoViewerViewState) {
  session.photoViews.delete(id);
  session.photoViews.set(id, state);
  if (session.photoViews.size > 64) session.photoViews.delete(session.photoViews.keys().next().value!);
}

export function ImageGalleryView({ onOpenInCanvas, chat, onViewingPhotoChange }: {
  /** Opens a photo as an editor tab, or beside the focused panel, like a notebook image. */
  onOpenInCanvas?: (photo: GalleryPhoto, placement: GalleryTabPlacement) => void;
  /** The app's AI chat panel, which the photo viewer can open beside the photo. */
  chat?: PhotoViewerChat;
  /** Reports the photo open in the viewer so the AI chat can take it as context. */
  onViewingPhotoChange?: (photo: GalleryPhoto | null) => void;
} = {}) {
  const t = useTranslations("imageGalleryView");
  const tTimeline = useTranslations("galleryTimeline");
  const tCommon = useTranslations("common");
  const tSharing = useTranslations("gallerySharing");
  const format = useFormatter();
  useRegisterGalleryTranslator();
  // One value names the toolbar and its palette commands, so the menu bar can tell them apart.
  const galleryGroup = t("paletteGroup");
  const gallery = useGallery();
  const [requestedView, setView] = useState<GalleryView>(() => session.view);
  const [sort, setSort] = useState<SortOrder>(() => readStored(SORT_STORAGE_KEY, (value) => (value === "oldest" ? "oldest" : value === "newest" ? "newest" : null), "newest"));
  const [grouping, setGrouping] = useState<GalleryGrouping>(() => readStored(GROUPING_STORAGE_KEY, (value) => (GALLERY_GROUPINGS.includes(value as GalleryGrouping) ? value as GalleryGrouping : null), "day"));
  const [filter, setFilterState] = useState<GalleryFilter>(() => session.filter);
  /** A photo Jump to date landed on, outlined for a moment. */
  const [landedId, setLandedId] = useState<string | null>(null);
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
  /** A comment a notification opened, focused in the viewer. */
  const [focusThreadId, setFocusThreadId] = useState<string | undefined>(undefined);
  const collabShell = useCollabShell();
  const canShare = Boolean(collabShell?.visible);
  const dragDepthRef = useRef(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
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
  // Viewers and commenters of a shared album look at its photos but do not change them.
  const albumLocked = Boolean(currentAlbum?.shared) && !canChangeSharedPhotos(currentAlbum?.shared);
  const viewKey = view.kind === "album" ? `album:${view.id}` : view.kind;
  const inArchive = view.kind === "archive";
  const archive = useProtectedArchive(inArchive);

  const viewPhotos = useMemo(() => {
    const all = viewKey === "archive" ? archive.photos : contents?.photos ?? [];
    const albumId = viewKey.startsWith("album:") ? viewKey.slice(6) : null;
    const visible = albumId ? all.filter((photo) => photo.albumIds.includes(albumId))
      : viewKey === "starred" ? all.filter((photo) => photo.starred)
        : all;
    return [...visible].sort((first, second) => sort === "newest"
      ? second.createdAt.localeCompare(first.createdAt) || second.name.localeCompare(first.name)
      : first.createdAt.localeCompare(second.createdAt) || first.name.localeCompare(second.name));
  }, [archive.photos, contents, sort, viewKey]);
  const myAccountId = useCollabStatus().status?.account?.id;
  const photos = useMemo(() => filterPhotos(viewPhotos, filter, myAccountId), [filter, myAccountId, viewPhotos]);
  const groups = useMemo(() => groupPhotos(photos, grouping), [grouping, photos]);
  const rowLayout = useMemo(() => galleryRows(groups, layout.mode, width, GALLERY_ZOOM_LEVELS[layout.zoom]), [groups, layout.mode, layout.zoom, width]);
  const filtering = filterCount(filter) > 0;

  // Everyone who added photos to this view, yourself first, for the filter.
  const members = useAlbumMembers(useMemo(() => [...new Set(viewPhotos.flatMap((photo) => (photo.shared ? [photo.shared.projectId] : [])))], [viewPhotos]));
  const memberNames = useMemo(() => new Map([...members].map(([id, member]) => [id, member.displayName])), [members]);
  const contributors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const photo of viewPhotos) {
      const id = photoContributor(photo, myAccountId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const id of filter.contributors) if (!counts.has(id)) counts.set(id, 0);
    return [...counts].map(([id, count]): Contributor => ({ id, count, name: contributorName(id, memberNames, tTimeline) }))
      .sort((first, second) => (first.id === ME ? -1 : second.id === ME ? 1 : first.name.localeCompare(second.name)));
  }, [filter.contributors, memberNames, myAccountId, tTimeline, viewPhotos]);
  const viewDays = useMemo(() => {
    if (!viewPhotos.length) return { min: "", max: "" };
    let low = Infinity, high = -Infinity;
    for (const photo of viewPhotos) { const time = Date.parse(photo.createdAt); low = Math.min(low, time); high = Math.max(high, time); }
    return { min: toDay(new Date(low)), max: toDay(new Date(high)) };
  }, [viewPhotos]);
  const shownTimes = useMemo(() => photos.map((photo) => Date.parse(photo.createdAt)), [photos]);

  function setFilter(next: GalleryFilter) {
    session.filter = next;
    setFilterState(next);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  function changeGrouping(next: GalleryGrouping) {
    setGrouping(next);
    store(GROUPING_STORAGE_KEY, next);
  }

  /** Scrolls to the photo taken closest to `day`, and outlines it for a moment. */
  function jumpToDate(day: string) {
    jumpToPhoto(nearestPhoto(photos, day));
  }

  function jumpToPhoto(photo: GalleryPhoto | undefined) {
    const scroller = scrollRef.current;
    const position = photo && rowLayout.photoTops.get(photo.id);
    if (!photo || !scroller || !position) return;
    scroller.scrollTop = position.top - position.sectionTop < scroller.clientHeight / 2 ? position.sectionTop : position.top - 16;
    scroller.dispatchEvent(new Event("scroll"));
    setLandedId(photo.id);
  }

  // The choices inside Group by, Jump to and Filter, for the command palette and the Gallery menu.
  function timelineCommands(): Array<PaletteCommand & { menuLabel: string }> {
    const group = galleryGroup;
    const byTime = [...photos].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
    const years = [...new Set(viewPhotos.map((photo) => new Date(photo.createdAt).getFullYear()))].sort((first, second) => second - first);
    const chosen = new Set(filter.contributors);
    const toggleContributor = (id: string) => {
      const next = new Set(chosen);
      if (next.has(id)) next.delete(id); else next.add(id);
      setFilter({ ...filter, contributors: [...next] });
    };
    const lastDays = (days: number) => {
      const from = new Date();
      from.setDate(from.getDate() - days + 1);
      return { from: toDay(from), to: toDay(new Date()) };
    };
    return [
      ...GALLERY_GROUPINGS.map((option) => ({
        id: `gallery:group-by:${option}`, title: t(`groupByCommand.${option}`), menuLabel: tTimeline(`grouping.${option}`), group, icon: CalendarDays, checked: grouping === option,
        keywords: option === "auto" ? "date sections events changepoints" : "date sections", run: () => changeGrouping(option),
      })),
      { id: "gallery:jump-newest", title: t("jumpNewest"), menuLabel: t("jumpNewestMenu"), group, icon: CalendarSearch, keywords: "date latest recent top", disabled: !photos.length, run: () => jumpToPhoto(byTime.at(-1)) },
      { id: "gallery:jump-oldest", title: t("jumpOldest"), menuLabel: t("jumpOldestMenu"), group, icon: CalendarSearch, keywords: "date earliest first", disabled: !photos.length, run: () => jumpToPhoto(byTime[0]) },
      ...years.map((year) => ({
        id: `gallery:jump-year:${year}`, title: t("jumpYear", { year: String(year) }), menuLabel: String(year), group, icon: CalendarSearch, keywords: "date year",
        // The first photo of the year as shown, so the year's top is in view.
        disabled: !photos.some((photo) => new Date(photo.createdAt).getFullYear() === year),
        run: () => jumpToPhoto(photos.find((photo) => new Date(photo.createdAt).getFullYear() === year)),
      })),
      ...(contributors.length > 1 || chosen.size ? contributors.map((contributor) => ({
        id: `gallery:filter-contributor:${contributor.id}`, title: t("filterAddedBy", { name: contributor.name }), menuLabel: tTimeline("addedByNames", { names: contributor.name }), group, icon: ListFilter, checked: chosen.has(contributor.id),
        keywords: contributor.id === ME ? "contributor member mine my own" : "contributor member people", run: () => toggleContributor(contributor.id),
      })) : []),
      { id: "gallery:filter-30-days", title: t("filterLast30Days"), menuLabel: t("filterLast30DaysMenu"), group, icon: ListFilter, keywords: "date range recent month", run: () => setFilter({ ...filter, ...lastDays(30) }) },
      { id: "gallery:filter-12-months", title: t("filterLast12Months"), menuLabel: t("filterLast12MonthsMenu"), group, icon: ListFilter, keywords: "date range recent year", run: () => setFilter({ ...filter, ...lastDays(365) }) },
      ...years.map((year) => ({
        id: `gallery:filter-year:${year}`, title: t("filterYear", { year: String(year) }), menuLabel: t("filterYearMenu", { year: String(year) }), group, icon: ListFilter, keywords: "date range year",
        checked: filter.from === `${year}-01-01` && filter.to === `${year}-12-31`, run: () => setFilter({ ...filter, from: `${year}-01-01`, to: `${year}-12-31` }),
      })),
      { id: "gallery:filter-clear", title: t("clearFilter"), menuLabel: t("clearFilter"), group, icon: X, keywords: "show all photos reset", disabled: !filtering, run: () => setFilter(NO_FILTER) },
    ];
  }

  // The toolbar's buttons are read from the page; these are the choices behind them.
  usePaletteCommands(rootRef, () => {
    if (!showGrid || !contents || viewingId) return [];
    const group = galleryGroup;
    const ids = [...selected];
    return [
      ...timelineCommands(),
      { id: "gallery:select-all", title: t("selectAllPhotosCommand"), group, icon: Images, shortcut: "⌘A", disabled: !photos.length, run: selectAll },
      ...(selecting && !inArchive ? [
        ...menuCommands(addToAlbumChoices(ids), { group, icon: FolderInput, keywords: "album" }, (label) => t("addToAlbumCommand", { label })),
        ...(canOpenSelection ? menuCommands(openChoices(selectedPhotos[0]), { group, icon: AppWindow, keywords: "canvas split pane" }) : []),
      ] : []),
    ];
  });

  useEffect(() => {
    if (!landedId) return;
    const timer = window.setTimeout(() => setLandedId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [landedId]);
  const starredCount = useMemo(() => contents?.photos.filter((photo) => photo.starred).length ?? 0, [contents]);

  // Selections for photos that left the view no longer count.
  const selected = useMemo(() => {
    const present = new Set(photos.map((photo) => photo.id));
    return new Set([...selection].filter((id) => present.has(id)));
  }, [photos, selection]);
  const selecting = selected.size > 0;
  const selectedPhotos = useMemo(() => photos.filter((photo) => selected.has(photo.id)), [photos, selected]);
  const allSelectedStarred = selectedPhotos.length > 0 && selectedPhotos.every((photo) => photo.starred);
  const selectionLocked = selectedPhotos.some((photo) => photo.shared && !canChangeSharedPhotos(photo.shared));
  const selectionShared = selectedPhotos.some((photo) => photo.shared);
  const canShareSelection = canShare && selectedPhotos.length === 1 && !selectedPhotos[0].shared && !selectedPhotos[0].name.toLowerCase().endsWith(".svg");
  const canOpenSelection = Boolean(onOpenInCanvas) && selectedPhotos.length === 1;

  const viewingIndex = viewingId ? photos.findIndex((photo) => photo.id === viewingId) : -1;
  const showGrid = view.kind !== "albums" && view.kind !== "shared" && (!inArchive || archive.unlocked);

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

  function selectAll() {
    setSelected(new Set(photos.map((photo) => photo.id)));
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
      setError(failure instanceof Error ? failure.message : galleryText("imageGalleryView.genericError"));
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

  async function sendToArchive(ids: string[]) {
    setPhotoMenu(null);
    let archived = 0;
    if (!(await run(async () => { archived = await moveToArchive(ids); }))) return;
    stepPast(ids);
    setNotice(t("movedToArchive", { count: archived }));
  }

  async function restoreFromArchive(ids: string[]) {
    setPhotoMenu(null);
    if (!(await run(() => archive.restore(ids)))) return;
    stepPast(ids);
    setNotice(t("restoredToGallery", { count: ids.length }));
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

  // Members add, edit and remove photos of shared albums at any time: the
  // gallery follows the host's file events, and catches up when the window
  // comes back (in a browser there are no live events).
  const sharedProjects = useMemo(() => new Set(contents?.albums.flatMap((album) => (album.shared ? [album.shared.projectId] : [])) ?? []), [contents]);
  const refreshSoon = useRef<number | null>(null);
  const followAlbum = (projectId: string) => {
    if (!sharedProjects.has(projectId) || refreshSoon.current !== null) return;
    refreshSoon.current = window.setTimeout(() => { refreshSoon.current = null; void refreshGallery(); }, 400);
  };
  useHostEvents("tree-changed", (event) => followAlbum(event.projectId));
  useHostEvents("files-changed", (event) => followAlbum(event.projectId));
  useHostEvents("project-changed", () => void refreshGallery());
  useEffect(() => {
    const focus = () => { if (sharedProjects.size) void refreshGallery(); };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); if (refreshSoon.current !== null) window.clearTimeout(refreshSoon.current); };
  }, [sharedProjects]);

  // A joined album, or a notification about one: open it, at the photo or comment named.
  const albumRequestRef = useRef<Parameters<Parameters<typeof subscribeSharedAlbumRequests>[0]>[0] | null>(null);
  const [albumRequestTick, setAlbumRequestTick] = useState(0);
  useEffect(() => subscribeSharedAlbumRequests((request) => { albumRequestRef.current = request; setAlbumRequestTick((tick) => tick + 1); }), []);
  useEffect(() => {
    const request = albumRequestRef.current;
    if (!request || !contents) return;
    const album = contents.albums.find((entry) => entry.shared?.projectId === request.projectId);
    if (!album) return;
    albumRequestRef.current = null;
    settleSharedAlbumRequest(request);
    if (scrollRef.current) session.scroll.set(viewKey, scrollRef.current.scrollTop);
    setView({ kind: "album", id: album.id });
    setSelected(new Set());
    const openFile = (fileId: string | undefined, threadId?: string) => {
      const photo = fileId ? contents.photos.find((entry) => entry.shared?.projectId === request.projectId && entry.shared.fileId === fileId) : undefined;
      if (!photo) return;
      setFocusThreadId(threadId);
      setViewingId(photo.id);
    };
    if (request.threadId) {
      void collabClient.request<Thread>("GET", `/threads/${encodeURIComponent(request.threadId)}`)
        .then((thread) => openFile(parsePhotoAnchor(thread.anchorId).fileId, thread.id), () => undefined);
    } else openFile(request.fileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a request arrives or the gallery it needs loads
  }, [albumRequestTick, contents]);

  async function saveToGallery(ids: string[]) {
    setPhotoMenu(null);
    let saved = 0;
    if (!(await run(async () => { saved = (await galleryRequest<{ saved: string[]; gallery: GalleryContents }>("/api/gallery/photos/save", "POST", { ids })).saved.length; }))) return;
    setSelected(new Set());
    setNotice(saved ? t("savedToGallery", { count: saved }) : t("onlySharedNeedSaving"));
  }

  /** Adds photos from the computer to `albumId`, or to the top of the gallery. */
  async function uploadPhotos(files: File[], albumId = "") {
    if (upload) return;
    const images = files.filter((file) => UPLOAD_EXTENSIONS.test(file.name));
    const skipped = files.length - images.length;
    if (!images.length) {
      setError(files.length ? t("imageTypesError") : "");
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
          const message = failure instanceof Error ? failure.message : t("addPhotoFailed");
          failed.push(...batch.map((file) => ({ name: file.name, error: message })));
        }
        setUpload((current) => current && { ...current, done: current.done + batch.length });
      }
    } finally {
      setUpload(null);
    }
    const album = albumId ? albumById.get(albumId) : undefined;
    if (added) setNotice(album ? t("addedPhotosToAlbum", { count: added, album: album.name }) : t("addedPhotos", { count: added }));
    const problems = [
      ...(failed.length ? [failed.length === 1 ? t("uploadFailedOne", { name: failed[0].name, error: failed[0].error })
        : t("uploadFailedMany", { count: failed.length, names: failed.slice(0, 3).map((item) => item.name).join(", "), more: failed.length > 3 ? "yes" : "no", error: failed[0].error })] : []),
      ...(skipped ? [t("skippedFiles", { count: skipped })] : []),
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

  function sendSelectionToReferences() {
    sendToReferences(selectedPhotos.map((photo) => ({ name: photo.name, url: galleryRawUrl(photo) })));
    setSelected(new Set());
  }

  function changeSort(next: SortOrder) {
    setSort(next);
    store(SORT_STORAGE_KEY, next);
  }

  /** The albums photos can be added to; the one being shown already holds them. */
  function albumTargets(excludeAlbumId?: string) {
    return (contents?.albums ?? []).filter((album) => album.id !== excludeAlbumId && !album.shared?.direct && canChangeSharedPhotos(album.shared));
  }

  /** The Add to album popup's choices, for the menu bar and the palette. */
  function addToAlbumChoices(photoIds: string[]): NativeMenuEntry[] {
    const albums = albumTargets(currentAlbum?.id);
    return [
      { id: "add-to-album:new", label: t("newAlbumMenu"), onSelect: () => setDialog({ kind: "create-album", photoIds }) },
      ...(albums.length ? [{ type: "separator" as const }] : []),
      ...albums.map((album) => ({ id: `add-to-album:${album.id}`, label: album.name, onSelect: () => void addToAlbum(album.id, photoIds) })),
    ];
  }

  /** The Open in tab popup's choices, for the menu bar and the palette. */
  function openChoices(photo: GalleryPhoto): NativeMenuEntry[] {
    return [
      { id: "open:tab", label: t("openInTab"), onSelect: () => openInCanvas(photo, "tab") },
      { id: "open:right", label: t("openToTheRight"), onSelect: () => openInCanvas(photo, "right") },
      { id: "open:bottom", label: t("openBelow"), onSelect: () => openInCanvas(photo, "bottom") },
    ];
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
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && photos.length) selectAll();
      else if (plain && (event.key === "+" || event.key === "=")) changeLayout((current) => ({ zoom: current.zoom + 1 }));
      else if (plain && event.key === "-") changeLayout((current) => ({ zoom: current.zoom - 1 }));
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectAll reads `photos`, listed here
  }, [albumMenu, changeLayout, dialog, openMenu, photoMenu, photos, selecting, showGrid, viewingId]);

  const title = view.kind === "album" ? currentAlbum?.name ?? "" : view.kind === "albums" ? t("titleAlbums") : view.kind === "shared" ? t("titleShared") : view.kind === "starred" ? t("titleStarred") : inArchive ? t("titleArchive") : t("titlePhotos");
  const size = GALLERY_ZOOM_LEVELS[layout.zoom];
  const togglePhoto = useStableCallback(toggleSelection);
  const togglePhotoGroup = useStableCallback(toggleGroup);
  const openPhoto = useCallback((photo: GalleryPhoto) => setViewingId(photo.id), []);
  const starPhoto = useStableCallback((photo: GalleryPhoto) => void setStarred([photo.id], !photo.starred));
  const contextPhoto = useStableCallback(openPhotoMenu);
  // The seeker takes the place of the scroll bar beside the photos.
  const seeking = Boolean(contents) && showGrid && photos.length > 0;
  const sections = ["photos", "starred", "albums", ...(canShare || contents?.albums.some((album) => album.shared) ? ["shared" as const] : []), "archive"] as const;
  const canUpload = view.kind !== "shared" && !albumLocked && !inArchive;

  // The header's actions while nothing is selected. Over an open photo the viewer's Photo menu is all that applies.
  useAppMenuGallery(() => {
    if (viewingIndex >= 0) return [];
    const browsing = !selecting;
    const timeline = showGrid && contents ? timelineCommands() : [];
    const timelineMenu = (id: string, label: string, prefix: string): NativeMenuEntry => {
      const commands = timeline.filter((command) => command.id.startsWith(prefix));
      return { id, label, enabled: browsing, submenu: commandMenuItems(commands).map((item, index) => ({ ...item, label: commands[index].menuLabel })) };
    };
    const sectionLabel = { photos: t("titlePhotos"), starred: t("titleStarred"), albums: t("titleAlbums"), shared: t("titleShared"), archive: t("titleArchive") };
    const items: NativeMenuEntry[] = [
      ...(currentAlbum ? [{ id: "back", label: t("backToAlbumsMenu"), enabled: browsing, onSelect: () => openView({ kind: "albums" }) }]
        : sections.map((kind) => ({ id: `section:${kind}`, label: sectionLabel[kind], type: "radio" as const, checked: view.kind === kind, enabled: browsing, onSelect: () => openView({ kind }) }))),
      { type: "separator" },
      ...(canUpload ? [{ id: "upload", label: t("uploadPhotosMenu"), enabled: browsing && !upload, onSelect: () => uploadInputRef.current?.click() }] : []),
      ...(view.kind === "starred" && starredCount > 0 ? [{ id: "album-from-starred", label: t("createAlbumFromStarredMenu"), enabled: browsing && !busy, onSelect: () => setDialog({ kind: "create-album", photoIds: photos.map((photo) => photo.id) }) }] : []),
      ...(!currentAlbum && view.kind !== "starred" && view.kind !== "shared" && !inArchive ? [{ id: "new-album", label: t("newAlbumMenu"), enabled: browsing && !busy, onSelect: () => setDialog({ kind: "create-album", photoIds: [] }) }] : []),
      ...(currentAlbum && (canShare || currentAlbum.shared) ? [{ id: "share-album", label: currentAlbum.shared ? t("sharingMenu") : t("shareAlbumMenu"), enabled: browsing && !busy, onSelect: () => setDialog({ kind: "share", album: currentAlbum }) }] : []),
      ...(currentAlbum && (!currentAlbum.shared || currentAlbum.shared.role === "owner") ? [{ id: "rename-album", label: t("renameAlbumMenu"), enabled: browsing && !busy, onSelect: () => setDialog({ kind: "rename-album", album: currentAlbum }) }] : []),
      ...(currentAlbum && !currentAlbum.shared ? [{ id: "delete-album", label: t("deleteAlbumMenu"), enabled: browsing && !busy, onSelect: () => setDialog({ kind: "delete-album", album: currentAlbum }) }] : []),
      ...(inArchive && archive.unlocked ? [{ id: "lock-archive", label: t("lockArchiveMenu"), enabled: browsing, onSelect: archive.lock }] : []),
      ...(showGrid ? [
        { type: "separator" as const },
        timelineMenu("group-by", t("groupByMenu"), "gallery:group-by:"),
        timelineMenu("jump", t("jumpToMenu"), "gallery:jump"),
        timelineMenu("filter", t("filterMenu"), "gallery:filter"),
        { id: "sort", label: t("sortMenu"), enabled: browsing, submenu: [
          { id: "sort:newest", label: t("newestFirstMenu"), type: "radio" as const, checked: sort === "newest", onSelect: () => changeSort("newest") },
          { id: "sort:oldest", label: t("oldestFirstMenu"), type: "radio" as const, checked: sort === "oldest", onSelect: () => changeSort("oldest") },
        ] },
        { id: "layout", label: t("layoutMenu"), enabled: browsing, submenu: [
          { id: "layout:grid", label: t("squareGridMenu"), type: "radio" as const, checked: layout.mode === "grid", onSelect: () => changeLayout(() => ({ mode: "grid" })) },
          { id: "layout:justified", label: t("originalShapesMenu"), type: "radio" as const, checked: layout.mode === "justified", onSelect: () => changeLayout(() => ({ mode: "justified" })) },
        ] },
        { id: "zoom-in", label: t("largerThumbnailsMenu"), enabled: browsing && layout.zoom < GALLERY_ZOOM_LEVELS.length - 1, onSelect: () => changeLayout((current) => ({ zoom: current.zoom + 1 })) },
        { id: "zoom-out", label: t("smallerThumbnailsMenu"), enabled: browsing && layout.zoom > 0, onSelect: () => changeLayout((current) => ({ zoom: current.zoom - 1 })) },
        { type: "separator" as const },
        { id: "select-all", label: t("selectAllPhotosMenu"), enabled: photos.length > 0, onSelect: selectAll },
      ] : []),
    ];
    return dialog ? disabledMenu(items) : items;
  });

  // The selection toolbar's actions. Those it does not offer right now stay in the menu, disabled.
  useAppMenuPhoto("selection", () => {
    if (!showGrid) return [];
    const ids = [...selected];
    const ready = selecting && !busy;
    const remove: NativeMenuEntry = { id: "delete", label: t("deleteMenu"), enabled: ready && !selectionLocked, onSelect: () => setDialog({ kind: "delete-photos", ids, archived: inArchive }) };
    const clear: NativeMenuEntry = { id: "clear", label: t("clearSelectionMenu"), enabled: selecting, onSelect: () => setSelected(new Set()) };
    const items: NativeMenuEntry[] = inArchive ? [
      { id: "restore", label: t("restoreToGalleryMenu"), enabled: ready, onSelect: () => void restoreFromArchive(ids) },
      remove,
      { type: "separator" },
      clear,
    ] : [
      { id: "star", label: allSelectedStarred ? t("unstar") : t("star"), enabled: ready, onSelect: () => void setStarred(ids, !allSelectedStarred) },
      { id: "add-to-album", label: t("addToAlbumMenu"), enabled: ready, submenu: addToAlbumChoices(ids) },
      ...(currentAlbum && !albumLocked ? [{ id: "remove-from-album", label: t("removeFromAlbumMenu"), enabled: ready, onSelect: () => void removeFromAlbum(currentAlbum.id, ids) }] : []),
      { id: "save-to-gallery", label: t("saveToMyGalleryMenu"), enabled: ready && selectionShared, onSelect: () => void saveToGallery(ids) },
      ...(canShare ? [{ id: "share", label: t("shareMenu"), enabled: ready && canShareSelection, onSelect: () => setDialog({ kind: "share", photo: selectedPhotos[0] }) }] : []),
      ...(onOpenInCanvas ? [{ id: "open", label: t("openInMenu"), enabled: ready && canOpenSelection, submenu: selectedPhotos[0] ? openChoices(selectedPhotos[0]) : [{ id: "open:none", label: t("openInTab") }] }] : []),
      { id: "use-as-reference", label: t("useAsReferenceMenu"), enabled: ready, onSelect: sendSelectionToReferences },
      { id: "archive", label: t("archiveMenu"), enabled: ready && !selectionShared, onSelect: () => void sendToArchive(ids) },
      { type: "separator" },
      remove,
      { type: "separator" },
      clear,
    ];
    return dialog ? disabledMenu(items) : items;
  });

  return <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background" {...(inArchive ? {} : dropHandlers)}>
    <input ref={uploadInputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" aria-hidden tabIndex={-1}
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        void uploadPhotos(files, uploadTargetAlbum?.id);
      }} />
    <header className="libera-window-drag-region flex min-h-14 flex-wrap items-center gap-2 border-b border-border px-4 py-2" data-command-toolbar={galleryGroup}>
      {selecting ? <>
        <button className={iconButton} aria-label={t("clearSelection")} title={t("clearSelectionTitle")} onClick={() => setSelected(new Set())}><X className="h-4 w-4" /></button>
        <h2 className="mr-auto text-sm font-semibold">{t("selectedCount", { count: selected.size })}</h2>
        {inArchive ? <button className={toolbarButton} disabled={busy} title={t("restoreTitle")} onClick={() => void restoreFromArchive([...selected])}><ArchiveRestore className="h-4 w-4" />{t("restoreButton")}</button> : <>
        <button className={toolbarButton} disabled={busy} onClick={() => void setStarred([...selected], !allSelectedStarred)}>
          {allSelectedStarred ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}{allSelectedStarred ? t("unstar") : t("star")}
        </button>
        <button className={toolbarButton} disabled={busy} aria-haspopup="menu" onClick={(event) => openAlbumMenu([...selected], event.currentTarget)}><FolderInput className="h-4 w-4" />{t("addToAlbumButton")}</button>
        {currentAlbum && !albumLocked && <button className={toolbarButton} disabled={busy} title={currentAlbum.shared ? t("removeSharedTitle") : undefined} onClick={() => void removeFromAlbum(currentAlbum.id, [...selected])}><FolderMinus className="h-4 w-4" />{t("removeFromAlbumButton")}</button>}
        {selectionShared && <button className={toolbarButton} disabled={busy} title={t("saveCopiesTitle")} onClick={() => void saveToGallery([...selected])}><FolderDown className="h-4 w-4" />{t("saveToMyGalleryButton")}</button>}
        {canShareSelection && <button className={toolbarButton} disabled={busy} onClick={() => setDialog({ kind: "share", photo: selectedPhotos[0] })}><UserPlus className="h-4 w-4" />{t("shareButton")}</button>}
        {canOpenSelection && <button className={toolbarButton} disabled={busy} aria-haspopup="menu" title={t("openInTabTitle")}
          onClick={(event) => setOpenMenu({ photo: selectedPhotos[0], ...menuPosition(event.currentTarget) })}><AppWindow className="h-4 w-4" />{t("openInTabButton")}</button>}
        <button className={toolbarButton} disabled={busy} title={t("useAsReferenceTitle")} onClick={sendSelectionToReferences}><ImagePlus className="h-4 w-4" />{t("useAsReferenceButton")}</button>
        {!selectionShared && <button className={toolbarButton} disabled={busy} title={t("archiveTitle")} onClick={() => void sendToArchive([...selected])}><Lock className="h-4 w-4" />{t("archiveButton")}</button>}
        </>}
        {!selectionLocked && <button className={`${toolbarButton} text-destructive`} disabled={busy} onClick={() => setDialog({ kind: "delete-photos", ids: [...selected], archived: inArchive })}><Trash2 className="h-4 w-4" />{t("deleteButton")}</button>}
      </> : <>
        {view.kind === "album" && <button className={iconButton} aria-label={t("backToAlbums")} title={t("backToAlbums")} onClick={() => openView({ kind: "albums" })}><ArrowLeft className="h-4 w-4" /></button>}
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {showGrid && contents && <p className="truncate text-xs text-muted-foreground">{t("subtitle", {
            filtering: filtering ? "yes" : "no", shown: photos.length, total: viewPhotos.length,
            kind: currentAlbum?.shared ? "shared" : currentAlbum ? "album" : inArchive ? "archive" : "none",
            role: currentAlbum?.shared ? tSharing(`role.${currentAlbum.shared.role}`) : "", unavailable: currentAlbum?.shared?.unavailable ? "yes" : "no", folder: currentAlbum?.folder ?? "",
          })}</p>}
        </div>
        {view.kind !== "album" && <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label={t("sectionsAria")}>
          {sections.map((kind) => <button key={kind} role="tab" aria-selected={view.kind === kind}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition ${view.kind === kind ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => openView({ kind })}>{kind === "photos" ? t("titlePhotos") : kind === "starred" ? <><Star className="h-3 w-3" />{t("titleStarred")}</> : kind === "albums" ? t("titleAlbums") : kind === "shared" ? <><Users className="h-3 w-3" />{t("titleShared")}</> : <><Lock className="h-3 w-3" />{t("tabArchive")}</>}</button>)}
        </div>}
        {showGrid && <>
          <GroupingButton grouping={grouping} onChange={changeGrouping} />
          <JumpToDateButton times={shownTimes} onJump={jumpToDate} />
          <FilterButton filter={filter} contributors={contributors} min={viewDays.min} max={viewDays.max} onChange={setFilter} />
          <div className="flex items-center rounded-lg border border-border" role="group" aria-label={t("thumbnailSize")}>
            <button className={iconButton} aria-label={t("smallerThumbnailsAria")} title={t("showMorePhotos")} disabled={layout.zoom === 0} onClick={() => changeLayout((current) => ({ zoom: current.zoom - 1 }))}><ZoomOut className="h-4 w-4" /></button>
            <input type="range" aria-label={t("thumbnailSize")} className="w-20 accent-[var(--primary)] max-sm:hidden" min={0} max={GALLERY_ZOOM_LEVELS.length - 1} value={layout.zoom}
              onChange={(event) => { const zoom = Number(event.target.value); changeLayout(() => ({ zoom })); }} />
            <button className={iconButton} aria-label={t("largerThumbnailsAria")} title={t("largerThumbnailsTitle")} disabled={layout.zoom === GALLERY_ZOOM_LEVELS.length - 1} onClick={() => changeLayout((current) => ({ zoom: current.zoom + 1 }))}><ZoomIn className="h-4 w-4" /></button>
          </div>
          <button className={iconButton} aria-label={layout.mode === "grid" ? t("squareGridAria") : t("originalShapesAria")} title={layout.mode === "grid" ? t("squareGridTitle") : t("originalShapesTitle")}
            onClick={() => changeLayout((current) => ({ mode: current.mode === "grid" ? "justified" : "grid" }))}>{layout.mode === "grid" ? <LayoutGrid className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}</button>
          <button className={iconButton} aria-label={sort === "newest" ? t("newestFirstAria") : t("oldestFirstAria")} title={sort === "newest" ? t("newestFirstTitle") : t("oldestFirstTitle")}
            onClick={() => changeSort(sort === "newest" ? "oldest" : "newest")}>
            {sort === "newest" ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpWideNarrow className="h-4 w-4" />}
          </button>
        </>}
        {inArchive ? archive.unlocked && <button className={toolbarButton} title={t("lockArchiveTitle")} onClick={archive.lock}><Lock className="h-4 w-4" />{t("lockButton")}</button>
          : view.kind !== "shared" && !albumLocked && <button className={toolbarButton} disabled={Boolean(upload)} title={currentAlbum ? (currentAlbum.shared ? t("addPhotosToSharedAlbumTitle", { album: currentAlbum.name }) : t("addPhotosToAlbumTitle", { album: currentAlbum.name })) : t("addPhotosTitle")}
          onClick={() => uploadInputRef.current?.click()}><Upload className="h-4 w-4" />{upload ? t("addingProgress", { done: upload.done, total: upload.total }) : t("uploadButton")}</button>}
        {view.kind === "starred" && starredCount > 0 && <button className={toolbarButton} disabled={busy} title={t("createAlbumFromStarredTitle")} onClick={() => setDialog({ kind: "create-album", photoIds: photos.map((photo) => photo.id) })}><FolderPlus className="h-4 w-4" />{t("createAlbumButton")}</button>}
        {currentAlbum ? <>
          {(canShare || currentAlbum.shared) && <button className={toolbarButton} disabled={busy} title={currentAlbum.shared ? t("sharedAlbumTitle") : t("shareAlbumTitle")}
            onClick={() => setDialog({ kind: "share", album: currentAlbum })}>{currentAlbum.shared ? <><Users className="h-4 w-4" />{t("sharedButton")}</> : <><UserPlus className="h-4 w-4" />{t("shareButton")}</>}</button>}
          {(!currentAlbum.shared || currentAlbum.shared.role === "owner") && <button className={iconButton} aria-label={t("renameAlbumAria")} title={currentAlbum.shared ? t("renameSharedAlbumTitle") : t("renameAlbumTitle")} disabled={busy} onClick={() => setDialog({ kind: "rename-album", album: currentAlbum })}><Pencil className="h-4 w-4" /></button>}
          {!currentAlbum.shared && <button className={iconButton} aria-label={t("deleteAlbumAria")} title={t("deleteAlbumTitle")} data-tone="destructive" disabled={busy} onClick={() => setDialog({ kind: "delete-album", album: currentAlbum })}><Trash2 className="h-4 w-4" /></button>}
        </> : view.kind !== "starred" && view.kind !== "shared" && !inArchive && <button className={iconButton} aria-label={t("newAlbumButton")} title={t("newAlbumButton")} disabled={busy} onClick={() => setDialog({ kind: "create-album", photoIds: [] })}><FolderPlus className="h-4 w-4" /></button>}
      </>}
    </header>

    {(error || gallery.error) && <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive-muted px-4 py-2 text-sm text-destructive"><span className="mr-auto">{error || gallery.error}</span><button aria-label={tCommon("dismiss")} onClick={() => setError("")}><X className="h-4 w-4" /></button></div>}
    {showGrid && filtering && <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-4 py-1.5 text-xs">
      <span className="mr-auto truncate"><span className="text-muted-foreground">{t("filteredPrefix")} </span>{describeFilter(filter, memberNames, tTimeline, format)}</span>
      <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setFilter(NO_FILTER)}><X className="h-3.5 w-3.5" />{t("clearFilterButton")}</button>
    </div>}
    {notice && <div role="status" className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">{notice}</div>}
    {upload && <div role="status" aria-live="polite" className="sr-only">{t("addingProgressSr", { done: upload.done, total: upload.total })}</div>}
    {/* Over the album list the cards stay visible, so each one can take a drop. */}
    {dropping && !upload && <div aria-hidden className={`pointer-events-none absolute z-30 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary text-sm font-medium ${view.kind === "albums" ? "inset-x-2 bottom-2 bg-card px-4 py-3 shadow-lg" : "inset-2 flex-col bg-background/85"}`}>
      <Upload className={view.kind === "albums" ? "h-5 w-5 text-primary" : "h-8 w-8 text-primary"} />
      {view.kind === "albums" ? t("dropOnAlbumHint") : t("dropToAdd", { target: uploadTargetAlbum ? uploadTargetAlbum.name : t("titlePhotos") })}
    </div>}

    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto pb-8 pl-4 ${seeking ? "pr-12" : "pr-4"}`} style={seeking ? { scrollbarWidth: "none" } : undefined} onScroll={(event) => { if (restoredScrollRef.current === viewKey) session.scroll.set(viewKey, event.currentTarget.scrollTop); }}>
      {!contents ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{gallery.loading ? t("openingGallery") : ""}</p>
        : view.kind === "albums" ? <AlbumGrid contents={contents} albums={contents.albums.filter((album) => !album.shared?.direct)} photoById={photoById} onOpen={(id) => openView({ kind: "album", id })} onCreate={() => setDialog({ kind: "create-album", photoIds: [] })}
          onDropFiles={(albumId, files) => { dragDepthRef.current = 0; setDropping(false); void uploadPhotos(files, albumId); }} />
        : view.kind === "shared" ? <SharedAlbums contents={contents} photoById={photoById} canJoin={canShare} onJoin={() => collabShell?.openJoin()} onOpen={(id) => openView({ kind: "album", id })} />
        : inArchive && !archive.unlocked ? <ArchiveUnlock onUnlock={archive.unlock} />
        : !viewPhotos.length ? <EmptyPhotos view={view.kind} onUpload={view.kind === "starred" || inArchive ? undefined : () => uploadInputRef.current?.click()} />
        : !photos.length ? <div className="mx-auto mt-16 max-w-sm text-center">
          <ListFilter className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t("noPhotosMatchFilter")}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{describeFilter(filter, memberNames, tTimeline, format)}</p>
          <button type="button" className={`${secondary} mt-4`} onClick={() => setFilter(NO_FILTER)}>{t("clearFilter")}</button>
        </div>
        : <VirtualPhotoGrid groups={groups} layout={rowLayout} justified={layout.mode === "justified"} size={size} scrollRef={scrollRef}
            selected={selected} landedId={landedId} thumbnailUrl={inArchive ? archiveRawUrl : galleryRawUrl}
            onToggle={togglePhoto} onToggleGroup={togglePhotoGroup} onOpen={openPhoto} onStar={inArchive ? undefined : starPhoto} onContextMenu={contextPhoto} />}
    </div>
    {seeking && <TimelineSeeker scrollRef={scrollRef} rows={rowLayout.timeline} layoutKey={`${viewKey}:${grouping}:${layout.mode}:${layout.zoom}:${width}:${photos.length}:${photos[0]?.id}`} />}
    </div>

    {viewingIndex >= 0 && contents && <PhotoViewer initialViewState={inArchive ? undefined : session.photoViews.get(photos[viewingIndex].id)}
      onViewStateChange={inArchive ? undefined : (state) => { rememberPhotoView(photos[viewingIndex].id, state); }}
      rawUrl={inArchive ? archiveRawUrl : galleryRawUrl} photos={photos} index={viewingIndex} albums={contents.albums} menusBlocked={Boolean(dialog)}
      onNavigate={(photo) => setViewingId(photo.id)} onClose={() => setViewingId(null)} chat={inArchive ? undefined : chat}
      actions={inArchive ? {
        onDelete: (photo) => setDialog({ kind: "delete-photos", ids: [photo.id], archived: true }),
        onRestore: (photo) => void restoreFromArchive([photo.id]),
      } : {
        onToggleStar: (photo) => void setStarred([photo.id], !photo.starred),
        onDelete: (photo) => setDialog({ kind: "delete-photos", ids: [photo.id] }),
        onAddToAlbum: (photo, element) => openAlbumMenu([photo.id], element),
        albumChoices: (photo) => addToAlbumChoices([photo.id]),
        onOpenInCanvas: onOpenInCanvas ? (photo, element) => setOpenMenu({ photo, ...menuPosition(element) }) : undefined,
        openChoices: onOpenInCanvas ? openChoices : undefined,
        onRevert: async (photo) => { await galleryRequest("/api/gallery/photos/edit", "POST", { id: photo.id, action: "revert" }); },
        onReusePrompt: (photo) => { reusePrompt(photo.prompt ?? ""); setViewingId(null); },
        onUseAsReference: (photo) => { sendToReferences([{ name: photo.name, url: galleryRawUrl(photo) }]); setViewingId(null); },
        onEdited: (result) => { applyGallery(result.gallery); setViewingId(result.id); },
        onArchive: (photo) => void sendToArchive([photo.id]),
        onShare: canShare ? (photo) => setDialog({ kind: "share", photo }) : undefined,
        onSaveToGallery: (photo) => void saveToGallery([photo.id]),
      }}
      sharedDetails={(photo, setOverlay) => <SharedPhotoDetails photo={photo} album={photo.shared ? albumById.get(photo.shared.albumId) : undefined} setOverlay={setOverlay}
        focusThreadId={photo.id === viewingId ? focusThreadId : undefined} />} />}

    {albumMenu && contents && <AlbumMenu state={albumMenu} albums={albumTargets(albumMenu.excludeAlbumId)}
      onClose={() => setAlbumMenu(null)}
      onPick={(albumId) => void addToAlbum(albumId, albumMenu.photoIds)}
      onCreate={() => { setDialog({ kind: "create-album", photoIds: albumMenu.photoIds }); setAlbumMenu(null); }} />}

    {photoMenu && <PhotoMenu state={photoMenu} archived={inArchive} onClose={() => setPhotoMenu(null)}
      shared={photoMenu.photoIds.some((id) => photoById.get(id)?.shared)}
      onShare={canShare && photoMenu.photoIds.length === 1 && !photoMenu.photo.shared && !photoMenu.photo.name.toLowerCase().endsWith(".svg") ? () => { setDialog({ kind: "share", photo: photoMenu.photo }); setPhotoMenu(null); } : undefined}
      onSaveToGallery={() => void saveToGallery(photoMenu.photoIds)}
      onOpenInCanvas={onOpenInCanvas && ((placement) => openInCanvas(photoMenu.photo, placement))}
      onArchive={() => void sendToArchive(photoMenu.photoIds)}
      onRestore={() => void restoreFromArchive(photoMenu.photoIds)}
      onDelete={() => { setDialog({ kind: "delete-photos", ids: photoMenu.photoIds, archived: inArchive }); setPhotoMenu(null); }} />}

    {openMenu && <OpenInCanvasMenu state={openMenu} onClose={() => setOpenMenu(null)} onPick={(placement) => openInCanvas(openMenu.photo, placement)} />}

    {dialog?.kind === "create-album" && <AlbumNameDialog title={t("newAlbumDialogTitle")} busy={busy} error={error}
      submitLabel={dialog.photoIds.length ? t("createWithPhotos", { count: dialog.photoIds.length }) : t("createAlbumButton")}
      note={dialog.photoIds.length ? t("createAlbumNoteWithPhotos") : t("createAlbumNote")}
      onClose={() => { setDialog(null); setError(""); }}
      onSubmit={async (name) => {
        let created: GalleryAlbum | undefined;
        const done = await run(async () => { created = (await galleryRequest<{ album: GalleryAlbum; gallery: GalleryContents }>("/api/gallery/albums", "POST", { name, photoIds: dialog.photoIds })).album; });
        if (!done) return;
        setDialog(null);
        setSelected(new Set());
        if (created && !viewingId) openView({ kind: "album", id: created.id });
      }} />}
    {dialog?.kind === "share" && contents && <ShareGalleryDialog album={dialog.album} photo={dialog.photo} albums={contents.albums}
      onClose={() => { setDialog(null); setSelected(new Set()); }} />}
    {dialog?.kind === "rename-album" && <AlbumNameDialog title={t("renameAlbumTitle")} initialName={dialog.album.name} submitLabel={t("renameSubmit")} busy={busy} error={error}
      note={dialog.album.shared ? t("renameSharedNote") : t("renameNote")}
      onClose={() => { setDialog(null); setError(""); }}
      onSubmit={async (name) => {
        if (await run(() => galleryRequest("/api/gallery/albums", "PATCH", { id: dialog.album.id, name }))) setDialog(null);
      }} />}
    {dialog?.kind === "delete-album" && <ModalDialog open title={t("deleteAlbumDialogTitle", { name: dialog.album.name })} description={t("deleteAlbumDescription")}
      onClose={() => { if (!busy) { setDialog(null); setError(""); } }}
      footer={<>
        <button className={secondary} disabled={busy} onClick={() => setDialog(null)}>{tCommon("cancel")}</button>
        <button className={destructive} disabled={busy} onClick={() => void run(() => galleryRequest("/api/gallery/albums", "DELETE", { id: dialog.album.id })).then((done) => { if (done) { setDialog(null); openView({ kind: "albums" }); } })}>{t("deleteAlbumTitle")}</button>
      </>}>
      <p className="text-sm text-muted-foreground">{t("albumPhotosStay", { count: dialog.album.count, folder: dialog.album.folder })}</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </ModalDialog>}
    {dialog?.kind === "delete-photos" && <ModalDialog open title={t("deletePhotosTitle", { count: dialog.ids.length })} description={dialog.archived ? t("deleteArchivedDescription")
      : dialog.ids.some((id) => photoById.get(id)?.shared) ? t("deleteSharedDescription")
      : t("deleteDescription")}
      onClose={() => { if (!busy) { setDialog(null); setError(""); } }}
      footer={<>
        <button className={secondary} disabled={busy} onClick={() => setDialog(null)}>{tCommon("cancel")}</button>
        <button className={destructive} disabled={busy} autoFocus onClick={() => void deletePhotos(dialog.ids, dialog.archived)}>{busy ? t("deleting") : tCommon("delete")}</button>
      </>}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">{t("notebookPhotosUnaffected")}</p>}
    </ModalDialog>}
  </div>;
}

function AlbumGrid({ albums, photoById, onOpen, onCreate, onDropFiles }: { contents: GalleryContents; albums: GalleryAlbum[]; photoById: Map<string, GalleryPhoto>; onOpen: (id: string) => void; onCreate?: () => void; onDropFiles?: (albumId: string, files: File[]) => void }) {
  const t = useTranslations("imageGalleryView");
  const tSharing = useTranslations("gallerySharing");
  const [dropTarget, setDropTarget] = useState("");
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 pt-5">
    {onCreate && <button type="button" className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onCreate}>
      <Plus className="h-6 w-6" />{t("newAlbumButton")}
    </button>}
    {albums.map((album) => {
      const droppable = Boolean(onDropFiles) && canChangeSharedPhotos(album.shared);
      const cover = album.coverId ? photoById.get(album.coverId) : undefined;
      return <button key={album.id} type="button" className="group text-left" onClick={() => onOpen(album.id)}
        onDragOver={(event) => { if (!droppable || !hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropTarget(album.id); }}
        onDragLeave={() => setDropTarget((current) => (current === album.id ? "" : current))}
        onDrop={(event) => {
          if (!droppable || !hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget("");
          onDropFiles?.(album.id, [...event.dataTransfer.files]);
        }}>
        <span className={`block aspect-square overflow-hidden rounded-xl bg-muted ${dropTarget === album.id ? "ring-4 ring-primary" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
          {cover ? <img src={galleryRawUrl(cover, true)} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" />
            : <span className="flex h-full items-center justify-center text-muted-foreground"><Images className="h-8 w-8" /></span>}
        </span>
        <span className="mt-2 flex items-center gap-1.5 truncate text-sm font-medium">{album.shared && <Users aria-label={t("sharedIconAria")} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}<span className="truncate">{album.name}</span></span>
        <span className="block text-xs text-muted-foreground">{t("albumCardSubtitle", { direct: album.shared?.direct ? "yes" : "no", count: album.count, sharing: !album.shared ? "none" : album.shared.role === "owner" ? "owner" : "member", role: album.shared ? tSharing(`role.${album.shared.role}`) : "" })}</span>
      </button>;
    })}
  </div>;
}

/** Albums and photos shared by this account or with it. */
function SharedAlbums({ contents, photoById, canJoin, onJoin, onOpen }: { contents: GalleryContents; photoById: Map<string, GalleryPhoto>; canJoin: boolean; onJoin: () => void; onOpen: (id: string) => void }) {
  const t = useTranslations("imageGalleryView");
  const shared = contents.albums.filter((album) => album.shared);
  const withMe = shared.filter((album) => album.shared?.role !== "owner");
  const byMe = shared.filter((album) => album.shared?.role === "owner");
  if (!shared.length) {
    return <div className="mx-auto mt-16 max-w-sm text-center">
      <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">{t("nothingSharedTitle")}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("nothingSharedBody")}</p>
      {canJoin && <button type="button" className={`${secondary} mt-4 inline-flex items-center gap-2`} onClick={onJoin}><UserPlus className="h-4 w-4" />{t("acceptInvitation")}</button>}
    </div>;
  }
  return <>
    {withMe.length > 0 && <section className="pt-5">
      <div className="flex items-center gap-2"><h3 className="mr-auto text-sm font-medium">{t("sharedWithYouHeading")}</h3>
        {canJoin && <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={onJoin}><UserPlus className="h-3.5 w-3.5" />{t("acceptInvitation")}</button>}</div>
      <AlbumGrid contents={contents} albums={withMe} photoById={photoById} onOpen={onOpen} />
    </section>}
    {byMe.length > 0 && <section className="pt-6">
      <h3 className="text-sm font-medium">{t("sharedByYouHeading")}</h3>
      <AlbumGrid contents={contents} albums={byMe} photoById={photoById} onOpen={onOpen} />
    </section>}
  </>;
}

function EmptyPhotos({ view, onUpload }: { view: GalleryView["kind"]; onUpload?: () => void }) {
  const t = useTranslations("imageGalleryView");
  const copy = view === "archive"
    ? { title: t("archiveEmptyTitle"), body: t("archiveEmptyBody") }
    : view === "starred"
    ? { title: t("starredEmptyTitle"), body: t("starredEmptyBody") }
    : view === "album"
      ? { title: t("albumEmptyTitle"), body: t("albumEmptyBody") }
      : { title: t("galleryEmptyTitle"), body: t("galleryEmptyBody") };
  return <div className="mx-auto mt-16 max-w-sm text-center">
    {view === "archive" ? <Lock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /> : view === "starred" ? <Star className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /> : <Sparkles className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />}
    <p className="text-sm font-medium">{copy.title}</p>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.body}</p>
    {onUpload && <>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("dropHereHint")}</p>
      <button type="button" className={`${secondary} mt-4 inline-flex items-center gap-2`} onClick={onUpload}><Upload className="h-4 w-4" />{t("uploadPhotosButton")}</button>
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
  const t = useTranslations("imageGalleryView");
  return <PopupMenu x={state.x} y={state.y} label={t("addToAlbumPopupLabel")} onClose={onClose}>
    <button role="menuitem" className={menuItem} onClick={onCreate}><Plus className="h-4 w-4" />{t("newAlbumPopup")}</button>
    {albums.length > 0 && <div className="my-1 border-t border-border" />}
    {albums.map((album) => <button key={album.id} role="menuitem" className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted" onClick={() => onPick(album.id)}>{album.name}</button>)}
  </PopupMenu>;
}

function OpenInCanvasMenu({ state, onPick, onClose }: { state: OpenMenuState; onPick: (placement: GalleryTabPlacement) => void; onClose: () => void }) {
  const t = useTranslations("imageGalleryView");
  return <PopupMenu x={state.x} y={state.y} label={t("openPhotoMenuLabel", { name: state.photo.name })} onClose={onClose}>
    <button role="menuitem" className={menuItem} onClick={() => onPick("tab")}><AppWindow className="h-4 w-4" />{t("openInTabButton")}</button>
    <button role="menuitem" className={menuItem} onClick={() => onPick("right")}><PanelRight className="h-4 w-4" />{t("openToTheRightPopup")}</button>
    <button role="menuitem" className={menuItem} onClick={() => onPick("bottom")}><PanelBottom className="h-4 w-4" />{t("openBelowPopup")}</button>
  </PopupMenu>;
}

function PhotoMenu({ state, archived, shared, onShare, onSaveToGallery, onOpenInCanvas, onArchive, onRestore, onDelete, onClose }: {
  state: PhotoMenuState;
  archived: boolean;
  /** Some of the photos are in a shared album: they can be saved, not archived. */
  shared: boolean;
  onShare?: () => void;
  onSaveToGallery: () => void;
  onOpenInCanvas?: (placement: GalleryTabPlacement) => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("imageGalleryView");
  const count = state.photoIds.length;
  return <PopupMenu x={state.x} y={state.y} label={count === 1 ? state.photo.name : t("photosMenuLabel", { count })} onClose={onClose}>
    {archived ? <>
      <button role="menuitem" className={menuItem} onClick={onRestore}><ArchiveRestore className="h-4 w-4" />{t("restoreToGalleryPhotos", { count })}</button>
      <button role="menuitem" className={`${menuItem} text-destructive`} onClick={onDelete}><Trash2 className="h-4 w-4" />{t("deletePhotosMenu", { count })}</button>
    </> : <>
      {onOpenInCanvas && count === 1 && <>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("tab")}><AppWindow className="h-4 w-4" />{t("openInTabButton")}</button>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("right")}><PanelRight className="h-4 w-4" />{t("openToTheRightPopup")}</button>
        <button role="menuitem" className={menuItem} onClick={() => onOpenInCanvas("bottom")}><PanelBottom className="h-4 w-4" />{t("openBelowPopup")}</button>
        <div className="my-1 border-t border-border" />
      </>}
      {onShare && <button role="menuitem" className={menuItem} onClick={onShare}><UserPlus className="h-4 w-4" />{t("sharePhotoMenu")}</button>}
      {shared ? <button role="menuitem" className={menuItem} onClick={onSaveToGallery}><FolderDown className="h-4 w-4" />{t("saveToGalleryPhotos", { count })}</button>
        : <button role="menuitem" className={menuItem} onClick={onArchive}><Lock className="h-4 w-4" />{t("moveToArchivePhotos", { count })}</button>}
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
  const t = useTranslations("imageGalleryView");
  const tCommon = useTranslations("common");
  const [name, setName] = useState(initialName);
  return <ModalDialog open title={title} onClose={() => { if (!busy) onClose(); }}
    footer={<><button className={secondary} disabled={busy} onClick={onClose}>{tCommon("cancel")}</button><button className={primary} type="submit" form="gallery-album-form" disabled={busy || !name.trim()}>{busy ? tCommon("saving") : submitLabel}</button></>}>
    <form id="gallery-album-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onSubmit(name.trim()); }}>
      <label className="block text-sm font-medium" htmlFor="gallery-album-name">{t("albumNameLabel")}</label>
      <input autoFocus id="gallery-album-name" maxLength={120} placeholder={t("albumNamePlaceholder")} value={name} onChange={(event) => setName(event.target.value)}
        className="mt-2 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  </ModalDialog>;
}
