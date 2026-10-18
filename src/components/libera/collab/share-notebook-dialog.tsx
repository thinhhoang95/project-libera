"use client";

import { Check, Copy, LoaderCircle, LogOut, Mail, ShieldAlert, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { Invitation, LocalProject, Member, ShareProgress } from "@/lib/collab/local-api";
import { can, type Role } from "@/lib/collab/protocol/roles";
import { collabClient, describeError } from "@/lib/collab/ui/client";
import { useCollabProjects, useCollabStatus, useHostEvents } from "@/lib/collab/ui/hooks";
import { initials, INVITABLE_ROLES, readableTextColor, ROLE_DESCRIPTION, ROLE_LABEL, shareProgressLabel } from "@/lib/collab/ui/wording";
import { useCopyFeedback } from "./collab-banners";
import "./collab.css";

const FIELD = "mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const SMALL_BUTTON =
  "inline-flex items-center justify-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_SMALL = "inline-flex items-center justify-center gap-1 rounded-md bg-destructive px-2 py-1 text-xs font-medium text-white disabled:opacity-60";

export interface ShareNotebookDialogProps {
  /** Top-level notebook folder name. */
  notebook: string;
  onClose: () => void;
}

/**
 * "Share notebook…": names and shares an unshared notebook with live
 * progress, then manages members and invitations. Opening it on a notebook
 * that is already shared goes straight to the management view.
 */
export function ShareNotebookDialog({ notebook, onClose }: ShareNotebookDialogProps) {
  const { projectForNotebook } = useCollabProjects();
  const [justShared, setJustShared] = useState<LocalProject | null>(null);
  const project = projectForNotebook(notebook) ?? justShared;

  return (
    <ModalDialog
      open
      panelClassName="max-w-xl"
      sectioned
      title={project ? `Share “${project.name}”` : "Share notebook"}
      description={
        project
          ? project.revoked
            ? "This notebook is no longer shared with you."
            : `${ROLE_LABEL[project.role]} · ${project.notebook}`
          : "Invite people to edit this notebook with you in real time."
      }
      onClose={onClose}
      footer={
        <button className={SECONDARY_BUTTON} type="button" onClick={onClose}>
          {project ? "Done" : "Cancel"}
        </button>
      }
    >
      {project ? <ManageProject project={project} onLeft={onClose} /> : <ShareStep notebook={notebook} onShared={setJustShared} />}
    </ModalDialog>
  );
}

function ShareStep({ notebook, onShared }: { notebook: string; onShared: (project: LocalProject) => void }) {
  const id = useId();
  const { status } = useCollabStatus();
  const { refresh } = useCollabProjects();
  const [name, setName] = useState(notebook);
  const [sharing, setSharing] = useState(false);
  const [progress, setProgress] = useState<ShareProgress | null>(null);
  const [error, setError] = useState("");

  useHostEvents("share-progress", (event) => {
    if (event.notebook === notebook) setProgress(event.progress);
  });

  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSharing(true);
    setError("");
    setProgress(null);
    try {
      const result = await collabClient.share({ notebook, name: name.trim() && name.trim() !== notebook ? name.trim() : undefined });
      await refresh();
      if (result && typeof result === "object" && "projectId" in result) {
        onShared(result);
      }
      // Otherwise the refreshed project list carries the new project and the
      // dialog switches to the management view by itself.
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSharing(false);
    }
  }

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <form className="libera-dialog-section space-y-3" onSubmit={share}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor={`${id}-name`}>
          Name collaborators see
        </label>
        <input autoFocus className={FIELD} disabled={sharing} id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Libera uploads this notebook’s notes, LaTeX files and images to {status?.account?.serverUrl ?? "your collaboration server"}. Your
        folder stays where it is and keeps working offline; people you invite get their own synced copy.
      </p>
      {sharing || progress ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{progress ? shareProgressLabel(progress) : "Starting…"}</span>
            {percent !== null ? <span>{percent}%</span> : null}
          </div>
          <div
            aria-label="Sharing progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={progress ? shareProgressLabel(progress) : "Starting"}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${percent ?? (sharing ? 8 : 100)}%` }} />
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button className={PRIMARY_BUTTON} disabled={sharing} type="submit">
        {sharing ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Users aria-hidden className="h-3.5 w-3.5" />}
        {sharing ? "Sharing…" : "Share"}
      </button>
    </form>
  );
}

/** Members, plus pending invitations for those who may see them (owners). */
async function fetchAccess(projectId: string, withInvitations: boolean): Promise<{ members: Member[]; invitations: Invitation[] } | { error: string }> {
  try {
    const [members, invitations] = await Promise.all([
      collabClient.members(projectId),
      withInvitations ? collabClient.invitations(projectId) : Promise.resolve<Invitation[]>([]),
    ]);
    return { members, invitations };
  } catch (caught) {
    return { error: describeError(caught) };
  }
}

