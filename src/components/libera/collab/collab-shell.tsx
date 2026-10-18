"use client";

// Small pieces the existing shell mounts: the rail buttons, the shared badge
// in the Notebooks panel, the Library's join button and the notebook menu
// items. Each reads CollabProvider's context and renders nothing without it
// or while collaboration is hidden, so the shell needs no conditionals.

import { UserPlus, Users, UserX } from "lucide-react";
import type { LocalProject } from "@/lib/collab/local-api";
import { useCollabStatus } from "@/lib/collab/ui/hooks";
import { connectionWording, ROLE_LABEL } from "@/lib/collab/ui/wording";
import { useCollabShell, type CollabShellValue } from "./collab-provider";
import { NotificationsBell } from "./notifications-bell";
import "./collab.css";

/** Collaboration status button and notifications bell for the left rail. */
export function CollabRailButtons() {
  const shell = useCollabShell();
  const collab = useCollabStatus();
  if (!shell?.visible) return null;
  const status = collab.status;
  const wording = status ? connectionWording(status.connection) : null;
  const tone = wording?.tone ?? (collab.phase === "error" ? "danger" : "neutral");
  const label = wording?.label ?? (collab.error ? "Unavailable" : "Collaboration");
  const pending = status?.pendingCommands ?? 0;
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <NotificationsBell onOpenDocument={shell.openNotificationTarget} onOpenInvitation={(invitation) => shell.openJoin(invitation)} />
      <button
        aria-label={`Collaboration: ${label}${pending ? `, ${pending} waiting to send` : ""}`}
        className="libera-sidebar-icon-button relative inline-flex h-9 w-9 items-center justify-center rounded-lg"
        title={wording ? `Collaboration — ${wording.detail}` : collab.error ?? "Collaboration"}
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
  const label = project.revoked
    ? "No longer shared — read-only copy"
    : `Shared · ${ROLE_LABEL[project.role]}${project.reconcilePending ? ` · ${project.reconcilePending} to review` : ""}`;
  const Icon = project.revoked ? UserX : Users;
  return (
    <span aria-label={label} className="libera-collab-ink inline-flex shrink-0 items-center" data-tone={project.revoked ? "danger" : project.reconcilePending ? "warn" : "neutral"} role="img" title={label}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </span>
  );
}

/** "Join a shared notebook…" for the Library heading. */
export function CollabJoinButton({ className }: { className: string }) {
  const shell = useCollabShell();
  if (!shell?.visible || !shell.signedIn) return null;
  return (
    <button aria-label="Join a shared notebook" className={className} title="Join a shared notebook…" type="button" onClick={() => shell.openJoin()}>
      <UserPlus aria-hidden className="h-4 w-4" />
    </button>
  );
}

const SHARE_ITEM = "collab:share";
const MANAGE_ITEM = "collab:manage";

/** Native menu items for a notebook's menu, with a leading separator; empty when none apply. */
export function collabNotebookMenuItems(
  shell: CollabShellValue | null,
  notebook: { name: string; folder?: unknown },
): Array<{ id: string; label: string } | { type: "separator" }> {
  if (!shell?.visible || !shell.signedIn || notebook.folder) return [];
  const project = shell.projectForNotebook(notebook.name);
  if (project) {
    return project.revoked ? [] : [{ type: "separator" }, { id: MANAGE_ITEM, label: "Sharing and members…" }];
  }
  return shell.canShareNotebook(notebook) ? [{ type: "separator" }, { id: SHARE_ITEM, label: "Share notebook…" }] : [];
}

/** Handles a selected menu id; returns false when the id is not a collaboration item. */
export function runCollabNotebookMenuItem(shell: CollabShellValue | null, itemId: string, notebook: string): boolean {
  if (!shell || (itemId !== SHARE_ITEM && itemId !== MANAGE_ITEM)) return false;
  shell.openShare(notebook);
  return true;
}
