// A shared notebook's live PDFs (docs/collaboration/pdf-realtime-plan.md §5, §6).
//
// A PDF's marks live in a document of their own. This runtime opens those
// documents, imports unseen sidecar records, and keeps the sidecar as
// a read-only copy for the things that read it: search, deep search and
// export. Nothing is ever rebuilt from that copy, so an old one delivered by
// a sync client cannot change shared state.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type * as Y from "yjs";

import { importBatches, readAllMarks, visibleMarks, annotationViolation } from "../../../src/lib/collab/pdf/model";
import { ManifestKeys, type ManifestEntry } from "../../../src/lib/collab/protocol/schema";
import { isPdfPath, PDF_LIVE_SETTING, pdfDocIdFromDigest, pdfDocIdSeed, PDF_MARK_TYPES, type PdfImportRequest } from "../../../src/lib/collab/protocol/pdf";
import { roleAtLeast, type Role } from "../../../src/lib/collab/protocol/roles";
import type { PdfAnnotation } from "../../../src/lib/types";
import type { Logger } from "../core/clock";
import type { DocHub } from "../core/doc-hub";
import type { CollabHost } from "../core/host";
import { ensureDirectory, readIfExists, sha256, writeFileAtomic, type WriteGuard } from "./fs-ops";

const SIDECAR_DIRECTORY = [".libera", "annotations", "pdf", "by-path"] as const;

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
  guard(finalizing?: boolean): WriteGuard;
  authorityReady(): boolean;
  filesChanged(paths: string[]): void;
  /** Reads the notebook's manifest document. */
  manifest(): Y.Doc | null;
  /** The server's comment threads, for the sidecar copy. */
  listComments?(docId: string): Promise<unknown[] | null>;
}

interface Sidecar {
  annotations?: unknown;
  comments?: unknown;
  source?: unknown;
  /**
   * Written by this runtime: the document this is a copy of. A copy of another
   * PDF's document (the file was copied or moved here) is local work again.
   */
  sharedCopy?: string;
}

interface PdfDoc {
  fileId: string;
  docId: string;
  path: string;
  hub: DocHub;
  unsubscribe: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** The local sidecar has been merged, or there was nothing to merge. */
  imported: boolean;
  importing: boolean;
  observedHash: string | null;
  writes: Promise<void>;
}

function validAnnotation(value: unknown): value is PdfAnnotation {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as PdfAnnotation;
  if (typeof annotation.id !== "string" || !annotation.id || !(PDF_MARK_TYPES as readonly string[]).includes(annotation.type)) return false;
  if (typeof annotation.createdAt !== "string") return false;
  return !annotationViolation(annotation, { accountId: "import" });
}

export class PdfMarksRuntime {
  private readonly docs = new Map<string, PdfDoc>();
  private entries = new Map<string, { path: string; blobHash?: string }>();
  private discovered = false;
  private stopped = false;

