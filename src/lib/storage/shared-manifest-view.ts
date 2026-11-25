import { collabHostConfig, getHostStatus, listProjectEntries, livePdfSnapshot, resolveSharedPdf } from "@/lib/collab/host-client";
import type { FileListEntry } from "@/lib/collab/local-api";
import { notebookHasLivePdfs, sharedNotebookMarker } from "@/lib/collab/shared-notebook";

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
export function mayBeArriving(entry: Pick<FileListEntry, "updatedAt">, sync: SharedSync, now = Date.now(), held?: FileHold): boolean | "unknown" {
  if (!sync) return "unknown";
  if (!sync.connected) return true;
  // Open reconciliations are per file: with the host's records for this notebook, only the files they name are held (one unrelated reconciliation does not excuse every gap). Without them, any pending one may concern this file.
  if (sync.reconcilePending > 0 && (!held || held.reconciling)) return true;
  // The disk copy changed a moment ago: the host has not taken that change yet.
  if (held?.diskChangedAt !== undefined && now - held.diskChangedAt < RECENT_ENTRY_MS) return true;
  return now - entry.updatedAt < RECENT_ENTRY_MS;
}

/** What is known about one file besides the manifest: whether an open reconciliation names it, and when its disk copy last changed. */
export type FileHold = { reconciling?: boolean; diskChangedAt?: number };

/** What the host recorded of the bytes it last wrote for a file (state.json's layout), and the files it holds in an open reconciliation. */
export type HostRecords = {
  layout: Map<string, { hash?: string; size?: number; mtimeMs?: number }>;
  /** Folded library paths (`Notebook/sub/file.md`, as the host's `liberaPath` writes them) of the files in an open reconciliation. */
  reconciling: Set<string>;
};

/**
 * The host's own bookkeeping (`.libera/collab/state.json` of the notebook), parsed read only from text the caller read within its
 * budget. Null when it is not usable: the caller then judges with the manifest alone and keeps the notebook-wide reading of
 * `reconcilePending`.
 */
export function parseHostRecords(text: string | null, fold: (name: string) => string): HostRecords | null {
  if (!text) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const state = value as { version?: unknown; layout?: Record<string, { hash?: unknown; size?: unknown; mtimeMs?: unknown }>; reconciliations?: Array<{ path?: unknown }> } | null;
  if (!state || state.version !== 1 || !state.layout || typeof state.layout !== "object" || !Array.isArray(state.reconciliations)) return null;
  const layout: HostRecords["layout"] = new Map();
  for (const [fileId, record] of Object.entries(state.layout)) {
    if (!record || typeof record !== "object") continue;
    layout.set(fileId, {
      ...(typeof record.hash === "string" ? { hash: record.hash } : {}),
      ...(typeof record.size === "number" ? { size: record.size } : {}),
      ...(typeof record.mtimeMs === "number" ? { mtimeMs: record.mtimeMs } : {}),
    });
  }
  const reconciling = new Set<string>();
  for (const item of state.reconciliations) if (typeof item?.path === "string") reconciling.add(fold(item.path.replace(/^\/+/, "")));
  return { layout, reconciling };
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
  return kind === "ink" || kind === "transcript" || (kind === "pdf-annotations" && notebookHasLivePdfs(notebook));
}
