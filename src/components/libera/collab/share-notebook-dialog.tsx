"use client";

import { Check, Copy, LoaderCircle, LogOut, Mail, ShieldAlert, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { Invitation, LocalProject, Member, ShareProgress } from "@/lib/collab/local-api";
import { can, type Role } from "@/lib/collab/protocol/roles";
import { collabClient } from "@/lib/collab/ui/client";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import { dateTimeFormat } from "@/lib/i18n/format";
import { useCollabProjects, useCollabStatus, useHostEvents } from "@/lib/collab/ui/hooks";
import { initials, INVITABLE_ROLES, readableTextColor, roleDescription, roleLabel, shareProgressLabel } from "@/lib/collab/ui/wording";
import { ActivityLogSection } from "./activity-log";
import { useCopyFeedback } from "./collab-banners";
import "./collab.css";

const FIELD = "mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const SMALL_BUTTON =
  "inline-flex items-center justify-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
/** Words for what is shared: a notebook (the default) or a gallery album, whose editors are contributors. */
export interface ShareWording {
  noun: string;
  roleLabel: Record<Role, string>;
  roleDescription: Record<Role, string>;
  takeDown: string;
  leave: string;
}

const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];

/** The words for a shared notebook, from the messages. */
function useNotebookWording(): ShareWording {
  const t = useTranslations("collab.shareNotebookDialog");
  const tWording = useTranslations("lib.collab.ui.wording");
  return {
    noun: t("notebookNoun"),
    roleLabel: Object.fromEntries(ROLES.map((role) => [role, roleLabel(role, tWording)])) as Record<Role, string>,
    roleDescription: Object.fromEntries(ROLES.map((role) => [role, roleDescription(role, tWording)])) as Record<Role, string>,
    takeDown: t("takeDownNotebook"),
    leave: t("leaveNotebook"),
  };
}

const Wording = createContext<ShareWording | null>(null);
const useWording = () => useContext(Wording)!;

/** Members, invitations, take down and leave, for any shared project (album dialogs pass their wording). */
export function ManageSharedProject({ project, onLeft, wording }: { project: LocalProject; onLeft: () => void; wording?: ShareWording }) {
  return <ManageProject project={project} onLeft={onLeft} wording={wording} />;
}

/** "album" or "notebook", for the messages that name what is shared. */
const kindOf = (project: Pick<LocalProject, "kind">) => (project.kind === "album" ? "album" : "notebook");

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
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const tWording = useTranslations("lib.collab.ui.wording");
  const { projectForNotebook } = useCollabProjects();
  const [justShared, setJustShared] = useState<LocalProject | null>(null);
  const project = projectForNotebook(notebook) ?? justShared;

  return (
    <ModalDialog
      open
      panelClassName="max-w-xl"
      sectioned
      title={project ? t("shareTitle", { name: project.name }) : t("shareTitleNew")}
      description={
        project
          ? project.revoked
            ? project.role === "owner" ? t("noLongerShared") : t("noLongerSharedWithYou")
            : t("roleAndNotebook", { role: roleLabel(project.role, tWording, project.kind === "album"), notebook: project.notebook })
          : t("shareDescription")
      }
      onClose={onClose}
      footer={
        <button className={SECONDARY_BUTTON} type="button" onClick={onClose}>
          {project ? tCommon("done") : tCommon("cancel")}
        </button>
      }
    >
      {project ? <ManageProject project={project} onLeft={onClose} /> : <ShareStep notebook={notebook} onShared={setJustShared} />}
    </ModalDialog>
  );
}

/** The owner of a notebook shared before live PDFs existed turns them on here. */
function PdfLiveSection({ project }: { project: LocalProject }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const describeError = useDescribeError();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (project.pdfLive || project.role !== "owner" || project.kind === "album") return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t("pdfLive")}</h3>
      <p className="text-xs text-muted-foreground">{t("pdfLiveWarning")} {t("pdfLiveMembers")}</p>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {confirming ? (
        <div className="flex gap-2">
          <button
            className={SMALL_BUTTON}
            disabled={busy}
            type="button"
            onClick={() => {
              setBusy(true);
              setError("");
              collabClient.enablePdfLive(project.projectId).catch((failure: unknown) => setError(describeError(failure))).finally(() => setBusy(false));
            }}
          >
            {t("turnOnForEveryone")}
          </button>
          <button className={SMALL_BUTTON} disabled={busy} type="button" onClick={() => setConfirming(false)}>{tCommon("cancel")}</button>
        </div>
      ) : (
        <button className={SMALL_BUTTON} type="button" onClick={() => setConfirming(true)}>{t("turnOn")}</button>
      )}
    </section>
  );
}

