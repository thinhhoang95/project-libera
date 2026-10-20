// Every user-facing sentence about collaboration state lives here, so the
// pill, the account dialog and the tests agree on the wording.

import type { HostConnection, ShareProgress } from "@/lib/collab/local-api";
import type { NotificationInfo } from "@/lib/collab/protocol/api";
import type { SyncState, SyncStatus } from "@/lib/collab/protocol/local";
import type { Role } from "@/lib/collab/protocol/roles";

/** Visual tone; components map it to colours (collab.css). */
export type CollabTone = "neutral" | "local" | "busy" | "ok" | "warn" | "danger";

export interface ConnectionWording {
  label: string;
  detail: string;
  tone: CollabTone;
}

export const CONNECTION_WORDING: Record<HostConnection, ConnectionWording> = {
  "signed-out": {
    label: "Not signed in",
    detail: "Sign in to share notebooks and edit them with others.",
    tone: "neutral",
  },
  connecting: {
    label: "Connecting…",
    detail: "Connecting to the collaboration server. You can keep editing.",
    tone: "busy",
  },
  connected: {
    label: "Connected",
    detail: "Changes to shared notebooks sync as you type.",
    tone: "ok",
  },
  offline: {
    label: "Offline",
    detail: "Offline — changes are saved on this device and sync when the connection returns.",
    tone: "local",
  },
  "needs-sign-in": {
    label: "Sign in again",
    detail: "Sign in again to keep syncing; your edits are saved on this device.",
    tone: "warn",
  },
  "update-required": {
    label: "Update required",
    detail: "The server needs a newer version of Libera. Update Libera to keep syncing; your edits are saved on this device.",
    tone: "danger",
  },
};

export function connectionWording(connection: HostConnection): ConnectionWording {
  return CONNECTION_WORDING[connection];
}

/** "now", "12 s", "4 min", "3 h", "2 d". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "just now", "4 min ago". */
export function timeAgo(ms: number): string {
  const age = formatAge(ms);
  return age === "now" ? "just now" : `${age} ago`;
}

function changes(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

export interface SyncWording {
  /** Short text shown in the pill. */
  label: string;
  /** Sentence for the tooltip and the accessible description. */
  detail: string;
  tone: CollabTone;
}

/** Pill wording for each SyncState (collaboration map §6). */
export function syncWording(status: SyncStatus, now = Date.now()): SyncWording {
  const { pending, oldestPendingAgeMs } = status;
  const waiting = pending > 0 ? ` ${changes(pending)} waiting, oldest ${formatAge(oldestPendingAgeMs)}.` : "";
  const extra = status.detail ? ` ${status.detail}` : "";
  const byState: Record<SyncState, () => SyncWording> = {
    deleted: () => ({ label: "File deleted", detail: "This file was deleted from the shared notebook. Your local text is kept; copy or export it.", tone: "warn" }),
    loading: () => ({ label: "Loading…", detail: `Opening the shared document.${extra}`, tone: "neutral" }),
    "saved-local": () => ({
      label: "Saved on this device",
      detail: `Every edit is saved on this device but not yet in the shared workspace.${waiting}${extra}`,
      tone: "local",
    }),
    syncing: () => ({
      label: pending > 0 ? `Syncing ${pending}…` : "Syncing…",
      detail: `Sending ${changes(pending)} to the shared workspace.${pending > 0 ? ` Oldest waiting ${formatAge(oldestPendingAgeMs)}.` : ""}${extra}`,
      tone: "busy",
    }),
    "saved-remote": () => ({
      label: "Saved to workspace",
      detail: `Everything is saved to the shared workspace.${
        status.lastAckAt ? ` Last confirmed ${timeAgo(now - status.lastAckAt)}.` : ""
      }${extra}`,
      tone: "ok",
    }),
    offline: () => ({
      label: pending > 0 ? `Offline — ${changes(pending)} on this device` : "Offline",
      detail: `Offline — changes are saved on this device and sync when the connection returns.${waiting}${extra}`,
      tone: "local",
    }),
    "read-only": () => ({
      label: "Read-only — update required",
      detail: `This document was saved by a newer version of Libera. Update Libera to edit it.${extra}`,
      tone: "danger",
    }),
    "access-changed": () => ({
      label: "Access changed",
      detail: `Your access to this notebook changed. Your local work is kept; copy or export it.${waiting}${extra}`,
      tone: "danger",
    }),
  };
  return byState[status.state]();
}

export const INVITABLE_ROLES: ReadonlyArray<Exclude<Role, "owner">> = ["editor", "commenter", "viewer"];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

/** One line per role, from the permission table in collaboration map §4. */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Manages members and roles, and can do everything an editor can.",
  editor: "Edits text and files, and accepts or rejects suggestions.",
  commenter: "Reads, comments and suggests changes, but cannot edit directly.",
  viewer: "Reads documents, comments and history.",
};

const SHARE_PHASE_LABEL: Record<ShareProgress["phase"], string> = {
  "creating-project": "Creating the shared notebook",
  "importing-documents": "Importing documents",
  "uploading-files": "Uploading files",
  "writing-manifest": "Writing the file list",
  done: "Done",
};

export function shareProgressLabel(progress: ShareProgress): string {
  const label = SHARE_PHASE_LABEL[progress.phase];
  return progress.total > 0 && progress.phase !== "done" ? `${label} (${progress.done} of ${progress.total})` : label;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function personName(value: unknown): string {
  return value && typeof value === "object" ? text((value as { displayName?: unknown }).displayName) || "Someone" : "Someone";
}

/** Same sentences as the server's email digest (server/src/jobs/digest.ts). */
export function describeNotification(notification: NotificationInfo): string {
  const payload = notification.payload ?? {};
  switch (notification.kind) {
    case "mention":
      return `${personName(payload.author)} mentioned you: ${text(payload.excerpt)}`.trim();
    case "reply":
      return `${personName(payload.author)} replied: ${text(payload.excerpt)}`.trim();
    case "thread-resolved":
      return `${personName(payload.resolvedBy)} resolved your comment${payload.quote ? `: “${text(payload.quote)}”` : ""}`;
    case "invited":
      return `${personName(payload.inviter)} invited you to “${text(payload.projectName) || "a notebook"}”`;
    case "review-requested":
      return "You were asked to review a document";
    case "review-decided":
      return "A review you requested was decided";
    default:
      return "New activity";
  }
}

/** Up to two initials, e.g. "Minh Tran" → "MT", "ada" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? [...words[0]].slice(0, 1) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join("").toUpperCase();
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return "#ffffff";
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  const channel = (offset: number) => {
    const value = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Contrast with black is (L + 0.05) / 0.05, with white 1.05 / (L + 0.05).
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
