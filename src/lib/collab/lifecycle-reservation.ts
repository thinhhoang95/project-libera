// A cross-process reservation of one notebook folder's lifecycle transition.
//
// Sharing a notebook (host process) and the local operations that rewrite its
// files (Next's migration, Try to fix, Acknowledge) must not overlap: a local
// operation that started before the share marker was installed would carry on
// into publication, unlinking or finalization after the notebook became shared.
// The process-local fence (storage/migration-fence.ts) cannot see another
// process, so both sides record a holder here, in the same userData folder as
// the other lifecycle records (LIBERA_COLLAB_LIFECYCLE_DIR).
//
// One file per holder. A holder is live while its process is alive AND it
// renewed its lease recently, so a crashed or frozen holder never blocks anyone
// for longer than the lease. Nothing waits: a conflicting live holder refuses
// the newcomer at once. Two shares, or two local operations, do not conflict
// with each other (each has its own process-local guard); a share conflicts
// with every local operation. When both start at once, the older record wins
// and the newer backs out, so exactly one side proceeds.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ReservationKind = "share" | "local";

/** How long a holder's record counts without being renewed. Holders renew well inside it. */
export const RESERVATION_LEASE_MS = 60_000;
const RENEW_EVERY_MS = 15_000;

interface Held {
  version: 1;
  root: string;
  kind: ReservationKind;
  pid: number;
  token: string;
  createdAt: number;
  renewedAt: number;
}

export class ReservationConflictError extends Error {
  constructor(readonly holder: ReservationKind) {
    super(holder === "share"
      ? "This notebook is being shared. Try again when sharing has finished."
      : "A migration or repair is working on this notebook. Try again when it has finished.");
    this.name = "ReservationConflictError";
  }
}

export class ReservationLostError extends Error {
  constructor() {
    super("This notebook's sharing state changed while the operation was running. Nothing more was changed; try again.");
    this.name = "ReservationLostError";
  }
}

const key = (root: string) => {
  const resolved = path.resolve(root);
  return createHash("sha256").update(process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 32);
};
const folder = (directory: string) => path.join(directory, "reservations");
const fileOf = (directory: string, root: string, token: string) => path.join(folder(directory), `${key(root)}-${token}.json`);

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const isLive = (record: Held, now: number) => now - record.renewedAt < RESERVATION_LEASE_MS && alive(record.pid);

function parse(file: string): Held | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Held;
    if (value?.version !== 1 || typeof value.token !== "string" || typeof value.pid !== "number" ||
        typeof value.createdAt !== "number" || typeof value.renewedAt !== "number" ||
        (value.kind !== "share" && value.kind !== "local")) return null;
    return value;
  } catch { return null; }
}

/** Every live record for this root; dead ones are deleted on the way. */
function liveHolders(directory: string, root: string): Held[] {
  const prefix = `${key(root)}-`;
  let names: string[];
  try { names = readdirSync(folder(directory)); } catch { return []; }
  const now = Date.now();
  const live: Held[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const file = path.join(folder(directory), name);
    const record = parse(file);
    if (record && isLive(record, now)) live.push(record);
    else { try { unlinkSync(file); } catch { /* Someone else removed it. */ } }
  }
  return live;
}

const conflicts = (mine: ReservationKind, other: ReservationKind) => mine === "share" || other === "share";
const olderThan = (a: Held, b: Held) => a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.token < b.token);

function write(file: string, record: Held) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Not written. */ }
    throw error;
  }
}

export interface Reservation {
  readonly kind: ReservationKind;
  /**
   * Throws ReservationLostError when the lease lapsed (someone may have taken
   * over) or an older conflicting holder exists. Renews the lease otherwise.
   */
  revalidate(): void;
  release(): void;
}

/**
 * Reserves `roots` for a lifecycle transition (a share) or a local record
 * operation. Throws ReservationConflictError when a live conflicting holder exists.
 * Returns a no-op reservation when there is no lifecycle directory (no host).
 */
export function reserveLifecycle(directory: string | undefined, roots: string[], kind: ReservationKind): Reservation {
  if (!directory) return { kind, revalidate() { /* Nothing to coordinate with. */ }, release() { /* Nothing held. */ } };
  const unique = [...new Set(roots.map((root) => path.resolve(root)))];
  const held: Array<{ root: string; file: string; record: Held }> = [];
  const releaseAll = () => { for (const item of held.splice(0)) { try { unlinkSync(item.file); } catch { /* Already gone. */ } } };
  const now = Date.now();
  try {
    for (const root of unique) {
      const token = randomBytes(8).toString("hex");
      const record: Held = { version: 1, root, kind, pid: process.pid, token, createdAt: now, renewedAt: now };
      const file = fileOf(directory, root, token);
      // A conflicting live holder already there refuses us before we write anything.
      const other = liveHolders(directory, root).find((candidate) => conflicts(kind, candidate.kind));
      if (other) throw new ReservationConflictError(other.kind);
      write(file, record);
      held.push({ root, file, record });
      // Both sides may have written at once: the older record stands, the newer backs out.
      const rival = liveHolders(directory, root).find((candidate) => candidate.token !== token && conflicts(kind, candidate.kind) && olderThan(candidate, record));
      if (rival) throw new ReservationConflictError(rival.kind);
    }
  } catch (error) {
    releaseAll();
    throw error;
  }
  const timer = setInterval(() => {
    for (const item of held) {
      if (!parse(item.file)) continue;
      item.record.renewedAt = Date.now();
      try { write(item.file, item.record); } catch { /* The next revalidation notices a lost record. */ }
    }
  }, RENEW_EVERY_MS);
  timer.unref?.();
  return {
    kind,
    revalidate() {
      for (const item of held) {
        const saved = parse(item.file);
        if (!saved || saved.token !== item.record.token) throw new ReservationLostError();
        if (Date.now() - saved.renewedAt >= RESERVATION_LEASE_MS) throw new ReservationLostError();
        const rival = liveHolders(directory, item.root).find((candidate) => candidate.token !== item.record.token && conflicts(kind, candidate.kind) && olderThan(candidate, item.record));
        if (rival) throw new ReservationLostError();
        item.record.renewedAt = Date.now();
        write(item.file, item.record);
      }
    },
    release() {
      clearInterval(timer);
      releaseAll();
    },
  };
}

/** True while a live holder of `kind` reserves `root`. Only looks; writes nothing. */
export function isReservedBy(directory: string | undefined, root: string, kind: ReservationKind): boolean {
  return !!directory && liveHolders(directory, root).some((record) => record.kind === kind);
}
