"use client";

// Shared albums in the gallery: the Share dialog (an album, or one photo),
// the owner's privacy settings, and a shared photo's details in the viewer
// (caption, who added it, comments, also on part of the photo).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, LoaderCircle, MapPinOff, MessageSquare, MessageSquarePlus, Plus, SquareDashedMousePointer, Users, X } from "lucide-react";
import { applyGallery, refreshGallery } from "@/components/libera/gallery-store";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { apiRequest } from "@/components/libera/api-client";
import { ManageSharedProject, type ShareWording } from "@/components/libera/collab/share-notebook-dialog";
import { useCollabShell } from "@/components/libera/collab/collab-provider";
import type { PhotoOverlay } from "@/components/libera/photo-viewer";
import { parsePhotoAnchor, photoAnchorId, type PhotoRegion } from "@/lib/collab/album-comments";
import type { LocalProject, UpdateAlbumRequest } from "@/lib/collab/local-api";
import type { Member, Thread } from "@/lib/collab/protocol/api";
import { EventKind } from "@/lib/collab/protocol/messages";
import type { Role } from "@/lib/collab/protocol/roles";
import { collabClient, describeError } from "@/lib/collab/ui/client";
import { useCollabProjects, useCollabStatus, useHostEvents } from "@/lib/collab/ui/hooks";
import { INVITABLE_ROLES } from "@/lib/collab/ui/wording";
import { relativeTimeLabel } from "@/lib/relative-time";
import {
  canChangeSharedPhotos,
  canCommentOnSharedPhotos,
  type GalleryAlbum,
  type GalleryContents,
  type GalleryPhoto,
  type GalleryPhotoSharing,
} from "@/lib/image-generation";

const FIELD = "h-9 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring";
const SECONDARY = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
const PRIMARY = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50";

/** Role names and what each role may do, for a shared album (an album's editors are contributors). */
function useAlbumRoles() {
  const t = useTranslations("gallerySharing");
  return useMemo(() => ({
    label: { owner: t("role.owner"), editor: t("role.editor"), commenter: t("role.commenter"), viewer: t("role.viewer") } as Record<Role, string>,
    description: { owner: t("roleDescription.owner"), editor: t("roleDescription.editor"), commenter: t("roleDescription.commenter"), viewer: t("roleDescription.viewer") } as Record<Role, string>,
  }), [t]);
}

/** The words the member manager uses for an album. */
function useAlbumWording(): ShareWording {
  const t = useTranslations("gallerySharing");
  const roles = useAlbumRoles();
  return useMemo(() => ({
    noun: t("albumNoun"),
    roleLabel: roles.label,
    roleDescription: roles.description,
    takeDown: t("takeDownAlbum"),
    leave: t("leaveAlbum"),
  }), [roles, t]);
}

type Invite = { email: string; role: Exclude<Role, "owner"> };
type ShareResult = { projectId: string; invited: string[]; failed: Array<{ email: string; error: string }>; gallery: GalleryContents };

/** Who to show a project as in the member list: the album, as the host knows it. */
function albumProject(album: GalleryAlbum, known: LocalProject | undefined): LocalProject | null {
  if (!album.shared) return null;
  return known ?? { projectId: album.shared.projectId, name: album.name, role: album.shared.role, notebook: album.folder, revoked: false, reconcilePending: 0, kind: "album" };
}

/**
 * "Share…" for an album, or for one photo (which becomes an album of its
 * own). Once shared, the same dialog manages members, invitations and the
 * owner's privacy settings.
 */
