"use client";

// Small pieces the existing shell mounts: the rail buttons, the shared badge
// in the Notebooks panel, the Library's join button and the notebook menu
// items. Each reads CollabProvider's context and renders nothing without it
// or while collaboration is hidden, so the shell needs no conditionals.

import { UserPlus, Users, UserX } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LocalProject } from "@/lib/collab/local-api";
import { useCollabStatus } from "@/lib/collab/ui/hooks";
import { connectionWording, roleLabel } from "@/lib/collab/ui/wording";
import { useCollabShell, type CollabShellValue } from "./collab-provider";
import { NotificationsBell } from "./notifications-bell";
import "./collab.css";

/** Collaboration status button and notifications bell for the left rail. */
export function CollabRailButtons() {
  const t = useTranslations("collab.collabShell");
  const tWording = useTranslations("lib.collab.ui.wording");
  const shell = useCollabShell();
  const collab = useCollabStatus();
  if (!shell?.visible) return null;
  const status = collab.status;
  const wording = status ? connectionWording(status.connection, tWording) : null;
  const tone = wording?.tone ?? (collab.phase === "error" ? "danger" : "neutral");
  const label = wording?.label ?? (collab.error ? t("unavailable") : t("collaboration"));
  const pending = status?.pendingCommands ?? 0;
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <NotificationsBell onOpenDocument={shell.openNotificationTarget} onOpenInvitation={(invitation) => shell.openJoin(invitation)} />
      <button
        aria-label={t("railLabel", { label, hasPending: pending ? "yes" : "no", count: pending })}
        className="libera-sidebar-icon-button relative inline-flex h-9 w-9 items-center justify-center rounded-lg"
        title={wording ? t("railTitle", { detail: wording.detail }) : collab.error ?? t("collaboration")}
        type="button"
        onClick={shell.openAccount}
      >
        <Users aria-hidden className="h-4 w-4" />
        {status?.connection !== "signed-out" ? (
          <span aria-hidden className="libera-collab-dot absolute bottom-1.5 right-1.5 h-2 w-2 rounded-full" data-tone={tone} />
        ) : null}
      </button>
    </div>
  );
}

/** People icon after a shared notebook's name; struck through once access is revoked. */
export function SharedNotebookBadge({ notebook }: { notebook: string }) {
  const shell = useCollabShell();
  const project = shell?.visible ? shell.projectForNotebook(notebook) : undefined;
  if (!project) return null;
  return <ProjectBadge project={project} />;
}

export function ProjectBadge({ project }: { project: LocalProject }) {
  const t = useTranslations("collab.collabShell");
  const tWording = useTranslations("lib.collab.ui.wording");
  const label = project.revoked
    ? t("revokedBadge")
    : t("sharedBadge", { role: roleLabel(project.role, tWording), hasReview: project.reconcilePending ? "yes" : "no", count: project.reconcilePending ?? 0 });
  const Icon = project.revoked ? UserX : Users;
  return (
    <span aria-label={label} className="libera-collab-ink inline-flex shrink-0 items-center" data-tone={project.revoked ? "danger" : project.reconcilePending ? "warn" : "neutral"} role="img" title={label}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </span>
  );
}

/** "Join a shared notebook…" for the Library heading. */
export function CollabJoinButton({ className }: { className: string }) {
  const t = useTranslations("collab.collabShell");
  const shell = useCollabShell();
  if (!shell?.visible || !shell.signedIn) return null;
  return (
    <button aria-label={t("joinLabel")} className={className} title={t("joinTitle")} type="button" onClick={() => shell.openJoin()}>
      <UserPlus aria-hidden className="h-4 w-4" />
    </button>
  );
}

const SHARE_ITEM = "collab:share";
const MANAGE_ITEM = "collab:manage";

/** English menu labels; pass the `collab.collabShell` messages `menuManage` and `menuShare` instead. */
const DEFAULT_MENU_LABELS = { manage: "Sharing and members…", share: "Share notebook…" };

/** The translated menu labels, to pass as the third argument of collabNotebookMenuItems. */
export function useCollabNotebookMenuLabels(): { manage: string; share: string } {
  const t = useTranslations("collab.collabShell");
  return { manage: t("menuManage"), share: t("menuShare") };
}

/** Native menu items for a notebook's menu, with a leading separator; empty when none apply. */
export function collabNotebookMenuItems(
  shell: CollabShellValue | null,
  notebook: { name: string; folder?: unknown },
  labels: { manage: string; share: string } = DEFAULT_MENU_LABELS,
): Array<{ id: string; label: string } | { type: "separator" }> {
  if (!shell?.visible || !shell.signedIn || notebook.folder) return [];
  const project = shell.projectForNotebook(notebook.name);
  if (project) {
    return project.revoked ? [] : [{ type: "separator" }, { id: MANAGE_ITEM, label: labels.manage }];
  }
  return shell.canShareNotebook(notebook) ? [{ type: "separator" }, { id: SHARE_ITEM, label: labels.share }] : [];
}

/** Handles a selected menu id; returns false when the id is not a collaboration item. */
export function runCollabNotebookMenuItem(shell: CollabShellValue | null, itemId: string, notebook: string): boolean {
  if (!shell || (itemId !== SHARE_ITEM && itemId !== MANAGE_ITEM)) return false;
  shell.openShare(notebook);
  return true;
}