function ManageProject({ project, onLeft }: { project: LocalProject; onLeft: () => void }) {
  const { status } = useCollabStatus();
  const { refresh: refreshProjects } = useCollabProjects();
  const myId = status?.account?.id;
  const canInvite = !project.revoked && can(project.role, "invite");
  const canChangeRoles = !project.revoked && can(project.role, "change-roles");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");

  const applyResult = useCallback((result: Awaited<ReturnType<typeof fetchAccess>>) => {
    if ("error" in result) {
      setLoadError(result.error);
      return;
    }
    setMembers(result.members);
    setInvitations(result.invitations.filter((invitation) => !invitation.acceptedAt));
    setLoadError("");
  }, []);

  const load = useCallback(() => fetchAccess(project.projectId, canInvite).then(applyResult), [applyResult, canInvite, project.projectId]);

  useEffect(() => {
    if (project.revoked) return;
    let live = true;
    void fetchAccess(project.projectId, canInvite).then((result) => {
      if (live) applyResult(result);
    });
    return () => {
      live = false;
    };
  }, [applyResult, canInvite, project.projectId, project.revoked]);

  useHostEvents("project-changed", (event) => {
    if (event.projectId === project.projectId && !project.revoked) void load();
  });

  async function run(action: () => Promise<unknown>) {
    setActionError("");
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setActionError(describeError(caught));
      return false;
    }
  }

  if (project.revoked) {
    return (
      <div className="libera-collab-tone flex items-start gap-2 rounded-lg px-3 py-2 text-sm" data-tone="danger" role="status">
        <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Your access was removed. The folder “{project.notebook}” stays on this device as a read-only copy; nothing was deleted. Export
          anything you need from it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canInvite ? (
        <InviteSection
          projectId={project.projectId}
          onInvited={(invitation) => setInvitations((current) => [invitation, ...current.filter((item) => item.id !== invitation.id)])}
        />
      ) : null}

      {loadError ? (
        <div className="libera-dialog-section space-y-2 text-sm" role="alert">
          <p className="text-destructive">{loadError}</p>
          <button className={SMALL_BUTTON} type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="px-1 text-sm text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}

      {canInvite && invitations.length ? (
        <section aria-labelledby="collab-pending-invitations" className="libera-dialog-section space-y-2">
          <h3 className="text-sm font-medium" id="collab-pending-invitations">
            Pending invitations
          </h3>
          <ul className="divide-y divide-border">
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                onRevoke={() => run(() => collabClient.revokeInvitation(project.projectId, invitation.id))}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="collab-members" className="libera-dialog-section space-y-2">
        <h3 className="text-sm font-medium" id="collab-members">
          People with access
        </h3>
        {members === null && !loadError ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading members…
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(members ?? []).map((member) => (
              <MemberRow
                key={member.id}
                editable={canChangeRoles && member.role !== "owner" && member.id !== myId}
                isMe={member.id === myId}
                member={member}
                onChangeRole={(role) => run(() => collabClient.changeRole(project.projectId, member.id, role))}
                onRemove={() => run(() => collabClient.removeMember(project.projectId, member.id))}
              />
            ))}
          </ul>
        )}
      </section>

      {project.role !== "owner" ? (
        <LeaveSection
          name={project.name}
          onLeave={async () => {
            setActionError("");
            try {
              await collabClient.leave(project.projectId);
              await refreshProjects();
              onLeft();
            } catch (caught) {
              setActionError(describeError(caught));
            }
          }}
        />
      ) : null}
    </div>
  );
}

function InviteSection({ projectId, onInvited }: { projectId: string; onInvited: (invitation: Invitation) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Invitation | null>(null);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Enter an email address.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const invitation = await collabClient.invite(projectId, { email: address, role });
      setCreated(invitation);
      setEmail("");
      onInvited(invitation);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label="Invite people" className="libera-dialog-section space-y-3" noValidate onSubmit={invite}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor={`${id}-email`}>
          Invite by email
        </label>
        <input
          autoComplete="off"
          className={FIELD}
          id={`${id}-email`}
          placeholder="name@example.com"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-foreground">Role</legend>
        <div className="mt-1.5 space-y-1">
          {INVITABLE_ROLES.map((value) => (
            <label key={value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
              <input checked={role === value} className="mt-1" name={`${id}-role`} type="radio" value={value} onChange={() => setRole(value)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{ROLE_LABEL[value]}</span>
                <span className="block text-xs text-muted-foreground">{ROLE_DESCRIPTION[value]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button className={PRIMARY_BUTTON} disabled={submitting} type="submit">
        <UserPlus aria-hidden className="h-3.5 w-3.5" />
        {submitting ? "Inviting…" : "Invite"}
      </button>
      {created ? <InvitationLink invitation={created} /> : null}
    </form>
  );
}

function invitationLink(invitation: Invitation): string {
  return invitation.url || invitation.token || "";
}

function InvitationLink({ invitation }: { invitation: Invitation }) {
  const [copied, copy] = useCopyFeedback();
  const link = invitationLink(invitation);
  return (
    <div className="rounded-lg border border-border bg-muted/50 p-2.5 text-xs" role="status">
      <p className="mb-1.5">
        Invitation sent to <span className="font-medium">{invitation.email}</span>
        {link ? ". You can also send them this link:" : "."}
      </p>
      {link ? (
        <div className="flex items-center gap-2">
          <input aria-label="Invitation link" className="h-8 min-w-0 flex-1 rounded-md border border-input px-2 font-mono text-xs" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <button className={SMALL_BUTTON} type="button" onClick={() => void copy(link)}>
            {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function InvitationRow({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopyFeedback();
  const link = invitationLink(invitation);
  const expires = formatDate(invitation.expiresAt);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <Mail aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{invitation.email}</span>
        <span className="block text-xs text-muted-foreground">
          {ROLE_LABEL[invitation.role]}
          {expires ? ` · expires ${expires}` : ""}
        </span>
      </span>
      {confirming ? (
        <span className="flex items-center gap-1">
          <button
            className={DANGER_SMALL}
            disabled={busy}
            type="button"
            onClick={() => {
              setBusy(true);
              void onRevoke().then((ok) => {
                setBusy(false);
                if (!ok) setConfirming(false);
              });
            }}
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
          <button className={SMALL_BUTTON} type="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          {link ? (
            <button aria-label={`Copy invitation link for ${invitation.email}`} className={SMALL_BUTTON} type="button" onClick={() => void copy(link)}>
              {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </button>
          ) : null}
          <button aria-label={`Revoke invitation for ${invitation.email}`} className={SMALL_BUTTON} type="button" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            Revoke
          </button>
        </span>
      )}
    </li>
  );
}

function MemberRow({
  member,
  editable,
  isMe,
  onChangeRole,
  onRemove,
}: {
  member: Member;
  editable: boolean;
  isMe: boolean;
  onChangeRole: (role: Role) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span
        aria-hidden
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        style={{ backgroundColor: member.color, color: readableTextColor(member.color) }}
      >
        {initials(member.displayName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {member.displayName}
          {isMe ? <span className="text-muted-foreground"> (you)</span> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
      </span>
      {editable ? (
        confirming ? (
          <span className="flex items-center gap-1">
            <button
              className={DANGER_SMALL}
              disabled={busy}
              type="button"
              onClick={() => {
                setBusy(true);
                void onRemove().then((ok) => {
                  setBusy(false);
                  if (!ok) setConfirming(false);
                });
              }}
            >
              {busy ? "Removing…" : `Remove ${member.displayName}`}
            </button>
            <button className={SMALL_BUTTON} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <select
              aria-label={`Role for ${member.displayName}`}
              className="h-7 rounded-md border border-input bg-card px-1.5 text-xs"
              disabled={busy}
              title={ROLE_DESCRIPTION[member.role]}
              value={member.role}
              onChange={(event) => {
                setBusy(true);
                void onChangeRole(event.target.value as Role).then(() => setBusy(false));
              }}
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
            <button aria-label={`Remove ${member.displayName}`} className={SMALL_BUTTON} type="button" onClick={() => setConfirming(true)}>
              <UserMinus aria-hidden className="h-3.5 w-3.5" />
            </button>
          </span>
        )
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground" title={ROLE_DESCRIPTION[member.role]}>
          {ROLE_LABEL[member.role]}
        </span>
      )}
    </li>
  );
}

function LeaveSection({ name, onLeave }: { name: string; onLeave: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="Leave" className="libera-dialog-section space-y-2">
      {confirming ? (
        <>
          <p className="text-sm">
            Leave “{name}”? You lose access to the shared version. The folder stays on this device as a read-only copy.
          </p>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              disabled={busy}
              type="button"
              onClick={() => {
                setBusy(true);
                void onLeave().finally(() => setBusy(false));
              }}
            >
              {busy ? "Leaving…" : "Leave notebook"}
            </button>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(true)}>
          <LogOut aria-hidden className="h-3.5 w-3.5" /> Leave this notebook…
        </button>
      )}
    </section>
  );
}
