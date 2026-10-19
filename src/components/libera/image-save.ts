"use client";

import { apiRequest } from "@/components/libera/api-client";
import { applyGallery, loadedGallery } from "@/components/libera/gallery-store";
import type { GalleryAlbum, GalleryContents } from "@/lib/image-generation";

/**
 * Where an image viewer's Save menu can send the image besides the computer:
 * a notebook image goes to the Gallery (or one of its albums), a gallery photo
 * goes to a notebook folder.
 */
export type ImageSaveDestination = "gallery" | "notebook";

export type ImageSaveSource = { name: string; src: string };

type NativeMenuItems = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"];

const COMPUTER_ID = "save-image:computer";
const GALLERY_ID = "save-image:gallery";
const NOTEBOOK_ID = "save-image:notebook";
const ALBUM_PREFIX = "save-image:album:";
const NEW_ALBUM_ID = "save-image:new-album";

export function downloadImage({ name, src }: ImageSaveSource) {
  const link = document.createElement("a");
  link.href = src;
  link.download = name;
  link.click();
}

export async function imageFile({ name, src }: ImageSaveSource) {
  const response = await fetch(src);
  if (!response.ok) throw new Error("Could not load the image.");
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

/** Adds a copy of the image to the gallery, or to one of its albums. */
export async function saveImageToGallery(source: ImageSaveSource, albumId = "") {
  const body = new FormData();
  body.set("albumId", albumId);
  body.append("files", await imageFile(source));
  const result = await apiRequest<{ failed: Array<{ error: string }>; gallery: GalleryContents }>("/api/gallery/photos/upload", { method: "POST", body });
  applyGallery(result.gallery);
  if (result.failed.length) throw new Error(result.failed[0].error);
}

// The app shell owns the notebook tree, so it shows the folder picker; viewers
// ask for it here instead of each threading the workspace through.
const notebookSaveListeners = new Set<(source: ImageSaveSource) => void>();

export function requestSaveToNotebook(source: ImageSaveSource) {
  notebookSaveListeners.forEach((listener) => listener(source));
}

export function subscribeSaveToNotebook(listener: (source: ImageSaveSource) => void) {
  notebookSaveListeners.add(listener);
  return () => { notebookSaveListeners.delete(listener); };
}

/** Makes an album and saves the image into it. */
export async function saveImageToNewAlbum(source: ImageSaveSource, name: string) {
  const { album, gallery } = await apiRequest<{ album: GalleryAlbum; gallery: GalleryContents }>("/api/gallery/albums", { method: "POST", body: JSON.stringify({ name, photoIds: [] }) });
  applyGallery(gallery);
  await saveImageToGallery(source, album.id);
  return album;
}

// Naming a new album needs a text field, which a native menu cannot hold.
const newAlbumListeners = new Set<(source: ImageSaveSource) => void>();

export function subscribeSaveToNewAlbum(listener: (source: ImageSaveSource) => void) {
  newAlbumListeners.add(listener);
  return () => { newAlbumListeners.delete(listener); };
}

/** The Save menu's items. Albums come from the gallery, loaded if need be. */
export async function imageSaveMenuItems(destination: ImageSaveDestination): Promise<NativeMenuItems> {
  if (destination === "notebook") {
    return [
      { id: COMPUTER_ID, label: "Save to Computer…" },
      { id: NOTEBOOK_ID, label: "Save to Notebook Folder…" },
    ];
  }
  const albums = (await loadedGallery())?.albums ?? [];
  return [
    { id: COMPUTER_ID, label: "Save to Computer…" },
    { id: GALLERY_ID, label: "Save to Gallery" },
    {
      id: "save-image:albums",
      label: "Save to Album",
      submenu: [
        ...albums.map((album) => ({ id: `${ALBUM_PREFIX}${album.id}`, label: album.name })),
        ...(albums.length ? [{ type: "separator" as const }] : []),
        { id: NEW_ALBUM_ID, label: "New Album…" },
      ],
    },
  ];
}

/**
 * Runs a Save menu choice. Resolves to a message to show, or null when the
 * choice needs none (a download, the folder picker) or was not a Save item.
 */
export async function runImageSaveMenuAction(id: string | null, source: ImageSaveSource): Promise<string | null> {
  if (id === COMPUTER_ID) {
    downloadImage(source);
  } else if (id === NOTEBOOK_ID) {
    requestSaveToNotebook(source);
  } else if (id === NEW_ALBUM_ID) {
    newAlbumListeners.forEach((listener) => listener(source));
  } else if (id === GALLERY_ID || id?.startsWith(ALBUM_PREFIX)) {
    const albumId = id === GALLERY_ID ? "" : id.slice(ALBUM_PREFIX.length);
    const album = albumId ? (await loadedGallery())?.albums.find((item) => item.id === albumId) : undefined;
    try {
      await saveImageToGallery(source, albumId);
      return album ? `Saved to “${album.name}”` : "Saved to the Gallery";
    } catch (failure) {
      return failure instanceof Error ? failure.message : "Could not save to the Gallery.";
    }
  }
  return null;
}

/** Opens the Save menu under `button`, or downloads where there is no native menu. */
export async function openImageSaveMenu(button: HTMLElement, destination: ImageSaveDestination, source: ImageSaveSource) {
  const menu = window.liberaMenu;
  if (!menu) {
    downloadImage(source);
    return null;
  }
  const rect = button.getBoundingClientRect();
  const items = await imageSaveMenuItems(destination);
  const id = await menu.popup({ x: Math.round(rect.left), y: Math.round(rect.bottom), items }).catch(() => null);
  return runImageSaveMenuAction(id, source);
}

// The tab's ⋯ menu saves on behalf of the image viewer below it, which shows the result.
const noticeListeners = new Set<(notice: { src: string; message: string }) => void>();

export function announceImageSaved(src: string, message: string) {
  noticeListeners.forEach((listener) => listener({ src, message }));
}

export function subscribeImageSaved(listener: (notice: { src: string; message: string }) => void) {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}