export function ShareGalleryDialog({ album, photo, albums, onClose }: { album?: GalleryAlbum; photo?: GalleryPhoto; albums: GalleryAlbum[]; onClose: () => void }) {
  const t = useTranslations("gallerySharing");
  const tCommon = useTranslations("common");
  const roles = useAlbumRoles();
  const wording = useAlbumWording();
  const collab = useCollabStatus();
  const shell = useCollabShell();
  const { projectById, refresh } = useCollabProjects();
  const [sharedProjectId, setSharedProjectId] = useState<string | null>(album?.shared?.projectId ?? null);
  const current = sharedProjectId ? albums.find((entry) => entry.shared?.projectId === sharedProjectId) : undefined;
  const project = current ? albumProject(current, projectById(sharedProjectId)) : null;
  const title = project ? t("sharedAlbumTitle", { name: project.name }) : photo ? t("sharePhoto") : t("sharedAlbumTitle", { name: album?.name ?? "" });

  return (
    <ModalDialog open panelClassName="max-w-xl" sectioned title={title}
      description={project
        ? t("descriptionProjectRole", { role: roles.label[project.role], notebook: project.notebook })
        : photo ? t("descriptionPhoto") : t("descriptionAlbum")}
      onClose={onClose}
      footer={<button className={SECONDARY} type="button" onClick={onClose}>{project ? tCommon("done") : tCommon("cancel")}</button>}>
      {!collab.enabled ? <p className="libera-dialog-section text-sm text-muted-foreground">{t("sharingUnavailable")}</p>
        : !collab.signedIn ? <div className="libera-dialog-section space-y-3 text-sm">
          <p>{t("signInToShare", { isPhoto: photo ? "yes" : "no" })}</p>
          {shell && <button className={PRIMARY} type="button" onClick={() => { onClose(); shell.openAccount(); }}><Users className="h-3.5 w-3.5" />{t("signIn")}</button>}
        </div>
        : project && current ? <>
          {project.role === "owner" && current.shared && <AlbumPrivacySection album={current} />}
          <ManageSharedProject project={project} wording={wording} onLeft={() => { void refreshGallery(); onClose(); }} />
        </>
        : <ShareForm album={album} photo={photo} onShared={async (result) => {
          applyGallery(result.gallery);
          await refresh();
          setSharedProjectId(result.projectId);
        }} />}
    </ModalDialog>
  );
}

function ShareForm({ album, photo, onShared }: { album?: GalleryAlbum; photo?: GalleryPhoto; onShared: (result: ShareResult) => Promise<void> }) {
  const t = useTranslations("gallerySharing");
  const roles = useAlbumRoles();
  const id = useId();
  const [name, setName] = useState(album?.name ?? photo?.name.replace(/\.[^.]+$/, "") ?? "");
  const [invites, setInvites] = useState<Invite[]>([{ email: "", role: photo ? "viewer" : "editor" }]);
  const [removeLocation, setRemoveLocation] = useState(true);
  const [sharePrompts, setSharePrompts] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<ShareResult["failed"]>([]);
  const hasPrompts = photo ? Boolean(photo.prompt) : true;

  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invitations = invites.map((invite) => ({ ...invite, email: invite.email.trim() })).filter((invite) => invite.email);
    const wrong = invitations.find((invite) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.email));
    if (wrong) return setError(t("notEmailAddress", { email: wrong.email }));
    setSharing(true);
    setError("");
    try {
      const body = { name: name.trim(), keepLocation: !removeLocation, sharePrompts, invitations };
      const result = photo
        ? await apiRequest<ShareResult>("/api/gallery/photos/share", { method: "POST", body: JSON.stringify({ ...body, photoId: photo.id }) })
        : await apiRequest<ShareResult>("/api/gallery/albums/share", { method: "POST", body: JSON.stringify({ ...body, albumId: album?.id }) });
      setFailed(result.failed);
      await onShared(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : describeError(caught));
    } finally {
      setSharing(false);
    }
  }

  return <form className="libera-dialog-section space-y-4" onSubmit={share}>
    <div>
      <label className="block text-sm font-medium" htmlFor={`${id}-name`}>{t("nameMembersSee")}</label>
      <input id={`${id}-name`} className={`${FIELD} mt-1`} maxLength={200} value={name} disabled={sharing} onChange={(event) => setName(event.target.value)} />
    </div>
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("invitePeople")}</legend>
      {invites.map((invite, index) => <div key={index} className="flex items-center gap-2">
        <input aria-label={t("emailLabel", { number: index + 1 })} className={FIELD} type="email" placeholder={t("emailPlaceholder")} autoComplete="off" value={invite.email} disabled={sharing}
          onChange={(event) => setInvites((current) => current.map((item, at) => (at === index ? { ...item, email: event.target.value } : item)))} />
        <select aria-label={invite.email ? t("roleForEmail", { email: invite.email }) : t("roleForPerson", { number: index + 1 })} className="h-9 rounded-lg border border-input bg-card px-2 text-sm" value={invite.role} disabled={sharing}
          title={roles.description[invite.role]}
          onChange={(event) => setInvites((current) => current.map((item, at) => (at === index ? { ...item, role: event.target.value as Invite["role"] } : item)))}>
          {INVITABLE_ROLES.filter((role) => !photo || role !== "editor").map((role) => <option key={role} value={role}>{roles.label[role]}</option>)}
        </select>
        {invites.length > 1 && <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted" aria-label={t("removePerson")}
          onClick={() => setInvites((current) => current.filter((_, at) => at !== index))}><X className="h-4 w-4" /></button>}
      </div>)}
      <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" disabled={sharing}
        onClick={() => setInvites((current) => [...current, { email: "", role: current.at(-1)?.role ?? "viewer" }])}><Plus className="h-3.5 w-3.5" />{t("addSomeone")}</button>
      <p className="text-xs text-muted-foreground">{t("invitePeopleLater", { isPhoto: photo ? "yes" : "no" })}</p>
    </fieldset>
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("privacy")}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={removeLocation} disabled={sharing} onChange={(event) => setRemoveLocation(event.target.checked)} />
        <span><span className="block">{t("removeLocation")}</span><span className="block text-xs text-muted-foreground">{t("removeLocationHelp", { isPhoto: photo ? "yes" : "no" })}</span></span>
      </label>
      {hasPrompts && <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={sharePrompts} disabled={sharing} onChange={(event) => setSharePrompts(event.target.checked)} />
        <span><span className="block">{t("shareImagePrompts")}</span><span className="block text-xs text-muted-foreground">{t("sharePromptsHelp")}</span></span>
      </label>}
      <p className="text-xs text-muted-foreground">{t("staysOnDevice")}</p>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {failed.length > 0 && <p role="alert" className="text-sm text-destructive">{t("notInvited", { list: failed.map((item) => `${item.email} (${item.error})`).join("; ") })}</p>}
    <button className={PRIMARY} type="submit" disabled={sharing || !name.trim()}>
      {sharing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}{sharing ? t("sharing") : t("share")}
    </button>
  </form>;
}