function ShareStep({ notebook, onShared }: { notebook: string; onShared: (project: LocalProject) => void }) {
  const id = useId();
  const t = useTranslations("collab.shareNotebookDialog");
  const describeError = useDescribeError();
  const tWording = useTranslations("lib.collab.ui.wording");
  const { status } = useCollabStatus();
  const { refresh } = useCollabProjects();
  const [name, setName] = useState(notebook);
  const [pdfLive, setPdfLive] = useState(true);
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
      const result = await collabClient.share({ notebook, name: name.trim() && name.trim() !== notebook ? name.trim() : undefined, pdfLive });
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
          {t("nameCollaboratorsSee")}
        </label>
        <input autoFocus className={FIELD} disabled={sharing} id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("uploadInfo", { server: status?.account?.serverUrl ?? t("yourServer") })}
      </p>
      {sharing || progress ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{progress ? shareProgressLabel(progress, tWording) : t("starting")}</span>
            {percent !== null ? <span>{percent}%</span> : null}
          </div>
          <div
            aria-label={t("progressLabel")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={progress ? shareProgressLabel(progress, tWording) : t("starting")}
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
      <label className="flex items-start gap-2 text-sm">
        <input checked={pdfLive} className="mt-0.5" disabled={sharing} type="checkbox" onChange={(event) => setPdfLive(event.target.checked)} />
        <span>
          {t("pdfLive")}
          <span className="block text-xs text-muted-foreground">{t("pdfLiveWarning")}</span>
        </span>
      </label>
      <button className={PRIMARY_BUTTON} disabled={sharing} type="submit">
        {sharing ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Users aria-hidden className="h-3.5 w-3.5" />}
        {sharing ? t("sharing") : t("share")}
      </button>
    </form>
  );
}

