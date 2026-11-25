import { collabHostConfig, getHostStatus, listProjectEntries, livePdfSnapshot, resolveSharedPdf } from "@/lib/collab/host-client";
import type { FileListEntry } from "@/lib/collab/local-api";
import { notebookHasLivePdfs, sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { foldedFileName } from "@/lib/storage/file-names";

// What Check Notebook, Try to fix and Acknowledge ask the collaboration host
// about a shared notebook, read only: the manifest (the authoritative file
// list), whether this computer's sync is keeping up, and a live PDF's marks.
// An answer that cannot be had is returned as such, never as an empty list:
// the callers report a partial check, or refuse a destructive step.

/** The manifest of a shared notebook, with its entries at library paths (`Notebook/sub/file.md`). */
export type ManifestView =
  | {
    state: "ok";
    /** Files (documents and blobs) by library path. */
    files: Map<string, FileListEntry>;
    folders: Set<string>;
    /** What the listing is, in one string: two equal stamps are one manifest state. */
    stamp: string;
  }
  | { state: "unavailable"; reason: string };

type OkView = Extract<ManifestView, { state: "ok" }>;
type FoldedIndex = { files: Map<string, FileListEntry>; folders: Set<string> };
const foldedIndexes = new WeakMap<OkView, FoldedIndex>();

/** A library path under the round's one name rule (NFC plus case folding, per segment). */
const foldedPath = (libraryPath: string) => libraryPath.split("/").map(foldedFileName).join("/");

function foldedIndex(view: OkView): FoldedIndex {
  let index = foldedIndexes.get(view);
  if (!index) {
    index = { files: new Map(), folders: new Set() };
    for (const [libraryPath, entry] of view.files) {
      const folded = foldedPath(libraryPath);
      if (!index.files.has(folded)) index.files.set(folded, entry);
      // A folder holding a listed file is listed too.
      const parts = folded.split("/");
      for (let length = 2; length < parts.length; length += 1) index.folders.add(parts.slice(0, length).join("/"));
    }
    for (const folder of view.folders) index.folders.add(foldedPath(folder));
    foldedIndexes.set(view, index);
  }
  return index;
}

/** The manifest's entry for a file: the exact path, else the one that is the same name under the name rule (an OS alias of it). */
export function manifestFile(view: OkView, libraryPath: string): FileListEntry | undefined {
  return view.files.get(libraryPath) ?? foldedIndex(view).files.get(foldedPath(libraryPath));
}

export const manifestHasFile = (view: OkView, libraryPath: string) => manifestFile(view, libraryPath) !== undefined;

/** Whether the manifest lists a folder (a listed file under it makes it one), under the name rule. */
export const manifestHasFolder = (view: OkView, libraryPath: string) => view.folders.has(libraryPath) || foldedIndex(view).folders.has(foldedPath(libraryPath));

/** The host's own word on whether this computer keeps up. Null when it can't be read. */
export type SharedSync = { connected: boolean; reconcilePending: number; revoked: boolean; role: string } | null;

/** An entry newer than this may still be on its way to the disk, whatever the host says. */
export const RECENT_ENTRY_MS = 2 * 60 * 1000;

/** The manifest, read once. Read only: it is the host's file-list route. */
export async function readManifestView(notebook: string): Promise<ManifestView> {
  const marker = sharedNotebookMarker(notebook);
  if (!marker?.projectId) return { state: "unavailable", reason: "This notebook's sharing details can't be read." };
  if (marker.revoked) return { state: "unavailable", reason: "Access to this shared notebook was revoked." };
  const config = collabHostConfig();
  if (!config) return { state: "unavailable", reason: "Collaboration is not running in this Libera." };
  let entries: FileListEntry[];
  try {
    const result = await listProjectEntries(marker.projectId, config);
    if (!result || !Array.isArray(result.entries)) return { state: "unavailable", reason: "The host did not return the shared notebook's file list." };
    entries = result.entries;
    // A move or removal made here that the server has not acknowledged yet: the records kept on this computer follow it
    // once it is, so they are still where the list before it had them, and judging them against the list now would call
    // them leftovers. Not judged, so nothing is offered for removal on its account (S-C2).
    if (result.awaitingServer) return { state: "unavailable", reason: "A change to this shared notebook's files is waiting for the server to confirm it, so the records kept for those files can't be judged yet. Check again once it has." };
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  const files = new Map<string, FileListEntry>();
  const folders = new Set<string>();
  for (const entry of entries) {
    const libraryPath = `${notebook}/${entry.path}`;
    if (entry.kind === "folder") folders.add(libraryPath);
    else files.set(libraryPath, { ...entry, path: libraryPath });
  }
  const stamp = JSON.stringify([...files.values()].map((entry) => [entry.path, entry.fileId, entry.kind, entry.blobHash ?? "", entry.docId ?? ""]).sort()) + JSON.stringify([...folders].sort());
  return { state: "ok", files, folders, stamp };
}

/** Whether the host says this computer is caught up. */
export async function readSharedSync(notebook: string): Promise<SharedSync> {
  const marker = sharedNotebookMarker(notebook);
  const config = collabHostConfig();
  if (!marker?.projectId || !config) return null;
  try {
    const status = await getHostStatus(config);
    const project = status.projects.find((candidate) => candidate.projectId === marker.projectId);
    if (!project) return null;
    return { connected: status.connection === "connected", reconcilePending: project.reconcilePending ?? 0, revoked: project.revoked, role: project.role };
  } catch { return null; }
}

/**
 * Whether a file the manifest lists but the disk does not have (or has in
 * another version) is probably still being delivered: the host is not
 * connected, it holds files to reconcile, or the entry is new. `unknown` when
 * the host could not be asked, so it can't be told from a real gap.
 */
export function mayBeArriving(entry: Pick<FileListEntry, "updatedAt">, sync: SharedSync, now = Date.now()): boolean | "unknown" {
  if (!sync) return "unknown";
  if (!sync.connected || sync.reconcilePending > 0) return true;
  return now - entry.updatedAt < RECENT_ENTRY_MS;
}

/**
 * The marks (ids) a live PDF has now, from the live document. `sidecar` when
 * the notebook keeps marks in the sidecar (the sidecar is the authority
 * then); `unknown` when the live document can't be asked.
 */
export async function livePdfMarkIds(libraryPath: string): Promise<{ state: "ids"; ids: Set<string> } | { state: "sidecar" } | { state: "unknown" }> {
  const [notebook] = libraryPath.split("/");
  if (!notebookHasLivePdfs(notebook)) return { state: "sidecar" };
  const config = collabHostConfig();
  if (!config) return { state: "unknown" };
  try {
    const resolved = await resolveSharedPdf(libraryPath, config);
    if (!resolved) return { state: "unknown" };
    const snapshot = await livePdfSnapshot(resolved.docId, config);
    if (!snapshot || !Array.isArray(snapshot.marks)) return { state: "unknown" };
    return { state: "ids", ids: new Set(snapshot.marks.flatMap((mark) => typeof (mark as { id?: unknown })?.id === "string" ? [(mark as { id: string }).id] : [])) };
  } catch { return { state: "unknown" }; }
}

/** Side files the host owns in a shared notebook: manifest companions (ink, transcripts) and a live PDF's marks. Everything else is this computer's. */
export function hostOwnsSideFile(kind: string, notebook: string): boolean {
  return kind === "ink" || kind === "transcript" || kind === "transcript-companion" || (kind === "pdf-annotations" && notebookHasLivePdfs(notebook));
}