  private sidecarTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: PdfRuntimeContext) {}

  /** Live PDFs are on for this notebook. */
  get enabled(): boolean {
    return this.ctx.manifest()?.getMap<unknown>(ManifestKeys.settings).get(PDF_LIVE_SETTING) === true;
  }

  get ready(): boolean { return this.ctx.authorityReady(); }

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
    const added = [...next.keys()].filter((fileId) => !this.entries.has(fileId));
    this.entries = next;
    if (!this.enabled) return;
    // A PDF copied or moved in brings its sidecar along, moments after the file.
    if (this.discovered && added.length) void this.openWithSidecars(added);
    for (const doc of [...this.docs.values()]) {
      const entry = next.get(doc.fileId);
      if (!entry) {
        void this.close(doc, true);
        continue;
      }
      void this.importSidecar(doc);
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
    await this.openWithSidecars([...this.entries.keys()]);
  }

  private async openWithSidecars(fileIds: string[], retries = 2): Promise<void> {
    if (!this.ctx.canWriteDisk() || !this.canAnnotate()) return;
    const waiting: string[] = [];
    for (const fileId of fileIds) {
      if (this.stopped) return;
      const entry = this.entries.get(fileId);
      if (!entry || this.docs.has(fileId)) continue;
      if (await readIfExists(this.sidecarPath(entry.path)).catch(() => null)) this.open(fileId);
      else waiting.push(fileId);
    }
    if (!waiting.length || retries === 0) return;
    const timer = setTimeout(() => void this.openWithSidecars(waiting, retries - 1), this.ctx.writeMs);
    timer.unref?.();
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
    const doc: PdfDoc = { fileId, docId, path: entry.path, hub, unsubscribe: [], timer: null, imported: false, importing: false, observedHash: null, writes: Promise.resolve() };
    this.docs.set(fileId, doc);
    if (!this.sidecarTimer) {
      this.sidecarTimer = setInterval(() => {
        for (const opened of this.docs.values()) void this.importSidecar(opened);
      }, this.ctx.writeMs);
      this.sidecarTimer.unref?.();
    }
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

  /**
   * Merges the local sidecar, once it is safe: only after the server's state
   * has arrived, so a mark deleted elsewhere is known to exist and is not
   * created again. Followers leave the folder's sidecars to its writer.
   */
  private async importSidecar(doc: PdfDoc): Promise<void> {
    if (doc.importing || this.stopped || doc.hub.isClosed) return;
    if (!this.ctx.canWriteDisk() || !this.hasServerState(doc)) return;
    doc.importing = true;
    try {
      const bytes = await readIfExists(this.sidecarPath(doc.path));
      const observed = bytes ? sha256(bytes) : null;
      if (doc.imported && doc.observedHash === observed) return;
      const sidecar = bytes ? JSON.parse(bytes.toString("utf8")) as Sidecar : null;
      const annotations = Array.isArray(sidecar?.annotations) ? sidecar.annotations.filter(validAnnotation) : [];
      let comments = Array.isArray(sidecar?.comments) ? sidecar.comments : [];
      if (sidecar?.sharedCopy === doc.docId) {
        const known = await this.ctx.listComments?.(doc.docId);
        if (!known) return;
        const ids = new Set(known.map((thread) => (thread as { id: string }).id));
        comments = comments.filter((thread) => !ids.has((thread as { id?: string })?.id ?? ""));
      }
      if (annotations.length || comments.length) {
        const api = this.ctx.host.api;
        if (!api) return;
        const source = sidecar?.source as { contentHash?: unknown } | undefined;
        const sourceHash = typeof source?.contentHash === "string" && /^[0-9a-f]{64}$/.test(source.contentHash) ? source.contentHash : undefined;
        const batches = importBatches(doc.hub.getDoc("annotations"), annotations);
        if (!this.canAnnotate() && (batches.length || comments.length)) return;
        // Comments go through the same serialized operation as their anchors.
        if (!batches.length && comments.length) batches.push([]);
        for (let index = 0; index < batches.length; index += 1) {
          await api.importPdf(doc.docId, { marks: batches[index], ...(index === 0 ? { comments } : {}), sourceHash });
        }
        if (batches.length) {
          const hash = sha256(Buffer.from(JSON.stringify([annotations, comments])));
          await api.importPdf(doc.docId, { marks: [], hash });
        }
      }
      if (Array.isArray(sidecar?.annotations) && annotations.length !== sidecar.annotations.length) {
        if (!await this.keepRejected(doc, JSON.stringify(sidecar))) return;
      }
      doc.observedHash = observed;
      doc.imported = true;
      this.scheduleWrite(doc);
    } catch (error) {
      doc.imported = false;
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
  private writeCopy(doc: PdfDoc, options: { local?: boolean } = {}): Promise<void> {
    const write = doc.writes.catch(() => undefined).then(() => this.writeCurrentCopy(doc, options));
    doc.writes = write;
    return write;
  }

  private async writeCurrentCopy(doc: PdfDoc, options: { local?: boolean }): Promise<void> {
    if ((!options.local && (this.stopped || !this.ctx.canWriteDisk())) || doc.hub.isClosed) return;
    const relative = doc.path;
    const target = this.sidecarPath(relative);
    if (!options.local) await this.importSidecar(doc);
    const observed = await readIfExists(target);
    const expected = observed ? sha256(observed) : null;
    const existing = observed ? JSON.parse(observed.toString("utf8")) as Sidecar : null;
    if (!options.local && (!doc.imported || doc.importing || expected !== doc.observedHash)) return;
    const annotations = visibleMarks(readAllMarks(doc.hub.getDoc("annotations")));
    // Terminal export is independent of the writer lease. Keep private local
    // ids too, since access may end before they could be imported.
    if (options.local && Array.isArray(existing?.annotations)) {
      const ids = new Set(readAllMarks(doc.hub.getDoc("annotations")).map((record) => record.annotation.id));
      annotations.push(...existing.annotations.filter(validAnnotation).filter((mark) => !ids.has(mark.id)));
    }
    const threads = await this.ctx.listComments?.(doc.docId).catch(() => null);
    const comments = threads ?? (Array.isArray(existing?.comments) ? existing.comments : []);
    if (!annotations.length && !comments.length && !existing) return;
    const copy: Sidecar = { annotations, ...(comments.length ? { comments } : {}), ...(existing?.source ? { source: existing.source } : {}), ...(options.local ? {} : { sharedCopy: doc.docId }) };
    const bytes = Buffer.from(`${JSON.stringify(copy, null, 2)}\n`, "utf8");
    const hash = sha256(bytes);
    if (hash === expected) return;
    const base = this.ctx.guard(options.local === true);
    const guard: WriteGuard = { root: base.root, canCommit: async () => {
      if (doc.path !== relative || !(await base.canCommit())) return false;
      if (!options.local && (this.stopped || !this.ctx.canWriteDisk() || this.docs.get(doc.fileId) !== doc)) return false;
      if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) return false;
      const current = await readIfExists(target);
      return (current ? sha256(current) : null) === expected;
    } };
    await ensureDirectory(path.dirname(target), guard);
    await writeFileAtomic(target, bytes, guard);
    doc.observedHash = hash;
    this.ctx.filesChanged([doc.path]);
  }

  /** Work the server refused stays in the notebook's state folder, for recovery. */
  private async keepRejected(doc: PdfDoc, text: string): Promise<boolean> {
    if (!this.ctx.canWriteDisk()) return false;
    const target = path.join(this.ctx.root, ".libera", "collab", "rejected-pdf", `${doc.fileId}-${Date.now()}.json`);
    try {
      await ensureDirectory(path.dirname(target), this.ctx.guard());
      await writeFileAtomic(target, Buffer.from(text, "utf8"), this.ctx.guard());
      return true;
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.ctx.notebook}: could not keep refused annotations`, error);
      return false;
    }
  }

  private async close(doc: PdfDoc, finalWrite: boolean, options: { local?: boolean } = {}): Promise<void> {
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = null;
    if (finalWrite) await this.writeCopy(doc, options).catch(() => undefined);
    this.docs.delete(doc.fileId);
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
    if (this.sidecarTimer) clearInterval(this.sidecarTimer);
    this.sidecarTimer = null;
    await Promise.all([...this.docs.values()].map((doc) => this.close(doc, true, options)));
  }

  async seed(fileId: string, relative: string, input: PdfImportRequest): Promise<void> {
    const { host, projectId } = this.ctx;
    const docId = pdfDocId(projectId, fileId);
    host.store.upsertDoc({ docId, projectId, fileId, path: relative, materializedHash: null });
    const hub = host.acquire(docId, { kind: "file", projectId });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Waiting for the PDF document to open.")), 15_000);
        let unsubscribe = () => {};
        const finish = (error?: Error) => { clearTimeout(timer); unsubscribe(); if (error) reject(error); else resolve(); };
        const check = () => { if (hub.hasOpened) finish(); else if (hub.readOnlyReason) finish(new Error("This PDF is no longer accessible.")); };
        unsubscribe = hub.onStatus(check);
        check();
      });
      const api = host.api;
      if (!api) throw new Error("Not signed in.");
      // Large copies use the same bounded batches as sidecar imports.
      const marks = input.marks as PdfAnnotation[];
      const batches = importBatches(hub.getDoc("annotations"), marks);
      if (!batches.length) batches.push([]);
      for (let index = 0; index < batches.length; index += 1) await api.importPdf(docId, { ...input, marks: batches[index], comments: index === 0 ? input.comments : [] });
    } finally { host.release(docId); }
  }

  /** How many PDF documents are open (tests, diagnostics). */
  get openCount(): number {
    return this.docs.size;
  }
}
