// Every user-facing sentence about collaboration state lives here (and in the `lib.collab.ui.wording` messages), so
// the pill, the account dialog and the tests agree on the wording. Functions take a translator `t` made with
// `useTranslations("lib.collab.ui.wording")`; without one they fall back to the English messages in messages/en.json,
// which keeps callers that have not been converted yet (and the tests) working.

import { createTranslator } from "next-intl";
import type { HostConnection, ShareProgress } from "@/lib/collab/local-api";
import type { NotificationInfo } from "@/lib/collab/protocol/api";
import type { SyncState, SyncStatus } from "@/lib/collab/protocol/local";
import type { Role } from "@/lib/collab/protocol/roles";
import { lib } from "../../../../messages/en.json";

/** What `useTranslations("lib.collab.ui.wording")` returns, as far as this file needs it. */
export type WordingTranslator = (key: string, values?: Record<string, string | number>) => string;

const englishTranslator = createTranslator({ locale: "en", messages: lib.collab.ui.wording, onError: () => {} }) as unknown as WordingTranslator;

/** Visual tone; components map it to colours (collab.css). */
export type CollabTone = "neutral" | "local" | "busy" | "ok" | "warn" | "danger";

export interface ConnectionWording {
  label: string;
  detail: string;
  tone: CollabTone;
}

const CONNECTION_KEY: Record<HostConnection, { key: string; tone: CollabTone }> = {
  "signed-out": { key: "signedOut", tone: "neutral" },
  connecting: { key: "connecting", tone: "busy" },
  connected: { key: "connected", tone: "ok" },
  offline: { key: "offline", tone: "local" },
  "needs-sign-in": { key: "needsSignIn", tone: "warn" },
  "update-required": { key: "updateRequired", tone: "danger" },
};

/** Whether the host reported a connection state this build knows (a status that is missing it, or newer than the app, has none). */
export function isKnownConnection(connection: unknown): connection is HostConnection {
  return typeof connection === "string" && Object.hasOwn(CONNECTION_KEY, connection);
}

export function connectionWording(connection: HostConnection, t: WordingTranslator = englishTranslator): ConnectionWording {
  const { key, tone } = CONNECTION_KEY[connection];
  return { label: t(`connection.${key}.label`), detail: t(`connection.${key}.detail`), tone };
}

/** The English wording; kept for tests and callers that have no translator. */
export const CONNECTION_WORDING: Record<HostConnection, ConnectionWording> = Object.fromEntries(
  (Object.keys(CONNECTION_KEY) as HostConnection[]).map((connection) => [connection, connectionWording(connection)]),
) as Record<HostConnection, ConnectionWording>;

