"use client";

// The strip above a live PDF: the durability pill in place of the
// unsaved-changes dot, who else is here, and the banners for refused marks,
// changed access and a note someone deleted while it was open here.

import { Lock, RotateCcw, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { AccessChangedBanner, CollabStatusPill, PresenceAvatars, RejectedEditBanner } from "@/components/libera/collab";
import { downloadText, sharedBannerKind } from "@/lib/collab/bindings/react-shared-chrome";
import type { ReplicaSnapshot } from "@/lib/collab/client/replica";
import type { PdfPresenceSnapshot, PdfPresenceStore } from "@/lib/collab/pdf/presence";
import type { SharedPdfState } from "@/lib/collab/pdf/react";
import type { SyncStatus } from "@/lib/collab/protocol/local";

const LOADING_STATUS: SyncStatus = { state: "loading", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: false };

const NO_PRESENCE: PdfPresenceSnapshot = { users: [], ghosts: [] };
const noSubscribe = () => () => {};
const noPresence = () => NO_PRESENCE;

export interface PdfCollabChromeProps {
  shared: SharedPdfState;
  snapshot: ReplicaSnapshot | null;
  fileName: string;
  /** Read here, not passed in, so a moving pointer never re-renders the viewer. */
  presence?: PdfPresenceStore | null;
  followingClientId?: number | null;
  onFollow?: (clientId: number) => void;
  /** A mark someone deleted while it was selected here. */
  deletedMark?: { id: string; by: string } | null;
  onRestoreDeleted?: () => void;
  onDismissDeleted?: () => void;
  /** Controls for the chrome's right side (the Deleted marks list). */
  children?: ReactNode;
}

export function PdfCollabChrome({ shared, snapshot, fileName, presence, followingClientId, onFollow, deletedMark, onRestoreDeleted, onDismissDeleted, children }: PdfCollabChromeProps) {
  const { users } = useSyncExternalStore(presence?.subscribe ?? noSubscribe, presence?.getSnapshot ?? noPresence, noPresence);
  if (shared.kind !== "shared") return null;
  const banner = sharedBannerKind(snapshot);
  const rejection = snapshot?.rejection;
  const viewOnly = shared.resolved.readOnly && banner === null;
  const exportMarks = () => downloadText(`${fileName}.annotations.json`, JSON.stringify(shared.store.getSnapshot(), null, 2));

  return (
    <div className="libera-pdf-collab" data-pdf-annotation-ui>
      <div className="flex min-w-0 items-center gap-2 border-b border-input bg-card px-4 py-1">
        <CollabStatusPill status={snapshot?.status ?? LOADING_STATUS} />
        {viewOnly ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Lock aria-hidden className="h-3.5 w-3.5" />
            View only
          </span>
        ) : null}
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
