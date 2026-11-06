// A shared notebook's live PDFs (docs/collaboration/pdf-realtime-plan.md §5, §6).
//
// A PDF's marks live in a document of their own. This runtime opens those
// documents, merges local sidecars into them once, and keeps the sidecar as
// a read-only copy for the things that read it: search, deep search and
// export. Nothing is ever rebuilt from that copy, so an old one delivered by
// a sync client cannot change shared state.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type * as Y from "yjs";

import { importBatches, createMarks, readAllMarks, visibleMarks, markGroups } from "../../../src/lib/collab/pdf/model";
import { ManifestKeys, type ManifestEntry } from "../../../src/lib/collab/protocol/schema";
import { isPdfPath, PDF_LIVE_SETTING, pdfDocIdFromDigest, pdfDocIdSeed, PdfKeys, PdfMarkFields, pdfMarkFieldViolation, PDF_MARK_TYPES } from "../../../src/lib/collab/protocol/pdf";
import { roleAtLeast, type Role } from "../../../src/lib/collab/protocol/roles";
import type { PdfAnnotation } from "../../../src/lib/types";
import type { Logger } from "../core/clock";
import type { DocHub } from "../core/doc-hub";
import type { CollabHost } from "../core/host";
import { readIfExists, sha256, writeFileAtomic, type WriteGuard } from "./fs-ops";

const SIDECAR_DIRECTORY = [".libera", "annotations", "pdf", "by-path"] as const;
const IMPORT = { source: "import" } as const;

/** The document of a shared PDF; every client derives the same one. */
export function pdfDocId(projectId: string, fileId: string): string {
  return pdfDocIdFromDigest(createHash("sha256").update(pdfDocIdSeed(projectId, fileId)).digest("base64url"));
}

export interface PdfRuntimeContext {
  host: CollabHost;
  logger: Logger;
  projectId: string;
  notebook: string;
  root: string;
  /** Delay before the sidecar copy is rewritten; each write is an upload on a synced folder. */
  writeMs: number;
  role(): Role;
  /** This installation writes the folder (it is not a follower). */
  canWriteDisk(): boolean;
  guard(): WriteGuard;
  accountId(): Promise<string>;
  filesChanged(paths: string[]): void;
  /** Reads the notebook's manifest document. */
  manifest(): Y.Doc | null;
  /** Comment threads of a sidecar, to become server threads. */
  importComments?(docId: string, comments: unknown[]): void;
  /** The server's comment threads, for the sidecar copy. */
  listComments?(docId: string): Promise<unknown[] | null>;
}

interface Sidecar {
  annotations?: unknown;
  comments?: unknown;
  source?: unknown;
  /** Written by this runtime: a copy of the shared state, not local work. */
  sharedCopy?: boolean;
}

interface PdfDoc {
  fileId: string;
  docId: string;
  path: string;
  blobHash?: string;
  hub: DocHub;
  unsubscribe: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** The local sidecar has been merged, or there was nothing to merge. */
  imported: boolean;
  importing: boolean;
  /** Hash of the copy last written, so an unchanged one is not uploaded again. */
  writtenHash: string | null;
}

function validAnnotation(value: unknown): value is PdfAnnotation {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as PdfAnnotation;
  if (typeof annotation.id !== "string" || !annotation.id || !(PDF_MARK_TYPES as readonly string[]).includes(annotation.type)) return false;
  if (typeof annotation.createdAt !== "string") return false;
  const groups = markGroups(annotation);
  return !pdfMarkFieldViolation(annotation.type, PdfMarkFields.geometry, groups.geometry)
    && !pdfMarkFieldViolation(annotation.type, PdfMarkFields.style, groups.style)
    && !pdfMarkFieldViolation(annotation.type, PdfMarkFields.createdAt, annotation.createdAt);
}

export class PdfMarksRuntime {
  private readonly docs = new Map<string, PdfDoc>();
  private entries = new Map<string, { path: string; blobHash?: string }>();
  private discovered = false;
  private stopped = false;

  constructor(private readonly ctx: PdfRuntimeContext) {}

  /** Live PDFs are on for this notebook. */
  get enabled(): boolean {
    return this.ctx.manifest()?.getMap<unknown>(ManifestKeys.settings).get(PDF_LIVE_SETTING) === true;
  }

  private sidecarPath(relative: string): string {
    return `${path.join(this.ctx.root, ...SIDECAR_DIRECTORY, ...relative.split("/"))}.json`;
  }

  private canAnnotate(): boolean {
    return roleAtLeast(this.ctx.role(), "commenter");
  }

