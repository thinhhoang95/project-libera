import { markdownAssetsFolder } from "@/lib/storage/asset-names";
import type { InkFrame } from "@/lib/ink/types";

/*
 * Markdown ink blocks (docs/ink-plan.md, "Markdown"). A block is an ordinary
 * Markdown image of its own rendering,
 *
 *   ![Ink](_assets/Notes/Lecture-3/ink-7f3c2a9q0d1e4b5c.svg)
 *
 * so other Markdown apps, previews and exports show the drawing. The strokes
 * are in `_ink/<note path>/block-<id>.<author>.ink`; the server rewrites the
 * SVG whenever they change. Free of Node imports: the Visual editor uses it.
 */

/** Blocks are drawn in logical px at 100% width; a wider or narrower column scales them. */
export const INK_BLOCK_WIDTH = 720;
export const INK_BLOCK_DEFAULT_HEIGHT = 240;
export const INK_BLOCK_MIN_HEIGHT = 80;
export const INK_BLOCK_MAX_HEIGHT = 6000;
/** A pen this close to the bottom grows the block by `INK_BLOCK_GROW_BY`. */
export const INK_BLOCK_GROW_MARGIN = 48;
export const INK_BLOCK_GROW_BY = 160;

// An asset copied beside an existing name gets `-1`, `-2`… (findAvailableFilePath).
const SOURCE = /(?:^|\/)ink-([a-z0-9]{6,32})(?:-\d+)?\.svg$/i;

/** The block id of an ink block's image source, or null for any other image. */
export function parseInkBlockSource(src: string): string | null {
  const path = src.split(/[?#]/, 1)[0];
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* keep as written */ }
  // Sources resolved for the browser carry the asset in a query string.
  const asset = /[?&]asset=([^&]+)/.exec(src)?.[1];
  let candidate = decoded;
  if (asset) {
    try { candidate = decodeURIComponent(asset); } catch { return null; }
  }
  return SOURCE.exec(candidate)?.[1]?.toLowerCase() ?? null;
}

/** Whether a file name is an ink block rendering, the one kind of SVG a note may show. */
export function isInkBlockRenderingName(name: string) {
  return SOURCE.test(`/${name}`);
}

export function inkBlockChunk(id: string) {
  return `block-${id}`;
}

/** The image source for a new block in a note: the note's assets folder, relative to the notebook. */
export function inkBlockSource(documentPath: string, id: string) {
  const [, ...parts] = documentPath.split("/");
  return `${markdownAssetsFolder(parts)}/ink-${id}.svg`;
}

export function inkBlockFrame(height = INK_BLOCK_DEFAULT_HEIGHT): InkFrame {
  return { unit: "px", width: INK_BLOCK_WIDTH, height: clampInkBlockHeight(height) };
}

export function clampInkBlockHeight(height: number) {
  return Math.round(Math.min(INK_BLOCK_MAX_HEIGHT, Math.max(INK_BLOCK_MIN_HEIGHT, height)));
}
