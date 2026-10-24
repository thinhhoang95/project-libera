import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { recordPdfAnnotationsSource } from "@/lib/storage/annotations";
import { getFileType } from "@/lib/storage/file-types";
import { moveFileIfExists, pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import { cachedPdfIdentity, parsePdfIdentity, type PdfIdentity } from "@/lib/storage/pdf-identity";
import {
  definitionsDirectoryPath,
  definitionsPath,
  filePathFromParts,
  notebookPath,
  notebookSystemDirectoryPath,
  orphanedSidecarsDirectoryPath,
  pdfAnnotationsDirectoryPath,
  pdfAnnotationsPath,
  pdfOutlinePath,
  pdfOutlinesDirectoryPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { deletePdfTextCache, movePdfTextCache } from "@/lib/storage/pdf-text-cache";

// A PDF's side-cars on this computer — its annotations and comment threads,
// its generated outline, its definitions cards, and the disposable text cache
// — are stored by the PDF's path. Libera takes them along when it renames,
// moves, copies, archives or deletes the PDF itself (files.ts). This module
// covers the moves it does not make:
//
// - A shared notebook's collab host moved or removed the PDF (a collaborator,
//   or this user through the host): followSharedPdfChanges, from the host's
//   tree-changed events. A removed PDF's side-cars are set aside, not deleted.
// - The PDF was renamed, moved or deleted outside Libera (Finder, Explorer, a
//   sync client): reconcilePdfSidecars, on every library refresh. A side-car
//   whose PDF is gone goes to the PDF with the same bytes (the size and
//   SHA-256 it recorded), when exactly one PDF in the notebook without that
//   kind of side-car has them. Otherwise, after a short grace period, it is
//   set aside in `.libera/orphaned-sidecars/<kind>/`, so a different PDF later
//   saved under the old name does not inherit it, and it is put back if its
//   PDF returns (from the trash, say) within ORPHAN_RETENTION_MS.

export type PdfSidecarKind = "annotations" | "outline" | "definitions";

type KindStore = {
  kind: PdfSidecarKind;
  path: (notebook: string, pathParts: string[]) => string;
  directory: (notebook: string) => string;
};

const KINDS: KindStore[] = [
  { kind: "annotations", path: pdfAnnotationsPath, directory: (notebook) => pdfAnnotationsDirectoryPath(notebook) },
  { kind: "outline", path: pdfOutlinePath, directory: (notebook) => pdfOutlinesDirectoryPath(notebook) },
  { kind: "definitions", path: definitionsPath, directory: (notebook) => definitionsDirectoryPath(notebook, []) },
];

/** A side-car whose PDF went missing is set aside only after this long, so an in-progress move is not mistaken for one. */
export const ORPHAN_GRACE_MS = 30_000;
/** Set-aside side-cars are kept this long for their PDF to come back. */
export const ORPHAN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Set-aside side-cars are matched against the notebook at most this often when nothing new went missing. */
const STORED_ORPHAN_SCAN_MS = 60_000;

type OrphanRecord = {
  kind: PdfSidecarKind;
  /** The PDF's library path when it went missing. */
  originalPath: string;
  orphanedAt: string;
  source: PdfIdentity | null;
  sidecar: unknown;
};

const isPdfSidecarName = (name: string) => /\.pdf\.json$/i.test(name);

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

const sidecarIdentity = (json: unknown) => parsePdfIdentity((json as { source?: unknown } | null)?.source);

/** Sets a side-car aside, with where it came from. */
async function setAside(notebook: string, store: KindStore, sidecarPath: string, originalPath: string) {
  const json = await readJson(sidecarPath);
  if (json === null) return;
  const record: OrphanRecord = { kind: store.kind, originalPath, orphanedAt: new Date().toISOString(), source: sidecarIdentity(json), sidecar: json };
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}-${path.basename(sidecarPath)}`;
  await writeJsonAtomically(path.join(orphanedSidecarsDirectoryPath(notebook, store.kind), name), record);
  await rm(sidecarPath, { force: true });
}

/**
 * Moves (or sets aside) a PDF's side-cars after the collab host moved or
 * removed it in a shared notebook. Returns how many paths it handled.
 */
export async function followSharedPdfChanges(moves: Array<{ from: string; to: string }>, removed: string[]) {
  let changed = 0;
  for (const { from, to } of moves) {
    try {
      if (getFileType(from) !== "pdf" || from === to) continue;
      const source = splitFilePath(from);
      const target = splitFilePath(to);
      const stillPdf = getFileType(to) === "pdf";
      for (const store of KINDS) {
        const current = store.path(source.notebook, source.pathParts);
        if (stillPdf) await moveFileIfExists(current, store.path(target.notebook, target.pathParts));
        else await setAside(source.notebook, store, current, from);
      }
      if (stillPdf) await movePdfTextCache(source.notebook, source.pathParts, target.notebook, target.pathParts);
      else await deletePdfTextCache(source.notebook, source.pathParts);
      changed += 1;
    } catch {
      // A path that is not a library file: nothing of ours to move.
    }
  }
  for (const gone of removed) {
    try {
      if (getFileType(gone) !== "pdf") continue;
      const { notebook, pathParts } = splitFilePath(gone);
      for (const store of KINDS) {
        const sidecar = store.path(notebook, pathParts);
        if (await pathExists(sidecar)) await setAside(notebook, store, sidecar, gone);
      }
      await deletePdfTextCache(notebook, pathParts);
      changed += 1;
    } catch {
      // As above.
    }
  }
  return changed;
}

/** Deletes a PDF's side-cars on this computer, as deleting it in Libera does. */
export async function deletePdfSidecars(libraryPath: string) {
  const { notebook, pathParts } = splitFilePath(libraryPath);
  for (const store of KINDS) await rm(store.path(notebook, pathParts), { force: true });
  await deletePdfTextCache(notebook, pathParts);
}

// ---------------------------------------------------------------------------
// Library refresh
// ---------------------------------------------------------------------------

/** When each orphaned side-car was first seen without its PDF, by side-car path. */
const missingSince = new Map<string, number>();
const lastStoredScan = new Map<string, number>();
const backfilled = new Set<string>();

type Found = { store: KindStore; sidecarPath: string; libraryPath: string };

async function listSidecars(notebook: string, store: KindStore): Promise<Found[]> {
  const found: Found[] = [];
  async function visit(directory: string, parts: string[]) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, [...parts, entry.name]);
      else if (entry.isFile() && isPdfSidecarName(entry.name)) {
        found.push({ store, sidecarPath: target, libraryPath: relativeFilePath(notebook, [...parts, entry.name.slice(0, -5)]) });
      }
    }
  }
  await visit(store.directory(notebook), []);
  return found;
}

async function pdfExists(libraryPath: string): Promise<boolean | null> {
  try {
    const { notebook, pathParts } = splitFilePath(libraryPath);
    return (await stat(filePathFromParts(notebook, pathParts))).isFile();
  } catch (error) {
    // Unreadable (offline drive, permissions): not known to be gone.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
}

async function readOrphans(notebook: string) {
  const orphans: Array<{ file: string; record: OrphanRecord }> = [];
  for (const store of KINDS) {
    const directory = orphanedSidecarsDirectoryPath(notebook, store.kind);
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(directory, name);
      const record = await readJson(file) as OrphanRecord | null;
      if (record && typeof record.originalPath === "string" && record.kind === store.kind) orphans.push({ file, record: { ...record, source: parsePdfIdentity(record.source) } });
    }
  }
  return orphans;
}

/**
 * Re-attaches or sets aside the side-cars of PDFs that were renamed, moved or
 * deleted outside Libera. `pdfFiles` are the notebook's PDFs (library path and
 * size). Cheap when nothing is missing: a directory listing and a stat per
 * side-car; PDFs are hashed only when their size matches a missing PDF's.
 */
export async function reconcilePdfSidecars(notebook: string, pdfFiles: Array<{ path: string; size: number }>, { now = Date.now() }: { now?: number } = {}) {
  const withSidecar = new Map<PdfSidecarKind, Set<string>>(KINDS.map((store) => [store.kind, new Set<string>()]));
  const missing: Found[] = [];
  const lacksIdentity: string[] = [];
  for (const store of KINDS) {
    for (const found of await listSidecars(notebook, store)) {
      const exists = await pdfExists(found.libraryPath);
      if (exists === false) missing.push(found);
      else {
        withSidecar.get(store.kind)!.add(found.libraryPath.toLowerCase());
        if (exists && store.kind === "annotations" && !backfilled.has(notebook)) lacksIdentity.push(found.libraryPath);
      }
    }
  }
  // Annotations saved before they recorded their PDF's identity get it once, in the background.
  if (!backfilled.has(notebook)) {
    backfilled.add(notebook);
    void (async () => {
      for (const libraryPath of lacksIdentity) {
        const { notebook: owner, pathParts } = splitFilePath(libraryPath);
        const json = await readJson(pdfAnnotationsPath(owner, pathParts));
        if (!sidecarIdentity(json)) await recordPdfAnnotationsSource(libraryPath).catch(() => undefined);
      }
    })();
  }
  for (const key of missingSince.keys()) if (!missing.some((found) => found.sidecarPath === key) && key.startsWith(notebookPrefix(notebook))) missingSince.delete(key);

  const scanStored = missing.length > 0 || now - (lastStoredScan.get(notebook) ?? 0) >= STORED_ORPHAN_SCAN_MS;
  const stored = scanStored ? await readOrphans(notebook) : [];
  if (scanStored) lastStoredScan.set(notebook, now);
  if (!missing.length && !stored.length) return { reattached: 0, setAside: 0 };

  const hashes = new Map<string, Promise<PdfIdentity | null>>();
  const identityOf = (libraryPath: string) => {
    if (!hashes.has(libraryPath)) {
      const { notebook: owner, pathParts } = splitFilePath(libraryPath);
      hashes.set(libraryPath, cachedPdfIdentity(filePathFromParts(owner, pathParts)).catch(() => null));
    }
    return hashes.get(libraryPath)!;
  };
  /** The one PDF without this kind of side-car whose bytes are `identity`; null when none or several. */
  async function match(kind: PdfSidecarKind, identity: PdfIdentity) {
    const taken = withSidecar.get(kind)!;
    const candidates = pdfFiles.filter((file) => file.size === identity.size && !taken.has(file.path.toLowerCase()));
    const matches: string[] = [];
    for (const candidate of candidates) if ((await identityOf(candidate.path))?.contentHash === identity.contentHash) matches.push(candidate.path);
    return matches.length === 1 ? matches[0] : null;
  }

  let reattached = 0;
  let setAsideCount = 0;
  for (const found of missing) {
    const identity = sidecarIdentity(await readJson(found.sidecarPath));
    const target = identity ? await match(found.store.kind, identity) : null;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      const destination = found.store.path(owner, pathParts);
      if (!(await pathExists(destination))) {
        await moveFileIfExists(found.sidecarPath, destination);
        withSidecar.get(found.store.kind)!.add(target.toLowerCase());
        missingSince.delete(found.sidecarPath);
        reattached += 1;
        continue;
      }
    }
    const first = missingSince.get(found.sidecarPath) ?? now;
    missingSince.set(found.sidecarPath, first);
    if (now - first >= ORPHAN_GRACE_MS) {
      await setAside(notebook, found.store, found.sidecarPath, found.libraryPath);
      missingSince.delete(found.sidecarPath);
      setAsideCount += 1;
    }
  }

  for (const { file, record } of stored) {
    const store = KINDS.find((candidate) => candidate.kind === record.kind)!;
    let target: string | null = null;
    if (record.source) target = await match(record.kind, record.source);
    // Without a recorded identity, only the PDF coming back under its old path is its own.
    else if (await pdfExists(record.originalPath) && !withSidecar.get(record.kind)!.has(record.originalPath.toLowerCase())) target = record.originalPath;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      const destination = store.path(owner, pathParts);
      if (!(await pathExists(destination))) {
        await writeJsonAtomically(destination, record.sidecar);
        await rm(file, { force: true });
        withSidecar.get(record.kind)!.add(target.toLowerCase());
        reattached += 1;
        continue;
      }
    }
    if (now - Date.parse(record.orphanedAt) > ORPHAN_RETENTION_MS) await rm(file, { force: true });
  }
  return { reattached, setAside: setAsideCount };
}

function notebookPrefix(notebook: string) {
  try { return notebookSystemDirectoryPath(notebook); } catch { return "\0"; }
}

/** Library paths and sizes of the PDFs in a tree's nodes. */
export function pdfFilesOf(nodes: Array<{ kind: string; path: string; size?: number; fileType?: string; children?: unknown[] }>, into: Array<{ path: string; size: number }> = []) {
  for (const node of nodes) {
    if (node.kind === "file" && node.fileType === "pdf" && typeof node.size === "number") into.push({ path: node.path, size: node.size });
    else if (Array.isArray(node.children)) pdfFilesOf(node.children as typeof nodes, into);
  }
  return into;
}

/**
 * The PDF in `notebook` whose bytes are `identity`, other than `except`: where
 * a PDF went when it was renamed or moved while something was working on it.
 */
export async function findPdfByIdentity(notebook: string, identity: PdfIdentity, except?: string): Promise<string | null> {
  const root = notebookPath(notebook);
  const matches: string[] = [];
  async function visit(directory: string, parts: string[]) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, [...parts, entry.name]);
      else if (entry.isFile() && getFileType(entry.name) === "pdf") {
        const libraryPath = relativeFilePath(notebook, [...parts, entry.name]);
        if (libraryPath === except) continue;
        const stats = await stat(target).catch(() => null);
        if (stats?.size !== identity.size) continue;
        if ((await cachedPdfIdentity(target).catch(() => null))?.contentHash === identity.contentHash) matches.push(libraryPath);
      }
    }
  }
  await visit(root, []);
  return matches.length === 1 ? matches[0] : null;
}