  /** The manifest changed: follow renames and deletions, and start up once live PDFs are on. */
  sync(entries: Iterable<ManifestEntry>, paths: ReadonlyMap<string, string>): void {
    if (this.stopped) return;
    const next = new Map<string, { path: string; blobHash?: string }>();
    for (const entry of entries) {
      const relative = paths.get(entry.fileId);
      if (entry.kind === "blob" && relative && isPdfPath(relative)) next.set(entry.fileId, { path: relative, ...(entry.blobHash ? { blobHash: entry.blobHash } : {}) });
    }
    this.entries = next;
    if (!this.enabled) return;
    for (const doc of [...this.docs.values()]) {
      const entry = next.get(doc.fileId);
      if (!entry) {
        void this.close(doc, true);
        continue;
      }
      doc.blobHash = entry.blobHash;
      if (entry.path === doc.path) continue;
      doc.path = entry.path;
      this.ctx.host.store.upsertDoc({ docId: doc.docId, projectId: this.ctx.projectId, fileId: doc.fileId, path: doc.path, materializedHash: null });
    }
    if (!this.discovered) {
      this.discovered = true;
      void this.discover();
    }
  }

  /** Opens the PDFs with work to merge and those others have marked. */
  private async discover(): Promise<void> {
    await this.refreshServerDocuments();
    if (!this.ctx.canWriteDisk() || !this.canAnnotate()) return;
    for (const [fileId, entry] of this.entries) {
      if (this.stopped) return;
      if (this.docs.has(fileId)) continue;
      if (await readIfExists(this.sidecarPath(entry.path)).catch(() => null)) this.open(fileId);
    }
  }

