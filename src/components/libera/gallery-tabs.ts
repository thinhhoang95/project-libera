import type { OpenTab, OpenTabViewState } from "./types";
import { galleryRawUrl, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";

/**
 * Gallery photos open as read-only image tabs so they can share the canvas
 * (and its splits) with notebook files. They are not notebook files: the tab
 * id and file path use a reserved prefix, the notebook is empty, and the
 * `gallery` marker is what code checks before treating a tab as a file on disk.
 */
export const GALLERY_TAB_PREFIX = "gallery:";

export type GalleryOpenTab = OpenTab & { gallery: { photoId: string } };
export type GalleryTabPlacement = "tab" | "right" | "bottom";

export function galleryTabId(photoId: string) {
  return `${GALLERY_TAB_PREFIX}${photoId}`;
}

export function isGalleryTab(tab: OpenTab | null | undefined): tab is GalleryOpenTab {
  return Boolean(tab?.gallery);
}

export function createGalleryTab(photo: GalleryPhoto, viewState?: OpenTabViewState): GalleryOpenTab {
  const id = galleryTabId(photo.id);
  return {
    id,
    gallery: { photoId: photo.id },
    file: {
      kind: "file", name: photo.name, path: id, notebook: "", fileType: "image",
      createdAt: photo.createdAt, updatedAt: photo.updatedAt, size: photo.size,
    },
    draft: "",
    saved: "",
    rawUrl: galleryRawUrl(photo),
    status: "clean",
    viewState,
  };
}

/**
 * Lines open gallery tabs up with the gallery. Photos that moved into an album
 * folder, were renamed or edited keep their tab with a fresh name and URL;
 * tabs whose photo is gone are listed in `closedTabIds` for the caller to close.
 */
export function reconcileGalleryTabs(tabs: OpenTab[], photos: GalleryPhoto[]) {
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  const closedTabIds: string[] = [];
  let changed = false;
  const next = tabs.map((tab) => {
    if (!isGalleryTab(tab)) return tab;
    const photo = photoById.get(tab.gallery.photoId);
    if (!photo) {
      closedTabIds.push(tab.id);
      return tab;
    }
    const fresh = createGalleryTab(photo);
    if (fresh.rawUrl === tab.rawUrl && fresh.file.name === tab.file.name && fresh.file.updatedAt === tab.file.updatedAt && fresh.file.size === tab.file.size) return tab;
    changed = true;
    return { ...tab, file: fresh.file, rawUrl: fresh.rawUrl };
  });
  return { tabs: changed ? next : tabs, closedTabIds };
}

/**
 * Restores a saved gallery tab. A photo deleted while Libera was closed drops
 * its tab; when the gallery cannot be read the tab is kept as saved and the
 * next gallery refresh decides.
 */
export function restoreGalleryTab(tab: GalleryOpenTab, gallery: GalleryContents | null): OpenTab | null {
  if (!gallery) return { ...tab, draft: "", saved: "", status: "clean" };
  const photo = gallery.photos.find((item) => item.id === tab.gallery.photoId);
  return photo ? createGalleryTab(photo, tab.viewState) : null;
}