async function updateAlbum(projectId: string, request: UpdateAlbumRequest) {
  await collabClient.request("POST", `/albums/${encodeURIComponent(projectId)}`, request);
  await refreshGallery();
}

/** The owner decides whether new photos keep their location, and whether prompts are shared. */
function AlbumPrivacySection({ album }: { album: GalleryAlbum }) {
  const t = useTranslations("gallerySharing");
  const sharing = album.shared!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(request: UpdateAlbumRequest) {
    setBusy(true);
    setError("");
    try { await updateAlbum(sharing.projectId, request); }
    catch (caught) { setError(describeError(caught)); }
    finally { setBusy(false); }
  }
  return <section aria-label={t("privacy")} className="libera-dialog-section space-y-2">
    <h3 className="text-sm font-medium">{t("privacy")}</h3>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={!sharing.keepLocation} disabled={busy} onChange={(event) => void change({ keepLocation: !event.target.checked })} />
      <span><span className="block">{t("removeLocationNew")}</span><span className="block text-xs text-muted-foreground">{t("alreadyInAlbum")}</span></span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={sharing.sharePrompts} disabled={busy} onChange={(event) => void change({ sharePrompts: event.target.checked })} />
      <span><span className="block">{t("shareImagePrompts")}</span><span className="block text-xs text-muted-foreground">{t("sharePromptsAlbumHelp")}</span></span>
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

// ------------------------------------------------------------ members' names

const memberCache = new Map<string, Promise<Member[]>>();

/** The members of a shared album (for "added by" and comment authors), loaded once per album. */
function useMembers(projectId: string) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let live = true;
    void loadMembers(projectId).then((loaded) => { if (live) setMembers(loaded); });
    return () => { live = false; };
  }, [projectId]);
  return useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
}

