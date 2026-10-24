// Comments on photos in a shared album are ordinary comment threads on the
// album's manifest document. Their anchor id names the photo (its fileId)
// and, for a comment on part of the photo, the region: x, y, width and
// height in thousandths of the photo's size. Anchor ids are 8 to 80
// letters, digits, "_" or "-", so this fits: "fil_…-r120-80-300-250".

export type PhotoRegion = { x: number; y: number; width: number; height: number };

const REGION = /-r(\d{1,4})-(\d{1,4})-(\d{1,4})-(\d{1,4})$/;
const SCALE = 1000;

const clamp = (value: number) => Math.min(SCALE, Math.max(0, Math.round(value * SCALE)));

/** The anchor id of a comment on a photo, or on a region of it (fractions of its width and height). */
export function photoAnchorId(fileId: string, region?: PhotoRegion | null): string {
  if (!region) return fileId;
  const x = clamp(region.x);
  const y = clamp(region.y);
  return `${fileId}-r${x}-${y}-${Math.max(1, Math.min(SCALE - x, clamp(region.width)))}-${Math.max(1, Math.min(SCALE - y, clamp(region.height)))}`;
}

/** The photo and region an anchor id names. */
export function parsePhotoAnchor(anchorId: string): { fileId: string; region: PhotoRegion | null } {
  const match = REGION.exec(anchorId);
  if (!match) return { fileId: anchorId, region: null };
  const [x, y, width, height] = match.slice(1).map((value) => Number(value) / SCALE);
  return { fileId: anchorId.slice(0, match.index), region: { x, y, width, height } };
}
