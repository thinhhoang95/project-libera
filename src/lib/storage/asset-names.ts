import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";

// How a note's assets folder is named: `_assets/<folders>/<note stem>`, with
// each segment reduced to letters, digits, ".", "_" and "-". Free of Node
// imports: the Visual editor needs it too (lib/python/sidecar.ts).

export function markdownAssetSafeSegment(segment: string, fallback = "asset") {
  const normalized = segment
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

/** `analysis.md` → `analysis`, as `path.basename(name, path.extname(name))`. */
export function fileStem(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function markdownAssetsDirectoryName(markdownName: string) {
  return markdownAssetSafeSegment(fileStem(markdownName), "note");
}

/**
 * A note's Python sidecar, `_assets/…/<note>/<note>.py` (lib/python/sidecar.ts):
 * the one kind of file in _assets that opens, saves and is edited by the
 * agent like a file of the notebook. The tree and search still leave it out.
 */
export function isAssetSidecarPath(pathParts: readonly string[]) {
  return pathParts.length >= 3 && pathParts[0] === MARKDOWN_ASSETS_DIR && /\.py$/i.test(pathParts.at(-1) ?? "");
}

/** A note's assets folder relative to its notebook; image sources start with it. */
export function markdownAssetsFolder(markdownPathParts: string[]) {
  return [
    MARKDOWN_ASSETS_DIR,
    ...markdownPathParts.slice(0, -1).map((part) => markdownAssetSafeSegment(part)),
    markdownAssetsDirectoryName(markdownPathParts.at(-1) ?? ""),
  ].join("/");
}