function loadMembers(projectId: string) {
  let request = memberCache.get(projectId);
  if (!request) {
    request = collabClient.members(projectId).catch(() => [] as Member[]);
    memberCache.set(projectId, request);
  }
  return request;
}

/** The members of several shared albums, by account id (the gallery's contributor filter). */
export function useAlbumMembers(projectIds: string[]) {
  const [members, setMembers] = useState<Map<string, Member>>(() => new Map());
  const key = [...projectIds].sort().join("\n");
  useEffect(() => {
    let live = true;
    const ids = key ? key.split("\n") : [];
    void Promise.all(ids.map(loadMembers)).then((lists) => {
      if (live) setMembers(new Map(lists.flat().map((member) => [member.id, member])));
    });
    return () => { live = false; };
  }, [key]);
  return members;
}

// ------------------------------------------------------------ a shared photo in the viewer

const commentId = () => `thr_${crypto.randomUUID().replace(/-/g, "")}`;
const messageId = () => `msg_${crypto.randomUUID().replace(/-/g, "")}`;

/** Comment threads on one photo, kept current by the server's thread events. */
function usePhotoThreads(sharing: GalleryPhotoSharing) {
  // Answers are kept with the photo they are for, so another photo's never show.
  const key = `${sharing.manifestDocId}:${sharing.fileId}`;
  const [loaded, setLoaded] = useState<{ key: string; threads: Thread[] | null; error: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const all = await collabClient.request<Thread[]>("GET", `/docs/${encodeURIComponent(sharing.manifestDocId)}/threads`);
      setLoaded({ key, threads: all.filter((thread) => parsePhotoAnchor(thread.anchorId).fileId === sharing.fileId), error: "" });
    } catch (caught) {
      setLoaded((current) => ({ key, threads: current?.key === key ? current.threads : null, error: describeError(caught) }));
    }
  }, [key, sharing.fileId, sharing.manifestDocId]);
  useEffect(() => { void load(); }, [load]);
  const threads = loaded?.key === key ? loaded.threads : null;
  const error = loaded?.key === key ? loaded.error : "";
  useHostEvents("server-event", (event) => {
    if (event.kind !== EventKind.ThreadChanged && event.kind !== EventKind.ThreadDeleted) return;
    const thread = (event.payload as { thread?: Thread } | null)?.thread;
    if (thread?.docId === sharing.manifestDocId) void load();
  });
  return { threads, error, reload: load };
}

/**
 * A shared album photo's caption, who added it, and its comments. Comments
 * can point at part of the photo: the viewer draws those areas over it.
 * Keyed by photo, so what is being written starts over on the next one.
 */
export function SharedPhotoDetails(props: Parameters<typeof PhotoDetails>[0]) {
  return <PhotoDetails key={`${props.photo.id}:${props.focusThreadId ?? ""}`} {...props} />;
}

