import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { readNotebookBinding } from "../../../src/lib/collab/local-notebook-state";
import { normalizedServerUrl, sameAuthority, type AccountAuthority } from "../core/authority";
import type { Logger } from "../core/clock";
import { HostStore } from "../core/store";
import { readMarker } from "../notebooks/state";

/** With no URL this returns the pre-authority filename, for migration only. */
export function databaseKey(accountId: string | null, serverUrl?: string): string {
  if (!accountId) return "default";
  if (serverUrl) return `acct_${createHash("sha256").update(JSON.stringify([normalizedServerUrl(serverUrl), accountId])).digest("hex")}`;
  if (/^[A-Za-z0-9_-]{1,80}$/.test(accountId) && accountId !== "default") return accountId;
  return `acct_${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}`;
}

/**
 * Adopt an old account-only file only with local evidence of its authority.
 * Keep it in place (including its WAL and pending edits), and durably pin its
 * owner before connecting. Another server always gets its own database.
 */
export async function databasePath(directory: string, authority: AccountAuthority | null, remembered: AccountAuthority | null, logger: Logger): Promise<string> {
  if (!authority) return path.join(directory, "default.sqlite");
  const scoped = path.join(directory, `${databaseKey(authority.accountId, authority.serverUrl)}.sqlite`);
  try { await fs.stat(scoped); return scoped; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const legacy = path.join(directory, `${databaseKey(authority.accountId)}.sqlite`);
  try { await fs.stat(legacy); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return scoped; throw error; }
  const store = new HostStore({ path: legacy });
  try {
    const saved = store.databaseAuthority();
    if (saved !== undefined) return saved && sameAuthority(saved, authority) ? legacy : scoped;
    let evidence = false;
    let foreign = false;
    for (const project of store.listProjects()) {
      if (!project.localRoot) continue;
      const binding = readNotebookBinding(path.join(directory, "notebook-lifecycle"), project.localRoot);
      const marker = await readMarker(project.localRoot);
      for (const identity of [binding, marker]) {
        if (!identity) continue;
        if (!sameAuthority(identity, authority)) foreign = true;
        else if (identity.projectId === project.projectId) evidence = true;
      }
    }
    const owner = !foreign && (evidence || (remembered !== null && sameAuthority(remembered, authority))) ? authority : null;
    if (!owner) {
      // Foreign or missing evidence (another server's account with the same id,
      // or the folders holding the markers are not mounted) proves nothing about
      // the real owner. Pinning the file to nobody would send that owner to an
      // empty database for good, so it stays unpinned and only this sign-in
      // uses the scoped one.
      logger.warn(`The legacy collaboration database ${legacy} was left untouched because its server identity could not be established for this sign-in.`);
      return scoped;
    }
    // FULL-synchronous SQLite commits ownership under the existing process
    // lock, without copying a database/WAL or losing unacknowledged batches.
    store.setDatabaseAuthority(owner);
    return legacy;
  } finally { store.close(); }
}