/** "now", "12 s", "4 min", "3 h", "2 d". */
export function formatAge(ms: number, t: WordingTranslator = englishTranslator): string {
  if (!Number.isFinite(ms) || ms < 1000) return t("age.now");
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t("age.seconds", { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("age.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("age.hours", { n: hours });
  return t("age.days", { n: Math.round(hours / 24) });
}

/** "just now", "4 min ago". */
export function timeAgo(ms: number, t: WordingTranslator = englishTranslator): string {
  if (!Number.isFinite(ms) || ms < 1000) return t("ago.justNow");
  return t("ago.ago", { age: formatAge(ms, t) });
}

export interface SyncWording {
  /** Short text shown in the pill. */
  label: string;
  /** Sentence for the tooltip and the accessible description. */
  detail: string;
  tone: CollabTone;
}

/** Pill wording for each SyncState (collaboration map §6). */
export function syncWording(status: SyncStatus, now = Date.now(), t: WordingTranslator = englishTranslator): SyncWording {
  const { pending, oldestPendingAgeMs } = status;
  const join = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");
  const waiting = pending > 0 && t("sync.waiting", { count: pending, age: formatAge(oldestPendingAgeMs, t) });
  const extra = status.detail;
  const byState: Record<SyncState, () => SyncWording> = {
    deleted: () => ({ label: t("sync.deleted.label"), detail: t("sync.deleted.detail"), tone: "warn" }),
    loading: () => ({ label: t("sync.loading.label"), detail: join(t("sync.loading.detail"), extra), tone: "neutral" }),
    "saved-local": () => ({
      label: t("sync.savedLocal.label"),
      detail: join(t("sync.savedLocal.detail"), waiting, extra),
      tone: "local",
    }),
    syncing: () => ({
      label: t("sync.syncing.label", { pending }),
      detail: join(t("sync.syncing.detail", { pending }), pending > 0 && t("sync.syncing.oldest", { age: formatAge(oldestPendingAgeMs, t) }), extra),
      tone: "busy",
    }),
    "saved-remote": () => ({
      label: t("sync.savedRemote.label"),
      detail: join(
        t("sync.savedRemote.detail"),
        status.lastAckAt ? t("sync.savedRemote.confirmed", { when: timeAgo(now - status.lastAckAt, t) }) : "",
        extra,
      ),
      tone: "ok",
    }),
    offline: () => ({
      label: pending > 0 ? t("sync.offline.labelPending", { count: pending }) : t("sync.offline.label"),
      detail: join(t("sync.offline.detail"), waiting, extra),
      tone: "local",
    }),
    "read-only": () => ({ label: t("sync.readOnly.label"), detail: join(t("sync.readOnly.detail"), extra), tone: "danger" }),
    "access-changed": () => ({
      label: t("sync.accessChanged.label"),
      detail: join(t("sync.accessChanged.detail"), waiting, extra),
      tone: "danger",
    }),
  };
  return byState[status.state]();
}

export const INVITABLE_ROLES: ReadonlyArray<Exclude<Role, "owner">> = ["editor", "commenter", "viewer"];

/** A role's name; `album` uses a shared album's words (its editors are contributors). */
export function roleLabel(role: Role, t: WordingTranslator = englishTranslator, album = false): string {
  return t(`roles.${album ? "album" : "notebook"}.${role}.label`);
}

/** One line per role, from the permission table in collaboration map §4. */
export function roleDescription(role: Role, t: WordingTranslator = englishTranslator, album = false): string {
  return t(`roles.${album ? "album" : "notebook"}.${role}.description`);
}

const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];
const englishRoles = (album: boolean, pick: typeof roleLabel) =>
  Object.fromEntries(ROLES.map((role) => [role, pick(role, englishTranslator, album)])) as Record<Role, string>;

/** The English names and descriptions, for callers that have no translator (use roleLabel / roleDescription). */
export const ROLE_LABEL: Record<Role, string> = englishRoles(false, roleLabel);
export const ROLE_DESCRIPTION: Record<Role, string> = englishRoles(false, roleDescription);
export const ALBUM_ROLE_LABEL: Record<Role, string> = englishRoles(true, roleLabel);
export const ALBUM_ROLE_DESCRIPTION: Record<Role, string> = englishRoles(true, roleDescription);

const SHARE_PHASE_KEY: Record<ShareProgress["phase"], string> = {
  "creating-project": "creatingProject",
  "importing-documents": "importingDocuments",
  "uploading-files": "uploadingFiles",
  "writing-manifest": "writingManifest",
  done: "done",
};

export function shareProgressLabel(progress: ShareProgress, t: WordingTranslator = englishTranslator): string {
  const label = t(`phases.${SHARE_PHASE_KEY[progress.phase]}`);
  return progress.total > 0 && progress.phase !== "done" ? t("phases.progress", { label, done: progress.done, total: progress.total }) : label;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function personName(value: unknown, t: WordingTranslator): string {
  return (value && typeof value === "object" ? text((value as { displayName?: unknown }).displayName) : "") || t("notifications.someone");
}

/** Same sentences as the server's email digest (server/src/jobs/digest.ts). */
export function describeNotification(notification: NotificationInfo, t: WordingTranslator = englishTranslator): string {
  const payload = notification.payload ?? {};
  switch (notification.kind) {
    case "mention":
      return t("notifications.mention", { name: personName(payload.author, t), excerpt: text(payload.excerpt) }).trim();
    case "reply":
      return t("notifications.reply", { name: personName(payload.author, t), excerpt: text(payload.excerpt) }).trim();
    case "thread-resolved":
      return t("notifications.threadResolved", { name: personName(payload.resolvedBy, t), hasQuote: payload.quote ? "yes" : "no", quote: text(payload.quote) });
    case "invited":
      return t("notifications.invited", { name: personName(payload.inviter, t), project: text(payload.projectName) || t("notifications.aNotebook") });
    case "review-requested":
      return t("notifications.reviewRequested");
    case "review-decided":
      return t("notifications.reviewDecided");
    case "album-photos-added": {
      const count = typeof payload.count === "number" ? payload.count : 1;
      return t("notifications.albumPhotosAdded", { name: personName(payload.actor, t), count, album: text(payload.albumName) || t("notifications.aSharedAlbum") });
    }
    default:
      return t("notifications.other");
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
