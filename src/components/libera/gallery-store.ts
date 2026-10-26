"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { GalleryContents, GalleryPhoto } from "@/lib/image-generation";
import { galleryPhotoSummary, type GalleryCatalogPage } from "@/lib/gallery-catalog";

/**
 * The generation panel and the gallery view share one copy of the gallery, so
 * a new image or album appears in both without either owning the other.
 */
type GalleryState = { contents: GalleryContents | null; loading: boolean; error: string };

let state: GalleryState = { contents: null, loading: false, error: "" };
let pendingRefresh: Promise<GalleryContents | null> | null = null;
let revision = "";
let catalogGeneration = 0;
const detailsCache = new Map<string, { photo: GalleryPhoto; bytes: number }>();
let detailBytes = 0;

function detailKey(photo: GalleryPhoto) {
  return `${photo.id}:${photo.updatedAt}:${photo.size}:${photo.detailsVersion ?? ""}`;
}

function cacheDetails(summary: GalleryPhoto, photo: GalleryPhoto) {
  const key = detailKey(summary);
  const previous = detailsCache.get(key);
  if (previous) detailBytes -= previous.bytes;
  detailsCache.delete(key);
  const bytes = JSON.stringify(photo).length * 2;
  if (bytes > 2 * 1024 * 1024) return;
  detailsCache.set(key, { photo, bytes });
  detailBytes += bytes;
  while (detailsCache.size > 64 || detailBytes > 2 * 1024 * 1024) {
    const oldest = detailsCache.keys().next().value!;
    detailBytes -= detailsCache.get(oldest)!.bytes;
    detailsCache.delete(oldest);
  }
}

/** A large prompt is held only by its open viewer or the small LRU cache. */
export function useGalleryPhotoDetails(summary: GalleryPhoto, archived = false) {
  const key = `${archived ? "archive:" : ""}${detailKey(summary)}`;
  const [loaded, setLoaded] = useState<{ key: string; photo: GalleryPhoto } | null>(null);
  const cachedPhoto = !archived && summary.detailsDeferred ? detailsCache.get(key)?.photo : undefined;
  useEffect(() => {
    if (!summary.detailsDeferred) return;
    const cached = !archived && detailsCache.get(key);
    if (cached) {
      detailsCache.delete(key); detailsCache.set(key, cached);
      return;
    }
    const controller = new AbortController();
    void apiRequest<GalleryPhoto>(`/api/gallery/${archived ? "archive" : "photos"}/details?id=${encodeURIComponent(summary.id)}`, { signal: controller.signal })
      .then((photo) => {
        if (controller.signal.aborted || photo.id !== summary.id || photo.updatedAt !== summary.updatedAt) return;
        if (!archived) cacheDetails(summary, photo);
        setLoaded({ key, photo });
      }).catch(() => undefined);
    return () => controller.abort();
  }, [key, summary, archived]);
  const details = loaded?.key === key ? loaded.photo : cachedPhoto;
  return useMemo(() => summary.detailsDeferred && details ? { ...summary, prompt: details.prompt, model: details.model, shared: summary.shared ? { ...summary.shared, caption: details.shared?.caption } : undefined } : summary, [summary, details]);
}
const listeners = new Set<() => void>();
const promptListeners = new Set<(prompt: string) => void>();
const referenceListeners = new Set<(photos: Array<{ name: string; url: string }>) => void>();
const deletedPhotos = new Set<string>();
const deletionListeners = new Set<() => void>();

/** Also used for archive deletions, which do not update the gallery contents. */
export function notifyDeletedGalleryPhotos(ids: string[] = []) {
  const added = ids.filter((id) => !deletedPhotos.has(id));
  if (!added.length) return;
  added.forEach((id) => deletedPhotos.add(id));
  deletionListeners.forEach((listener) => listener());
}

export function keepGalleryChatPhoto(id: string) {
  return !deletedPhotos.has(id);
}

export function subscribeGalleryPhotoDeletions(listener: () => void) {
  deletionListeners.add(listener);
  return () => { deletionListeners.delete(listener); };
}