function PhotoDetails({ photo, album, setOverlay, focusThreadId }: {
  photo: GalleryPhoto;
  album: GalleryAlbum | undefined;
  setOverlay: (overlay: PhotoOverlay | null) => void;
  /** A notification opened this comment. */
  focusThreadId?: string;
}) {
  const t = useTranslations("gallerySharing");
  const roles = useAlbumRoles();
  const sharing = photo.shared!;
  const members = useMembers(sharing.projectId);
  const canChange = canChangeSharedPhotos(sharing);
  const canComment = canCommentOnSharedPhotos(sharing) && Boolean(sharing.fileId);
  const { threads, error: loadError, reload } = usePhotoThreads(sharing);
  /** The caption being edited; the album's caption otherwise. */
  const [editingCaption, setEditingCaption] = useState<string | null>(null);
  const caption = editingCaption ?? sharing.caption ?? "";
  const [savingCaption, setSavingCaption] = useState(false);
  const [now] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [region, setRegion] = useState<PhotoRegion | null>(null);
  const [picking, setPicking] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(focusThreadId ?? null);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState("");

  const visible = useMemo(() => (threads ?? []).filter((thread) => showResolved || thread.status !== "resolved"), [showResolved, threads]);
  const resolvedCount = (threads ?? []).filter((thread) => thread.status === "resolved").length;

  // Areas of the comments shown, plus the one being written, drawn over the photo.
  useEffect(() => {
    const regions = visible.flatMap((thread) => {
      const parsed = parsePhotoAnchor(thread.anchorId).region;
      return parsed ? [{ id: thread.id, region: parsed, active: thread.id === activeThread }] : [];
    });
    if (region) regions.push({ id: "draft", region, active: true });
    setOverlay({
      regions,
      ...(picking ? { onPick: (picked: PhotoRegion | null) => { setRegion(picked); setPicking(false); } } : {}),
    });
  }, [activeThread, picking, region, setOverlay, visible]);
  useEffect(() => () => setOverlay(null), [setOverlay]);

  async function saveCaption() {
    if (editingCaption === null) return;
    if (editingCaption.trim() === (sharing.caption ?? "").trim()) return setEditingCaption(null);
    setSavingCaption(true);
    setError("");
    try {
      await updateAlbum(sharing.projectId, { photos: [{ name: photo.name, caption: editingCaption.trim() || null }] });
      setEditingCaption(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSavingCaption(false);
    }
  }

  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !sharing.fileId) return;
    setError("");
    try {
      const id = commentId();
      await collabClient.request("POST", `/docs/${encodeURIComponent(sharing.manifestDocId)}/threads`, { id, anchorId: photoAnchorId(sharing.fileId, region), quote: photo.name, body });
      setDraft("");
      setRegion(null);
      setActiveThread(id);
      await reload();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  async function act(action: () => Promise<unknown>) {
    setError("");
    try { await action(); await reload(); }
    catch (caught) { setError(describeError(caught)); }
  }

  const addedBy = sharing.addedBy ? members.get(sharing.addedBy)?.displayName : undefined;
  const label = "text-xs uppercase tracking-wider text-white/50";

  return <section aria-label={t("sharedAlbum")} className="space-y-4 border-t border-white/10 pt-4 text-sm">
    <div>
      <p className={label}>{t("sharedAlbum")}</p>
      <p className="mt-0.5 flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-white/60" />{album?.name ?? t("sharedAlbum")}<span className="text-white/50">{t("roleSeparator", { role: roles.label[sharing.role] })}</span></p>
      {addedBy && <p className="mt-0.5 text-xs text-white/60">{t("addedByName", { name: addedBy })}</p>}
      {album?.shared && !album.shared.keepLocation && <p className="mt-0.5 flex items-center gap-1 text-xs text-white/50"><MapPinOff className="h-3 w-3" />{t("locationRemoved")}</p>}
    </div>
    <div>
      <label className={label} htmlFor={`caption-${photo.id}`}>{t("caption")}</label>
      {canChange
        ? <textarea id={`caption-${photo.id}`} rows={2} maxLength={2000} placeholder={t("captionPlaceholder")} value={caption}
          className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:border-white/40"
          onChange={(event) => setEditingCaption(event.target.value)} onBlur={() => void saveCaption()}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }} />
        : <p id={`caption-${photo.id}`} className="mt-1 whitespace-pre-wrap text-white/85">{sharing.caption || <span className="text-white/50">{t("noCaption")}</span>}</p>}
      {savingCaption && <p className="mt-1 text-xs text-white/50">{t("savingCaption")}</p>}
    </div>
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`${label} mr-auto flex items-center gap-1`}><MessageSquare className="h-3 w-3" />{t("comments")}</p>
        {resolvedCount > 0 && <button type="button" className="text-xs text-white/60 hover:text-white" onClick={() => setShowResolved((value) => !value)}>{showResolved ? t("hideResolved") : t("showResolved", { count: resolvedCount })}</button>}
      </div>
      {threads === null && !loadError && <p className="flex items-center gap-2 text-xs text-white/50"><LoaderCircle className="h-3 w-3 animate-spin" />{t("loadingComments")}</p>}
      {loadError && <p role="alert" className="text-xs text-red-300">{loadError}</p>}
      {threads !== null && !visible.length && <p className="text-xs text-white/50">{canComment ? t("noCommentsYet") : t("noComments")}</p>}
      <ul className="space-y-2">
        {visible.map((thread) => <PhotoThread key={thread.id} thread={thread} now={now} active={thread.id === activeThread} canComment={canComment}
          canResolve={canComment} onFocus={() => setActiveThread((current) => (current === thread.id ? null : thread.id))}
          onReply={(body) => act(() => collabClient.request("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { id: messageId(), body }))}
          onStatus={(status) => act(() => collabClient.request("POST", `/threads/${encodeURIComponent(thread.id)}/status`, { status }))} />)}
      </ul>
      {canComment && <form className="space-y-1.5" onSubmit={comment}>
        <textarea aria-label={t("commentOnPhoto")} rows={2} maxLength={10_000} placeholder={region ? t("commentOnArea") : t("commentOnPhoto")} value={draft}
          className="w-full resize-y rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:border-white/40"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" aria-pressed={picking || Boolean(region)} title={t("pointAtPart")}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${picking || region ? "border-amber-300/70 text-amber-200" : "border-white/20 text-white/80 hover:bg-white/10"}`}
            onClick={() => { if (region) setRegion(null); else setPicking((value) => !value); }}>
            {region ? <><X className="h-3 w-3" />{t("wholePhoto")}</> : <><SquareDashedMousePointer className="h-3 w-3" />{picking ? t("dragOverPhoto") : t("markArea")}</>}
          </button>
          <button type="submit" disabled={!draft.trim()} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-black disabled:opacity-40"><MessageSquarePlus className="h-3.5 w-3.5" />{t("comment")}</button>
        </div>
      </form>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>
  </section>;
}

function PhotoThread({ thread, now, active, canComment, canResolve, onFocus, onReply, onStatus }: {
  thread: Thread;
  /** When the panel opened, for "4 min ago". */
  now: number;
  active: boolean;
  canComment: boolean;
  canResolve: boolean;
  onFocus: () => void;
  onReply: (body: string) => Promise<void>;
  onStatus: (status: "open" | "resolved") => Promise<void>;
}) {
  const t = useTranslations("gallerySharing");
  const locale = useLocale();
  const [reply, setReply] = useState("");
  const region = parsePhotoAnchor(thread.anchorId).region;
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const resolved = thread.status === "resolved";
  return <li className={`rounded-lg border p-2.5 ${active ? "border-amber-300/60 bg-white/10" : "border-white/10 bg-white/5"} ${resolved ? "opacity-70" : ""}`}>
    <button type="button" className="block w-full text-left" onClick={onFocus} aria-expanded={active}>
      {region && <span className="mb-1 inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/70"><SquareDashedMousePointer className="h-3 w-3" />{t("partOfPhoto")}</span>}
      {messages.slice(0, active ? undefined : 1).map((message) => <span key={message.id} className="mt-1 block first:mt-0">
        <span className="text-xs font-medium" style={{ color: message.author.color }}>{message.actor.kind === "ai" ? t("aiRequestedBy", { name: message.author.displayName }) : message.author.displayName}</span>
        <span className="ml-1.5 text-[11px] text-white/40">{relativeTimeLabel(message.createdAt, now, locale)}</span>
        <span className="block whitespace-pre-wrap text-sm text-white/90">{message.body}</span>
      </span>)}
      {!active && messages.length > 1 && <span className="mt-1 block text-[11px] text-white/50">{t("moreReplies", { count: messages.length - 1 })}</span>}
    </button>
    {active && <div className="mt-2 space-y-1.5">
      {canComment && !resolved && <form className="flex gap-1.5" onSubmit={(event) => {
        event.preventDefault();
        if (!reply.trim()) return;
        void onReply(reply.trim()).then(() => setReply(""));
      }}>
        <input aria-label={t("replyLabel")} placeholder={t("replyLabel")} value={reply} onChange={(event) => setReply(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-2 text-xs text-white placeholder:text-white/40 outline-none focus:border-white/40" />
        <button type="submit" disabled={!reply.trim()} className="rounded-md bg-white px-2 text-xs font-medium text-black disabled:opacity-40">{t("replyLabel")}</button>
      </form>}
      {canResolve && <button type="button" className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white" onClick={() => void onStatus(resolved ? "open" : "resolved")}>
        {resolved ? t("reopen") : <><Check className="h-3 w-3" />{t("resolve")}</>}
      </button>}
    </div>}
  </li>;
}
