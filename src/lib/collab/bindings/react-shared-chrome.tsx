"use client";

// The strip above a shared tab's editor: the durability pill in place of the
// unsaved-changes dot (map §6), the people in the document with follow and
// quiet mode, and the banners for rejected edits, changed access and newer
// documents (plan M1.6, M1.8, M1.9), and the "Suggesting" toggle of the
// CodeMirror editors (plan M3.2; a commenter's is always on).

import { Lock, MessageSquarePlus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AccessChangedBanner, CollabStatusPill, PresenceAvatars, RejectedEditBanner } from "@/components/libera/collab";
import { syncWording } from "../ui/wording";
import type { SyncStatus } from "../protocol/local";
import { getSharedDocRegistry, type SharedDocSession } from "../client/registry";
import type { ReplicaSnapshot } from "../client/replica";
import { editorControllerFor } from "./react-codemirror";
import { useSharedPresence } from "./react-shared-tabs";

const LOADING_STATUS: SyncStatus = { state: "loading", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: false };
const REVEAL_MS = 4000;

/** Saves `text` as a file outside the shared notebook (the Export of the access-changed banner). */
export function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The read-only banner a shared tab needs, from its replica state (a rejection banner can show beside it). */
export function sharedBannerKind(snapshot: ReplicaSnapshot | null): "access-changed" | "update-required" | "deleted" | null {
  if (!snapshot) return null;
  if (snapshot.closed === "document-deleted" || snapshot.meta?.readOnlyReason === "document-deleted") return "deleted";
  if (snapshot.status?.state === "access-changed" || snapshot.meta?.readOnlyReason === "access-revoked") return "access-changed";
  if (snapshot.status?.state === "read-only" || snapshot.meta?.readOnlyReason === "schema-newer") return "update-required";
  return null;
}

export interface SharedTabChromeProps {
  tabId: string;
  fileName: string;
  session: SharedDocSession;
  snapshot: ReplicaSnapshot | null;
  /** Shown when the tab asked for an editor that shared notes cannot use yet. */
  notice?: string;
}

export function SharedTabChrome({ tabId, fileName, session, snapshot, notice }: SharedTabChromeProps) {
  const { replica } = session;
  const controller = editorControllerFor(replica);
  const controls = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const users = useSharedPresence(session);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [dismissedAccess, setDismissedAccess] = useState(false);

  // Cmd/Ctrl+S on a shared tab: there is nothing to save, so say where the edits are.
  useEffect(() => getSharedDocRegistry().onRevealStatus((target) => {
    if (target === tabId) setRevealedAt(Date.now());
  }), [tabId]);
  useEffect(() => {
    if (revealedAt === null) return;
    const timer = setTimeout(() => setRevealedAt(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealedAt]);

  const status = snapshot?.status ?? LOADING_STATUS;
  const wording = syncWording(status);
  const banner = sharedBannerKind(snapshot);
  const role = snapshot?.meta?.role;
  const roleReadOnly = !!role && (role === "viewer" || role === "commenter") && banner === null;

  return (
    <div className="libera-shared-tab-chrome flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-3 py-1.5" data-shared-doc={session.docId}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative">
          <CollabStatusPill status={status} />
          {revealedAt !== null ? (
            <div
              className="libera-collab-popover absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg"
              role="status"
            >
              <span className="block font-semibold">{wording.label}</span>
              <span className="block text-muted-foreground">Shared notes save as you type. {wording.detail}</span>
            </div>
          ) : null}
        </div>
        {roleReadOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock aria-hidden className="h-3.5 w-3.5" />
            {role === "commenter" ? "You can suggest changes and comment; editors decide." : "View only"}
          </span>
        ) : null}
        {controls.canSuggest ? (
          <button
            type="button"
            className="libera-collab-suggesting-toggle inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium aria-pressed:bg-primary aria-pressed:text-primary-foreground disabled:opacity-80"
            aria-pressed={controls.suggesting}
            disabled={controls.suggestForced}
            title={controls.suggestForced ? "Commenters always suggest: your edits become suggestions for an editor to accept." : controls.suggesting ? "Typing makes suggestions. Click to edit directly." : "Make your edits suggestions that others accept or reject."}
            onClick={() => controller.setSuggesting(!controls.suggesting)}
          >
            <MessageSquarePlus aria-hidden className="h-3.5 w-3.5" />
            Suggesting
          </button>
        ) : null}
        {notice ? <span className="truncate text-xs text-muted-foreground">{notice}</span> : null}
        <PresenceAvatars
          className="ml-auto"
          users={users.map((user) => ({ clientId: user.clientId, name: user.name, color: user.color, section: user.section?.title }))}
          followingClientId={controls.followingClientId}
          onFollow={controls.views ? (clientId) => {
            if (controls.followingClientId === clientId) controller.stopFollowing();
            else controller.follow(Number(clientId));
          } : undefined}
          quiet={controls.views ? controls.quiet : undefined}
          onQuietChange={controls.views ? (quiet) => controller.setQuiet(quiet) : undefined}
        />
      </div>
      {banner === "access-changed" && !dismissedAccess ? (
        <AccessChangedBanner
          onExport={() => downloadText(fileName, replica.text())}
          onDismiss={() => setDismissedAccess(true)}
        />
      ) : null}
      {banner === "deleted" ? (
        <div className="libera-collab-tone flex items-center gap-2 rounded-lg px-3 py-2 text-sm" data-tone="warn" role="alert">
          <Lock aria-hidden className="h-4 w-4 shrink-0" />
          <p className="flex-1">This file was deleted. Your local text is kept here for recovery.</p>
          <button type="button" className="shrink-0 underline" onClick={() => downloadText(fileName, replica.text())}>Export text</button>
        </div>
      ) : null}
      {banner === "update-required" ? (
        <div className="libera-collab-tone flex items-start gap-2 rounded-lg px-3 py-2 text-sm" data-tone="danger" role="alert">
          <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Update required</p>
            <p className="text-xs opacity-80">{syncWording({ ...status, state: "read-only" }).detail}</p>
          </div>
        </div>
      ) : null}
      {snapshot?.rejection ? (
        <RejectedEditBanner
          rejectedText={snapshot.rejection.rejectedText}
          reason={snapshot.rejection.reason}
          onDismiss={() => replica.dismissRejection()}
        />
      ) : null}
    </div>
  );
}