function setState(next: Partial<GalleryState>) {
  notifyDeletedGalleryPhotos(next.contents?.deletedPhotoIds);
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function applyGallery(contents: GalleryContents | undefined) {
  if (!contents) return;
  const previous = new Map(state.contents?.photos.map((photo) => [photo.id, photo]));
  const photos = contents.photos.map((photo) => {
    const summary = galleryPhotoSummary(photo);
    if (!photo.detailsDeferred) cacheDetails(summary, photo);
    const old = previous.get(photo.id);
    return old && JSON.stringify(old) === JSON.stringify(summary) ? old : summary;
  });
  const next = { ...contents, photos };
  catalogGeneration++;
  revision = "";
  setState({ contents: next, error: "" });
}

export function refreshGallery() {
  if (pendingRefresh) return pendingRefresh;
  const generation = catalogGeneration;
  setState({ loading: true });
  pendingRefresh = (async () => {
    let page = await apiRequest<GalleryCatalogPage>(`/api/gallery?catalog=1${revision ? `&revision=${encodeURIComponent(revision)}` : ""}`);
    if (page.revision && page.revision === revision && state.contents) return state.contents;
    const photos = [...page.photos];
    // Pages share a revision. Restart once if a mutation invalidated it mid-read.
    let restarted = false;
    while (page.cursor != null) {
      const next = await apiRequest<GalleryCatalogPage>(`/api/gallery?catalog=1&cursor=${page.cursor}&revision=${encodeURIComponent(page.revision)}`);
      if (next.reset) {
        if (restarted) throw new Error("The gallery changed while loading. Please try again.");
        restarted = true; photos.length = 0;
      }
      photos.push(...next.photos); page = next;
    }
    const contents = { root: page.root, albums: page.albums, photos, deletedPhotoIds: page.deletedPhotoIds };
    // A mutation that finished during pagination already installed newer contents.
    if (generation !== catalogGeneration) return state.contents;
    applyGallery(contents); revision = page.revision ?? "";
    return state.contents;
  })()
    .then((contents) => { setState({ loading: false, error: "" }); return contents; })
    .catch((error: Error) => { setState({ loading: false, error: error.message }); return null; })
    .finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}

/** The gallery as loaded, loading it first if nothing has asked for it yet. */
export async function loadedGallery() {
  return state.contents ?? await refreshGallery();
}

export function useGallery() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Lets the gallery hand a photo's prompt back to the generation panel. */
export function reusePrompt(prompt: string) {
  promptListeners.forEach((listener) => listener(prompt));
}

export function subscribeReusePrompt(listener: (prompt: string) => void) {
  promptListeners.add(listener);
  return () => { promptListeners.delete(listener); };
}

/** Lets the gallery send photos to the generation panel as reference photos. */
export function sendToReferences(photos: Array<{ name: string; url: string }>) {
  referenceListeners.forEach((listener) => listener(photos));
}

export function subscribeReferenceRequests(listener: (photos: Array<{ name: string; url: string }>) => void) {
  referenceListeners.add(listener);
  return () => { referenceListeners.delete(listener); };
}

/** A shared album to show: joined just now, or named by a notification (at a comment thread or photo). */
export type SharedAlbumRequest = { projectId: string; threadId?: string; fileId?: string };

let pendingAlbumRequest: SharedAlbumRequest | null = null;
const albumRequestListeners = new Set<(request: SharedAlbumRequest) => void>();

/** Asks the gallery to open a shared album; kept until a gallery view takes it (the panel may be opening). */
export function requestSharedAlbum(request: SharedAlbumRequest) {
  pendingAlbumRequest = request;
  void refreshGallery();
  albumRequestListeners.forEach((listener) => listener(request));
}

/** The gallery view takes requests as they come, and the one waiting when it mounts. */
export function subscribeSharedAlbumRequests(listener: (request: SharedAlbumRequest) => void) {
  albumRequestListeners.add(listener);
  if (pendingAlbumRequest) listener(pendingAlbumRequest);
  return () => { albumRequestListeners.delete(listener); };
}

/** The request was handled (its album is showing). */
export function settleSharedAlbumRequest(request: SharedAlbumRequest) {
  if (pendingAlbumRequest === request) pendingAlbumRequest = null;
}
