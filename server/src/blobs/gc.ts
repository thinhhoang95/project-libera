// Reclaims blob objects no project references (review finding R46).
//
// The store is content-addressed and shared by projects; the `blobs` table
// records which project may read which hash. When a project is taken down,
// its rows go with it, and a hash no other project holds is recorded in
// blob_orphans. After a grace period (a restore from backup can still bring
// its rows back) the blob-gc job deletes the object, unless a project has
// referenced the hash again. Versions a live project replaced or never
// published keep their rows, and so their bytes (an album keeps originals).

import type { Kysely } from "kysely";

import type { ServerContext } from "../context.js";
import type { DB } from "../db/types.js";
import { getBlobStore } from "./index.js";

/** How long an orphaned object is kept before blob-gc deletes it. */
export const BLOB_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000;

/** Inside the transaction that removed `hashes`' rows: records the ones no project references now. */
export async function recordOrphanedBlobs(trx: Kysely<DB>, hashes: readonly string[]): Promise<void> {
  const unique = [...new Set(hashes)];
  for (let start = 0; start < unique.length; start += 500) {
    const batch = unique.slice(start, start + 500);
    const referenced = new Set((await trx.selectFrom("blobs").select("hash").where("hash", "in", batch).execute()).map((row) => row.hash));
    const orphaned = batch.filter((hash) => !referenced.has(hash));
    if (orphaned.length) await trx.insertInto("blob_orphans").values(orphaned.map((hash) => ({ hash }))).onConflict((conflict) => conflict.column("hash").doNothing()).execute();
  }
}

/** Deletes orphaned objects older than `olderThanMs` that no project references again. Returns how many went. */
export async function collectOrphanedBlobs(context: ServerContext, { olderThanMs = BLOB_ORPHAN_GRACE_MS, limit = 1_000 } = {}): Promise<number> {
  const { db } = context;
  const store = getBlobStore(context);
  const cutoff = new Date(Date.now() - olderThanMs);
  const due = await db.selectFrom("blob_orphans").select("hash").where("orphaned_at", "<", cutoff).orderBy("orphaned_at").limit(limit).execute();
  let removed = 0;
  for (const { hash } of due) {
    const referenced = await db.selectFrom("blobs").select("hash").where("hash", "=", hash).executeTakeFirst();
    if (!referenced && store.delete) {
      await store.delete(hash);
      removed += 1;
    }
    // Referenced again, or deleted: either way nothing is left to collect.
    if (referenced || store.delete) await db.deleteFrom("blob_orphans").where("hash", "=", hash).execute();
  }
  return removed;
}
