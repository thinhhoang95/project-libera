"use client";

import { useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { GalleryContents } from "@/lib/image-generation";

/**
 * The generation panel and the gallery view share one copy of the gallery, so
 * a new image or album appears in both without either owning the other.
 */
type GalleryState = { contents: GalleryContents | null; loading: boolean; error: string };

let state: GalleryState = { contents: null, loading: false, error: "" };
let pendingRefresh: Promise<GalleryContents | null> | null = null;
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
  if (contents) setState({ contents, error: "" });
}

export function refreshGallery() {
  if (pendingRefresh) return pendingRefresh;
  setState({ loading: true });
  pendingRefresh = apiRequest<GalleryContents>("/api/gallery")
    .then((contents) => { setState({ contents, loading: false, error: "" }); return contents; })
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
