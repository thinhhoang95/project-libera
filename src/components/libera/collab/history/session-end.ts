"use client";

// Session-end checkpoints (plan M2.4, source plan §6.2): when the last tab
// showing a shared document closes in this window after this window edited
// its text, ask for a `session-end` revision. The host queues it as a
// command, so it survives a closing window or a dropped network, and the
// server shares one checkpoint per state, so other windows (or other people)
// ending a session on the same text do not add more.

import { useEffect } from "react";
import type * as Y from "yjs";
import { ControlRoutes } from "@/lib/collab/local-api";
import { ReplicaOrigin } from "@/lib/collab/protocol/local";
import { getSharedDocRegistry, type SharedDocRegistry } from "@/lib/collab/client/registry";
import type { CollabReplica } from "@/lib/collab/client/replica";
import { collabClient } from "@/lib/collab/ui/client";

interface Tracked {
  replica: CollabReplica;
  content: Y.Doc;
  edited: boolean;
  stop: () => void;
}

/** Watches the registry's tabs; calls `checkpoint(docId)` when an edited document's last tab is released. */
export function startSessionEndRevisions(registry: SharedDocRegistry, checkpoint: (docId: string) => void): () => void {
  const tracked = new Map<string, Tracked>();

  const watch = (docId: string, replica: CollabReplica): Tracked => {
    const entry: Tracked = { replica, content: replica.content, edited: false, stop: () => {} };
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // Everything not applied from the hub is this window's own editing.
      if (origin !== ReplicaOrigin.hub) entry.edited = true;
    };
    const bind = () => {
      entry.content.off("update", onUpdate);
      entry.content = replica.content;
      entry.content.on("update", onUpdate);
    };
    entry.content.on("update", onUpdate);
    const offRebuild = replica.onRebuild((subdoc) => { if (subdoc === "content") bind(); });
    entry.stop = () => {
      entry.content.off("update", onUpdate);
      offRebuild();
    };
    tracked.set(docId, entry);
    return entry;
  };

  const sync = () => {
    const open = new Map<string, CollabReplica>();
    for (const tabId of registry.boundTabIds()) {
      const session = registry.sessionForTab(tabId);
      if (session && !session.replica.isDestroyed) open.set(session.docId, session.replica);
    }
    for (const [docId, replica] of open) {
      const entry = tracked.get(docId);
      if (entry && entry.replica === replica) continue;
      if (entry) {
        // The replica was reopened: carry the edited flag over.
        entry.stop();
        watch(docId, replica).edited = entry.edited;
      } else {
        watch(docId, replica);
      }
    }
    for (const [docId, entry] of [...tracked]) {
      if (open.has(docId)) continue;
      entry.stop();
      tracked.delete(docId);
      if (entry.edited) checkpoint(docId);
    }
  };

  const unsubscribe = registry.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const entry of tracked.values()) entry.stop();
    tracked.clear();
  };
}

/** Mounted once per window (by the review provider). A no-op without the desktop bridge. */
export function useSessionEndRevisions(): void {
  useEffect(() => {
    const registry = getSharedDocRegistry();
    if (!registry.available) return;
    return startSessionEndRevisions(registry, (docId) => {
      // Best effort: the server dedupes, and a lost checkpoint loses nothing.
      void collabClient.request("POST", ControlRoutes.revisions(docId), { kind: "session-end" }).catch(() => undefined);
    });
  }, []);
}
