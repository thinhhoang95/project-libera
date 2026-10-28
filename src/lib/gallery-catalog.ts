import type { ArchiveContents, GalleryContents, GalleryPhoto } from "./image-generation";

/** Keep large text out of the catalog, including shared-photo captions. */
export function galleryPhotoSummary(photo: GalleryPhoto): GalleryPhoto {
  if (photo.detailsDeferred) return photo;
  const { prompt, model, shared, ...summary } = photo;
  const { caption, ...sharing } = shared ?? {};
  // Text edits may change independently of the image file's mtime.
  let version = 2166136261;
  const text = JSON.stringify([prompt, model, caption]);
  for (let index = 0; index < text.length; index++) version = Math.imul(version ^ text.charCodeAt(index), 16777619);
  return { ...summary, ...(shared ? { shared: sharing as NonNullable<GalleryPhoto["shared"]> } : {}), detailsDeferred: true, detailsVersion: (version >>> 0).toString(36) };
}

export function gallerySummary(contents: GalleryContents): GalleryContents {
  return { ...contents, photos: contents.photos.map(galleryPhotoSummary) };
}

export function archiveSummary(contents: ArchiveContents): ArchiveContents {
  return { ...contents, photos: contents.photos.map(galleryPhotoSummary) };
}

export type GalleryCatalogPage = GalleryContents & { revision: string; cursor: number | null; reset?: boolean };
