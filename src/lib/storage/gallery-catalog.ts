import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { gallerySummary, type GalleryCatalogPage } from "@/lib/gallery-catalog";
import type { GalleryContents } from "@/lib/image-generation";
import { getGallery, getGalleryRoot } from "./gallery";
import { withSharing } from "./gallery-sharing";

const PAGE_SIZE = 500;
let snapshot: { root: string; identity: string; revision: string; contents: GalleryContents } | null = null;
let pending: Promise<NonNullable<typeof snapshot>> | null = null;

async function identity(root: string) {
  const stats = await stat(path.join(root, ".libera-gallery.json")).catch(() => null);
  return stats ? `${stats.ino}:${stats.mtimeMs}:${stats.size}` : "";
}

/** One compact snapshot; continuation pages never rescan the folder. */
export async function galleryCatalogPage(cursor = 0, revision = ""): Promise<GalleryCatalogPage> {
  const root = getGalleryRoot();
  let current = snapshot;
  if (!cursor || !current || current.root !== root || current.identity !== await identity(root)) {
    pending ??= (async () => {
      const contents = gallerySummary(await withSharing(await getGallery({ incremental: true })));
      const current = { root, identity: await identity(root), contents, revision: createHash("sha1").update(JSON.stringify(contents)).digest("hex") };
      snapshot = current;
      return current;
    })().finally(() => { pending = null; });
    current = await pending;
  }
  const reset = cursor > 0 && revision !== current.revision;
  const offset = reset ? 0 : cursor;
  const unchanged = !cursor && revision === current.revision;
  return {
    root: current.contents.root, albums: current.contents.albums,
    photos: unchanged ? [] : current.contents.photos.slice(offset, offset + PAGE_SIZE),
    deletedPhotoIds: current.contents.deletedPhotoIds,
    revision: current.revision, reset,
    cursor: !unchanged && offset + PAGE_SIZE < current.contents.photos.length ? offset + PAGE_SIZE : null,
  };
}
