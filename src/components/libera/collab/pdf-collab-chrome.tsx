"use client";

// The strip above a live PDF: the durability pill in place of the
// unsaved-changes dot, who else is here, and the banners for refused marks,
// changed access and a note someone deleted while it was open here.

import { Lock, RotateCcw, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessChangedBanner, CollabStatusPill, PresenceAvatars, RejectedEditBanner } from "@/components/libera/collab";
import { downloadText, REVEAL_MS, sharedBannerKind } from "@/lib/collab/bindings/react-shared-chrome";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import type { ReplicaSnapshot } from "@/lib/collab/client/replica";
import type { PdfPresenceSnapshot, PdfPresenceStore } from "@/lib/collab/pdf/presence";
import type { SharedPdfState } from "@/lib/collab/pdf/react";
import type { SyncStatus } from "@/lib/collab/protocol/local";
import { syncWording } from "@/lib/collab/ui/wording";
import { useProjectMembers } from "./mentions/mention-textarea";
import { PdfCollabTools } from "./pdf-collab-tools";

const LOADING_STATUS: SyncStatus = { state: "loading", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: false };

const NO_PRESENCE: PdfPresenceSnapshot = { users: [], ghosts: [] };
const noSubscribe = () => () => {};
const noPresence = () => NO_PRESENCE;

/** Anyone can change anyone's marks, so a selected mark says whose it is. */
function MarkAuthors({ shared, id }: { shared: Extract<SharedPdfState, { kind: "shared" }>; id: string }) {
  const members = useProjectMembers(shared.resolved.projectId);
  const record = shared.store.record(id);
  if (!record || !members.length) return null;
  const name = (accountId: string) => accountId === shared.resolved.accountId ? "you" : members.find((member) => member.id === accountId)?.displayName ?? "a former member";
  const added = name(record.createdBy);
  return (
    <span className="min-w-0 truncate text-xs text-muted-foreground">
      Added by {added}{record.updatedBy && record.updatedBy !== record.createdBy ? `, last changed by ${name(record.updatedBy)}` : ""}
    </span>
  );
}

export interface PdfCollabChromeProps {
  shared: SharedPdfState;
  snapshot: ReplicaSnapshot | null;
  fileName: string;
  /** The PDF's path in the workspace, which Cmd/Ctrl+S names. */
  filePath: string;
  /** The mark selected here, to say who made it. */
  selectedMarkId?: string | null;
  /** Read here, not passed in, so a moving pointer never re-renders the viewer. */
  presence?: PdfPresenceStore | null;
  followingClientId?: number | null;
  onFollow?: (clientId: number) => void;
  /** A mark someone deleted while it was selected here. */
  deletedMark?: { id: string; by: string } | null;
  onRestoreDeleted?: () => void;
  onDismissDeleted?: () => void;
  /** Marks can be changed here. */
  canAnnotate?: boolean;
  /** Marks placed on an earlier version of this PDF. */
  staleMarks?: number;
  onAcceptVersion?: () => void;
  children?: ReactNode;
}

export function PdfCollabChrome({ shared, snapshot, fileName, filePath, selectedMarkId, presence, followingClientId, onFollow, deletedMark, onRestoreDeleted, onDismissDeleted, canAnnotate = false, staleMarks = 0, onAcceptVersion, children }: PdfCollabChromeProps) {
  const { users } = useSyncExternalStore(presence?.subscribe ?? noSubscribe, presence?.getSnapshot ?? noPresence, noPresence);
  // Cmd/Ctrl+S: there is nothing to save, so say where the marks are.
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  useEffect(() => getSharedDocRegistry().onRevealStatus((target) => {
    if (target === filePath) setRevealedAt(Date.now());
  }), [filePath]);
  useEffect(() => {
    if (revealedAt === null) return;
    const timer = setTimeout(() => setRevealedAt(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealedAt]);
  if (shared.kind !== "shared") return null;
  const banner = sharedBannerKind(snapshot);
  const rejection = snapshot?.rejection;
  const viewOnly = !canAnnotate && banner === null;
  const myVersion = shared.resolved.blobHash?.slice(0, 12);
  const otherVersion = users.find((user) => user.presence?.version && myVersion && user.presence.version !== myVersion);
  const exportMarks = () => downloadText(`${fileName}.annotations.json`, JSON.stringify(shared.store.getSnapshot(), null, 2));

  return (
    <div className="libera-pdf-collab" data-pdf-annotation-ui>
      <div className="flex min-w-0 items-center gap-2 border-b border-input bg-card px-4 py-1">
        <div className="relative shrink-0">
          <CollabStatusPill status={snapshot?.status ?? LOADING_STATUS} />
          {revealedAt !== null ? (
            <div className="libera-collab-popover absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-16px)] whitespace-normal break-words rounded-md border border-border bg-card px-2.5 py-1.5 text-xs leading-relaxed shadow-lg" role="status">
              <span className="block font-semibold">{syncWording(snapshot?.status ?? LOADING_STATUS).label}</span>
              <span className="block text-muted-foreground">Marks on a live PDF save as you make them. {syncWording(snapshot?.status ?? LOADING_STATUS).detail}</span>
            </div>
          ) : null}
        </div>
        {selectedMarkId ? <MarkAuthors shared={shared} id={selectedMarkId} /> : null}
        {viewOnly ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Lock aria-hidden className="h-3.5 w-3.5" />
            View only
          </span>
        ) : null}
        <PdfCollabTools canAnnotate={canAnnotate} shared={shared} />
        {otherVersion ? <span className="truncate text-xs text-muted-foreground">{otherVersion.name} has a different version of this PDF.</span> : null}
        {children}
        <PresenceAvatars
          className="ml-auto"
          users={users.map((user) => ({ clientId: user.clientId, name: user.name, color: user.color, section: user.presence ? `Page ${user.presence.page}` : undefined }))}
          followingClientId={followingClientId ?? null}
          onFollow={onFollow ? (clientId) => onFollow(Number(clientId)) : undefined}
        />
      </div>
      {rejection ? (
        <RejectedEditBanner
          reason={rejection.reason}
          rejectedText={rejection.rejectedText}
          onDismiss={() => shared.session.replica.dismissRejection()}
        />
      ) : null}
      {banner === "access-changed" ? <AccessChangedBanner onExport={exportMarks} /> : null}
      {banner === "deleted" ? <AccessChangedBanner detail="This PDF was deleted from the notebook." onExport={exportMarks} /> : null}
      {banner === "update-required" ? <AccessChangedBanner detail="Update Libera to change these annotations." onExport={exportMarks} /> : null}
      {staleMarks > 0 ? (
        <div className="flex items-center gap-2 border-b border-input bg-card px-4 py-1.5 text-xs" role="status">
          <span className="min-w-0 flex-1">This PDF changed. {staleMarks === 1 ? "1 mark was" : `${staleMarks} marks were`} placed on an earlier version and may not line up.</span>
          {canAnnotate ? <button type="button" className="shrink-0 rounded-md border border-input px-2 py-0.5 font-medium hover:bg-muted" onClick={onAcceptVersion}>Keep them here</button> : null}
        </div>
      ) : null}
      {deletedMark ? (
        <div className="flex items-center gap-2 border-b border-input bg-card px-4 py-1.5 text-xs" role="status">
          <span className="min-w-0 flex-1">Someone deleted the annotation you had open. What you wrote is kept with it.</span>
          <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-2 py-0.5 font-medium hover:bg-muted" onClick={onRestoreDeleted}>
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
            Restore
          </button>
          <button type="button" className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onDismissDeleted}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