  /** PDFs someone has opened have a document; only those are worth a hub. */
  async refreshServerDocuments(): Promise<void> {
    const api = this.ctx.host.api;
    if (!api || !this.enabled) return;
    try {
      for (const document of await api.listDocuments(this.ctx.projectId)) {
        if (document.kind === "pdf" && document.fileId && this.entries.has(document.fileId)) this.open(document.fileId);
      }
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.ctx.notebook}: could not list its PDFs`, error);
    }
  }

  /** The PDF at a path, ready to attach to; null when it is not a shared PDF here. */
  resolve(relative: string): { docId: string; fileId: string; path: string; blobHash?: string } | null {
    if (!this.enabled || this.stopped) return null;
    for (const [fileId, entry] of this.entries) {
      if (entry.path !== relative) continue;
      const doc = this.open(fileId);
      return { docId: doc.docId, fileId, path: entry.path, ...(entry.blobHash ? { blobHash: entry.blobHash } : {}) };
    }
    return null;
  }

  private open(fileId: string): PdfDoc {
    const existing = this.docs.get(fileId);
    if (existing) return existing;
    const entry = this.entries.get(fileId);
    if (!entry) throw new Error(`No PDF ${fileId} in this notebook.`);
    const { host, projectId } = this.ctx;
    const docId = pdfDocId(projectId, fileId);
    // Written first: the hub reads it to tell the server what to make.
    host.store.upsertDoc({ docId, projectId, fileId, path: entry.path, materializedHash: null });
    const hub = host.acquire(docId, { kind: "file", projectId });
    const doc: PdfDoc = { fileId, docId, path: entry.path, blobHash: entry.blobHash, hub, unsubscribe: [], timer: null, imported: false, importing: false, writtenHash: null };
    this.docs.set(fileId, doc);
    doc.unsubscribe.push(
      hub.observe("annotations", (change) => {
        if (change.origin !== "rebuilt") this.scheduleWrite(doc);
      }),
      hub.onStatus(() => void this.importSidecar(doc)),
      hub.onRejected((edit) => {
        if (edit.subdoc === "annotations") void this.keepRejected(doc, edit.rejectedText);
      }),
    );
    void this.importSidecar(doc);
    return doc;
  }

  private hasServerState(doc: PdfDoc): boolean {
    const { state } = doc.hub.getStatus();
    return state === "saved-remote" || state === "syncing";
  }

  private async readSidecar(doc: PdfDoc): Promise<Sidecar | null> {
    const bytes = await readIfExists(this.sidecarPath(doc.path)).catch(() => null);
    if (!bytes) return null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Sidecar;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Merges the local sidecar, once it is safe: only after the server's state
   * has arrived, so a mark deleted elsewhere is known to exist and is not
   * created again. Followers leave the folder's sidecars to its writer.
   */
  private async importSidecar(doc: PdfDoc): Promise<void> {
    if (doc.imported || doc.importing || this.stopped || doc.hub.isClosed) return;
    if (!this.ctx.canWriteDisk() || !this.canAnnotate() || !this.hasServerState(doc)) return;
    doc.importing = true;
    try {
      const sidecar = await this.readSidecar(doc);
      const annotations = Array.isArray(sidecar?.annotations) ? sidecar.annotations.filter(validAnnotation) : [];
      const comments = Array.isArray(sidecar?.comments) ? sidecar.comments : [];
      if (sidecar && !sidecar.sharedCopy && (annotations.length || comments.length)) {
        const hash = sha256(Buffer.from(JSON.stringify([sidecar.annotations ?? [], comments])));
        const done = doc.hub.getDoc("annotations").getMap<unknown>(PdfKeys.imports).has(hash);
        if (!done) {
          const accountId = await this.ctx.accountId();
          const context = { accountId, ...(doc.blobHash ? { sourceHash: doc.blobHash } : {}) };
          for (const batch of importBatches(doc.hub.getDoc("annotations"), annotations)) {
            doc.hub.applyLocalChange("annotations", (ydoc) => createMarks(ydoc, batch, context), IMPORT);
          }
          if (comments.length) this.ctx.importComments?.(doc.docId, comments);
          doc.hub.applyLocalChange("annotations", (ydoc) => ydoc.getMap<unknown>(PdfKeys.imports).set(hash, { by: accountId, at: new Date().toISOString() }), IMPORT);
        }
      }
      doc.imported = true;
      this.scheduleWrite(doc);
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.ctx.notebook}: could not merge the annotations of ${doc.path}`, error);
    } finally {
      doc.importing = false;
    }
  }

  private scheduleWrite(doc: PdfDoc): void {
    if (this.stopped || doc.timer || !this.ctx.canWriteDisk()) return;
    doc.timer = setTimeout(() => {
      doc.timer = null;
      void this.writeCopy(doc).catch((error) => this.ctx.logger.warn(`Shared notebook ${this.ctx.notebook}: could not write the annotations of ${doc.path}`, error));
    }, this.ctx.writeMs);
    doc.timer.unref?.();
  }

  /**
   * Writes the sidecar copy. Local work not merged yet is never overwritten,
   * which also keeps a viewer's private notes, since a viewer cannot merge.
   */
  private async writeCopy(doc: PdfDoc, options: { local?: boolean } = {}): Promise<void> {
    if (!this.ctx.canWriteDisk() || doc.hub.isClosed) return;
    const existing = await this.readSidecar(doc);
    if (!doc.imported && existing && !existing.sharedCopy) return;
    const annotations = visibleMarks(readAllMarks(doc.hub.getDoc("annotations")));
    const threads = await this.ctx.listComments?.(doc.docId).catch(() => null);
    const comments = threads ?? (Array.isArray(existing?.comments) ? existing.comments : []);
    if (!annotations.length && !comments.length && !existing) return;
    const copy: Sidecar = { annotations, ...(comments.length ? { comments } : {}), ...(existing?.source ? { source: existing.source } : {}), ...(options.local ? {} : { sharedCopy: true }) };
    const bytes = Buffer.from(`${JSON.stringify(copy, null, 2)}\n`, "utf8");
    const hash = sha256(bytes);
    if (hash === doc.writtenHash) return;
    const target = this.sidecarPath(doc.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, bytes, this.ctx.guard());
    doc.writtenHash = hash;
    this.ctx.filesChanged([doc.path]);
  }

  /** Work the server refused stays in the notebook's state folder, for recovery. */
  private async keepRejected(doc: PdfDoc, text: string): Promise<void> {
    if (!this.ctx.canWriteDisk()) return;
    const target = path.join(this.ctx.root, ".libera", "collab", "rejected-pdf", `${doc.fileId}-${Date.now()}.json`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, Buffer.from(text, "utf8"), this.ctx.guard()).catch((error) => this.ctx.logger.warn(`Shared notebook ${this.ctx.notebook}: could not keep refused annotations`, error));
  }

  private async close(doc: PdfDoc, finalWrite: boolean, options: { local?: boolean } = {}): Promise<void> {
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = null;
    this.docs.delete(doc.fileId);
    if (finalWrite) await this.writeCopy(doc, options).catch(() => undefined);
    for (const unsubscribe of doc.unsubscribe) unsubscribe();
    doc.unsubscribe.length = 0;
    this.ctx.host.release(doc.docId);
  }

  /**
   * Stops the runtime. `local` is for access ending or the notebook leaving
   * collaboration: the last state becomes an ordinary sidecar the person keeps.
   */
  async stop(options: { local?: boolean } = {}): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.docs.values()].map((doc) => this.close(doc, true, options)));
  }

  /** How many PDF documents are open (tests, diagnostics). */
  get openCount(): number {
    return this.docs.size;
  }
}
