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

function setState(next: Partial<GalleryState>) {
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