/** Members, plus pending invitations for those who may see them (owners). */
async function fetchAccess(projectId: string, withInvitations: boolean, describeError: (caught: unknown) => string): Promise<{ members: Member[]; invitations: Invitation[] } | { error: string }> {
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

function ManageProject({ project, onLeft, wording: given }: { project: LocalProject; onLeft: () => void; wording?: ShareWording }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const describeError = useDescribeError();
  const notebookWording = useNotebookWording();
  const wording = given ?? notebookWording;
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

  const load = useCallback(() => fetchAccess(project.projectId, canInvite, describeError).then(applyResult), [applyResult, canInvite, project.projectId, describeError]);

  useEffect(() => {
    if (project.revoked) return;
    let live = true;
    void fetchAccess(project.projectId, canInvite, describeError).then((result) => {
      if (live) applyResult(result);
    });
    return () => {
      live = false;
    };
  }, [applyResult, canInvite, project.projectId, project.revoked, describeError]);

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

  async function takeDown() {
    setActionError("");
    try {
      await collabClient.deleteProject(project.projectId);
      await refreshProjects();
      onLeft();
    } catch (caught) {
      setActionError(describeError(caught));
    }
  }

  if (project.revoked) {
    return (
      <Wording.Provider value={wording}>
      <div className="space-y-4">
        <div className="libera-collab-tone flex items-start gap-2 rounded-lg px-3 py-2 text-sm" data-tone="danger" role="status">
          <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {project.role === "owner" ? (
              t("revokedOwner", { notebook: project.notebook })
            ) : (
              t("revokedMember", { notebook: project.notebook })
            )}
          </p>
        </div>
        {actionError ? <p className="text-sm text-destructive" role="alert">{actionError}</p> : null}
        {project.role === "owner" ? <TakeDownSection name={project.name} kind={kindOf(project)} onTakeDown={takeDown} /> : null}
      </div>
      </Wording.Provider>
    );
  }

  return (
    <Wording.Provider value={wording}>
    <div className="space-y-4">
      <PdfLiveSection project={project} />
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
            {tCommon("tryAgain")}
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
            {t("pendingInvitations")}
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
          {t("peopleWithAccess")}
        </h3>
        {members === null && !loadError ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> {t("loadingMembers")}
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

      {!project.revoked && can(project.role, "view-audit") ? <ActivityLogSection projectId={project.projectId} members={members} /> : null}

      {project.role === "owner" ? (
        <TakeDownSection name={project.name} kind={kindOf(project)} onTakeDown={takeDown} />
      ) : (
        <LeaveSection
          name={project.name}
          kind={kindOf(project)}
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
      )}
    </div>
    </Wording.Provider>
  );
}

function InviteSection({ projectId, onInvited }: { projectId: string; onInvited: (invitation: Invitation) => void }) {
  const id = useId();
  const t = useTranslations("collab.shareNotebookDialog");
  const describeError = useDescribeError();

  const [email, setEmail] = useState("");
  const wording = useWording();
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Invitation | null>(null);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError(t("enterEmail"));
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
    <form aria-label={t("invitePeople")} className="libera-dialog-section space-y-3" noValidate onSubmit={invite}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor={`${id}-email`}>
          {t("inviteByEmail")}
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
        <legend className="text-sm font-medium text-foreground">{t("role")}</legend>
        <div className="mt-1.5 space-y-1">
          {INVITABLE_ROLES.map((value) => (
            <label key={value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
              <input checked={role === value} className="mt-1" name={`${id}-role`} type="radio" value={value} onChange={() => setRole(value)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{wording.roleLabel[value]}</span>
                <span className="block text-xs text-muted-foreground">{wording.roleDescription[value]}</span>
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
        {submitting ? t("inviting") : t("invite")}
      </button>
      {created ? <InvitationLink invitation={created} /> : null}
    </form>
  );
}

function invitationLink(invitation: Invitation): string {
  return invitation.url || invitation.token || "";
}

function InvitationLink({ invitation }: { invitation: Invitation }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const [copied, copy] = useCopyFeedback();
  const link = invitationLink(invitation);
  return (
    <div className="rounded-lg border border-border bg-muted/50 p-2.5 text-xs" role="status">
      <p className="mb-1.5">
        {t.rich("invitationSent", { email: invitation.email, hasLink: link ? "yes" : "no", strong: (chunks) => <span className="font-medium">{chunks}</span> })}
      </p>
      {link ? (
        <div className="flex items-center gap-2">
          <input aria-label={t("invitationLink")} className="h-8 min-w-0 flex-1 rounded-md border border-input px-2 font-mono text-xs" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <button className={SMALL_BUTTON} type="button" onClick={() => void copy(link)}>
            {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            {copied ? tCommon("copied") : t("copyLink")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}

function InvitationRow({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => Promise<boolean> }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const wording = useWording();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopyFeedback();
  const link = invitationLink(invitation);
  const expires = formatDate(invitation.expiresAt, locale);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <Mail aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{invitation.email}</span>
        <span className="block text-xs text-muted-foreground">
          {t("roleExpires", { role: wording.roleLabel[invitation.role], hasExpiry: expires ? "yes" : "no", date: expires })}
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
            {busy ? t("revoking") : t("revoke")}
          </button>
          <button className={SMALL_BUTTON} type="button" onClick={() => setConfirming(false)}>
            {t("keep")}
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          {link ? (
            <button aria-label={t("copyInvitationFor", { email: invitation.email })} className={SMALL_BUTTON} type="button" onClick={() => void copy(link)}>
              {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
              {copied ? tCommon("copied") : t("copyLink")}
            </button>
          ) : null}
          <button aria-label={t("revokeInvitationFor", { email: invitation.email })} className={SMALL_BUTTON} type="button" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            {t("revoke")}
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
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const wording = useWording();
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
          {isMe ? <span className="text-muted-foreground"> {t("you")}</span> : null}
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
              {busy ? t("removing") : t("removeMember", { name: member.displayName })}
            </button>
            <button className={SMALL_BUTTON} type="button" onClick={() => setConfirming(false)}>
              {tCommon("cancel")}
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <select
              aria-label={t("roleFor", { name: member.displayName })}
              className="h-7 rounded-md border border-input bg-card px-1.5 text-xs"
              disabled={busy}
              title={wording.roleDescription[member.role]}
              value={member.role}
              onChange={(event) => {
                setBusy(true);
                void onChangeRole(event.target.value as Role).then(() => setBusy(false));
              }}
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {wording.roleLabel[role]}
                </option>
              ))}
            </select>
            <button aria-label={t("removeMember", { name: member.displayName })} className={SMALL_BUTTON} type="button" onClick={() => setConfirming(true)}>
              <UserMinus aria-hidden className="h-3.5 w-3.5" />
            </button>
          </span>
        )
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground" title={wording.roleDescription[member.role]}>
          {wording.roleLabel[member.role]}
        </span>
      )}
    </li>
  );
}

function TakeDownSection({ name, kind, onTakeDown }: { name: string; kind: string; onTakeDown: () => Promise<void> }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const wording = useWording();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label={t("takeDownKind", { kind })} className="libera-dialog-section space-y-2">
      {confirming ? (
        <>
          <p className="text-sm">
            {t("takeDownConfirm", { name })} {wording.takeDown}
          </p>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              disabled={busy}
              type="button"
              onClick={() => {
                setBusy(true);
                void onTakeDown().finally(() => setBusy(false));
              }}
            >
              {busy ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Trash2 aria-hidden className="h-3.5 w-3.5" />}
              {busy ? t("takingDown") : t("takeDownKind", { kind })}
            </button>
            <button className={SECONDARY_BUTTON} disabled={busy} type="button" onClick={() => setConfirming(false)}>
              {tCommon("cancel")}
            </button>
          </div>
        </>
      ) : (
        <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(true)}>
          <Trash2 aria-hidden className="h-3.5 w-3.5" /> {t("takeDownKindOpen", { kind })}
        </button>
      )}
    </section>
  );
}

function LeaveSection({ name, kind, onLeave }: { name: string; kind: string; onLeave: () => Promise<void> }) {
  const t = useTranslations("collab.shareNotebookDialog");
  const tCommon = useTranslations("common");
  const wording = useWording();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label={t("leaveSection")} className="libera-dialog-section space-y-2">
      {confirming ? (
        <>
          <p className="text-sm">
            {t("leaveConfirm", { name })} {wording.leave}
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
              {busy ? t("leaving") : t("leaveKind", { kind })}
            </button>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(false)}>
              {tCommon("cancel")}
            </button>
          </div>
        </>
      ) : (
        <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(true)}>
          <LogOut aria-hidden className="h-3.5 w-3.5" /> {t("leaveKindOpen", { kind })}
        </button>
      )}
    </section>
  );
}
