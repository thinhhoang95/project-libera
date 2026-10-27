"use client";

// Shared albums in the gallery: the Share dialog (an album, or one photo),
// the owner's privacy settings, and a shared photo's details in the viewer
// (caption, who added it, comments, also on part of the photo).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
import { ALBUM_ROLE_DESCRIPTION, ALBUM_ROLE_LABEL, INVITABLE_ROLES, timeAgo } from "@/lib/collab/ui/wording";
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

export const ALBUM_WORDING: ShareWording = {
  noun: "album",
  roleLabel: ALBUM_ROLE_LABEL,
  roleDescription: ALBUM_ROLE_DESCRIPTION,
  takeDown:
    "This deletes the shared album and its comments from the server. Everyone loses access and invitation links stop working. Your photos stay in your gallery; members keep the photos they added and those they saved.",
  leave: "You lose access. Photos other members added leave your gallery, unless you saved them; the photos you added stay, as an album of your own.",
};

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
  const collab = useCollabStatus();
  const shell = useCollabShell();
  const { projectById, refresh } = useCollabProjects();
  const [sharedProjectId, setSharedProjectId] = useState<string | null>(album?.shared?.projectId ?? null);
  const current = sharedProjectId ? albums.find((entry) => entry.shared?.projectId === sharedProjectId) : undefined;
  const project = current ? albumProject(current, projectById(sharedProjectId)) : null;
  const subject = photo ? "photo" : "album";
  const title = project ? `Share “${project.name}”` : photo ? "Share photo" : `Share “${album?.name ?? ""}”`;

  return (
    <ModalDialog open panelClassName="max-w-xl" sectioned title={title}
      description={project
        ? `${ALBUM_ROLE_LABEL[project.role]} · gallery/${project.notebook}`
        : photo ? "Invite people to see this photo. It is shared on its own, as a copy." : "Invite people to see this album, and to add their own photos if you like."}
      onClose={onClose}
      footer={<button className={SECONDARY} type="button" onClick={onClose}>{project ? "Done" : "Cancel"}</button>}>
      {!collab.enabled ? <p className="libera-dialog-section text-sm text-muted-foreground">Sharing needs collaboration, which is not available in this Libera.</p>
        : !collab.signedIn ? <div className="libera-dialog-section space-y-3 text-sm">
          <p>Sign in to your collaboration account to share {subject === "photo" ? "photos" : "albums"}.</p>
          {shell && <button className={PRIMARY} type="button" onClick={() => { onClose(); shell.openAccount(); }}><Users className="h-3.5 w-3.5" />Sign in…</button>}
        </div>
        : project && current ? <>
          {project.role === "owner" && current.shared && <AlbumPrivacySection album={current} />}
          <ManageSharedProject project={project} wording={ALBUM_WORDING} onLeft={() => { void refreshGallery(); onClose(); }} />
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
    if (wrong) return setError(`${wrong.email} is not an email address.`);
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
      <label className="block text-sm font-medium" htmlFor={`${id}-name`}>Name members see</label>
      <input id={`${id}-name`} className={`${FIELD} mt-1`} maxLength={200} value={name} disabled={sharing} onChange={(event) => setName(event.target.value)} />
    </div>
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Invite people</legend>
      {invites.map((invite, index) => <div key={index} className="flex items-center gap-2">
        <input aria-label={`Email ${index + 1}`} className={FIELD} type="email" placeholder="name@example.com" autoComplete="off" value={invite.email} disabled={sharing}
          onChange={(event) => setInvites((current) => current.map((item, at) => (at === index ? { ...item, email: event.target.value } : item)))} />
        <select aria-label={`Role for ${invite.email || `person ${index + 1}`}`} className="h-9 rounded-lg border border-input bg-card px-2 text-sm" value={invite.role} disabled={sharing}
          title={ALBUM_ROLE_DESCRIPTION[invite.role]}
          onChange={(event) => setInvites((current) => current.map((item, at) => (at === index ? { ...item, role: event.target.value as Invite["role"] } : item)))}>
          {INVITABLE_ROLES.filter((role) => !photo || role !== "editor").map((role) => <option key={role} value={role}>{ALBUM_ROLE_LABEL[role]}</option>)}
        </select>
        {invites.length > 1 && <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted" aria-label="Remove this person"
          onClick={() => setInvites((current) => current.filter((_, at) => at !== index))}><X className="h-4 w-4" /></button>}
      </div>)}
      <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" disabled={sharing}
        onClick={() => setInvites((current) => [...current, { email: "", role: current.at(-1)?.role ?? "viewer" }])}><Plus className="h-3.5 w-3.5" />Add someone</button>
      <p className="text-xs text-muted-foreground">You can also invite people later. {photo ? "Viewers see the photo; commenters can also comment on it." : "Contributors add, remove and edit photos; commenters comment; viewers look."}</p>
    </fieldset>
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Privacy</legend>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={removeLocation} disabled={sharing} onChange={(event) => setRemoveLocation(event.target.checked)} />
        <span><span className="block">Remove location and camera details</span><span className="block text-xs text-muted-foreground">Recommended. They are removed from the {photo ? "photo" : "album’s photos"} on this device too, and from photos added later.</span></span>
      </label>
      {hasPrompts && <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={sharePrompts} disabled={sharing} onChange={(event) => setSharePrompts(event.target.checked)} />
        <span><span className="block">Share image prompts</span><span className="block text-xs text-muted-foreground">Members see the prompt and model of generated images.</span></span>
      </label>}
      <p className="text-xs text-muted-foreground">Stars, AI chats and the Protected Archive stay on this device.</p>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {failed.length > 0 && <p role="alert" className="text-sm text-destructive">Not invited: {failed.map((item) => `${item.email} (${item.error})`).join("; ")}</p>}
    <button className={PRIMARY} type="submit" disabled={sharing || !name.trim()}>
      {sharing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}{sharing ? "Sharing…" : "Share"}
    </button>
  </form>;
}

async function updateAlbum(projectId: string, request: UpdateAlbumRequest) {
  await collabClient.request("POST", `/albums/${encodeURIComponent(projectId)}`, request);
  await refreshGallery();
}

/** The owner decides whether new photos keep their location, and whether prompts are shared. */
function AlbumPrivacySection({ album }: { album: GalleryAlbum }) {
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
  return <section aria-label="Privacy" className="libera-dialog-section space-y-2">
    <h3 className="text-sm font-medium">Privacy</h3>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={!sharing.keepLocation} disabled={busy} onChange={(event) => void change({ keepLocation: !event.target.checked })} />
      <span><span className="block">Remove location and camera details from new photos</span><span className="block text-xs text-muted-foreground">Photos already in the album stay as they are.</span></span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={sharing.sharePrompts} disabled={busy} onChange={(event) => void change({ sharePrompts: event.target.checked })} />
      <span><span className="block">Share image prompts</span><span className="block text-xs text-muted-foreground">Prompts given when the album was shared or later.</span></span>
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

  return <section aria-label="Shared album" className="space-y-4 border-t border-white/10 pt-4 text-sm">
    <div>
      <p className={label}>Shared album</p>
      <p className="mt-0.5 flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-white/60" />{album?.name ?? "Shared album"}<span className="text-white/50">· {ALBUM_ROLE_LABEL[sharing.role]}</span></p>
      {addedBy && <p className="mt-0.5 text-xs text-white/60">Added by {addedBy}</p>}
      {album?.shared && !album.shared.keepLocation && <p className="mt-0.5 flex items-center gap-1 text-xs text-white/50"><MapPinOff className="h-3 w-3" />Location details removed</p>}
    </div>
    <div>
      <label className={label} htmlFor={`caption-${photo.id}`}>Caption</label>
      {canChange
        ? <textarea id={`caption-${photo.id}`} rows={2} maxLength={2000} placeholder="Add a caption everyone sees" value={caption}
          className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:border-white/40"
          onChange={(event) => setEditingCaption(event.target.value)} onBlur={() => void saveCaption()}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }} />
        : <p id={`caption-${photo.id}`} className="mt-1 whitespace-pre-wrap text-white/85">{sharing.caption || <span className="text-white/50">No caption</span>}</p>}
      {savingCaption && <p className="mt-1 text-xs text-white/50">Saving…</p>}
    </div>
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`${label} mr-auto flex items-center gap-1`}><MessageSquare className="h-3 w-3" />Comments</p>
        {resolvedCount > 0 && <button type="button" className="text-xs text-white/60 hover:text-white" onClick={() => setShowResolved((value) => !value)}>{showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}</button>}
      </div>
      {threads === null && !loadError && <p className="flex items-center gap-2 text-xs text-white/50"><LoaderCircle className="h-3 w-3 animate-spin" />Loading comments…</p>}
      {loadError && <p role="alert" className="text-xs text-red-300">{loadError}</p>}
      {threads !== null && !visible.length && <p className="text-xs text-white/50">{canComment ? "No comments yet." : "No comments."}</p>}
      <ul className="space-y-2">
        {visible.map((thread) => <PhotoThread key={thread.id} thread={thread} now={now} active={thread.id === activeThread} canComment={canComment}
          canResolve={canComment} onFocus={() => setActiveThread((current) => (current === thread.id ? null : thread.id))}
          onReply={(body) => act(() => collabClient.request("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { id: messageId(), body }))}
          onStatus={(status) => act(() => collabClient.request("POST", `/threads/${encodeURIComponent(thread.id)}/status`, { status }))} />)}
      </ul>
      {canComment && <form className="space-y-1.5" onSubmit={comment}>
        <textarea aria-label="Comment on this photo" rows={2} maxLength={10_000} placeholder={region ? "Comment on the area you marked" : "Comment on this photo"} value={draft}
          className="w-full resize-y rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:border-white/40"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" aria-pressed={picking || Boolean(region)} title="Point at part of the photo: drag over it"
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${picking || region ? "border-amber-300/70 text-amber-200" : "border-white/20 text-white/80 hover:bg-white/10"}`}
            onClick={() => { if (region) setRegion(null); else setPicking((value) => !value); }}>
            {region ? <><X className="h-3 w-3" />Whole photo</> : <><SquareDashedMousePointer className="h-3 w-3" />{picking ? "Drag over the photo…" : "Mark an area"}</>}
          </button>
          <button type="submit" disabled={!draft.trim()} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-black disabled:opacity-40"><MessageSquarePlus className="h-3.5 w-3.5" />Comment</button>
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
  const [reply, setReply] = useState("");
  const region = parsePhotoAnchor(thread.anchorId).region;
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const resolved = thread.status === "resolved";
  return <li className={`rounded-lg border p-2.5 ${active ? "border-amber-300/60 bg-white/10" : "border-white/10 bg-white/5"} ${resolved ? "opacity-70" : ""}`}>
    <button type="button" className="block w-full text-left" onClick={onFocus} aria-expanded={active}>
      {region && <span className="mb-1 inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/70"><SquareDashedMousePointer className="h-3 w-3" />Part of the photo</span>}
      {messages.slice(0, active ? undefined : 1).map((message) => <span key={message.id} className="mt-1 block first:mt-0">
        <span className="text-xs font-medium" style={{ color: message.author.color }}>{message.actor.kind === "ai" ? `AI · requested by ${message.author.displayName}` : message.author.displayName}</span>
        <span className="ml-1.5 text-[11px] text-white/40">{timeAgo(Math.max(0, now - Date.parse(message.createdAt)))}</span>
        <span className="block whitespace-pre-wrap text-sm text-white/90">{message.body}</span>
      </span>)}
      {!active && messages.length > 1 && <span className="mt-1 block text-[11px] text-white/50">{messages.length - 1} more {messages.length === 2 ? "reply" : "replies"}</span>}
    </button>
    {active && <div className="mt-2 space-y-1.5">
      {canComment && !resolved && <form className="flex gap-1.5" onSubmit={(event) => {
        event.preventDefault();
        if (!reply.trim()) return;
        void onReply(reply.trim()).then(() => setReply(""));
      }}>
        <input aria-label="Reply" placeholder="Reply" value={reply} onChange={(event) => setReply(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-2 text-xs text-white placeholder:text-white/40 outline-none focus:border-white/40" />
        <button type="submit" disabled={!reply.trim()} className="rounded-md bg-white px-2 text-xs font-medium text-black disabled:opacity-40">Reply</button>
      </form>}
      {canResolve && <button type="button" className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white" onClick={() => void onStatus(resolved ? "open" : "resolved")}>
        {resolved ? "Reopen" : <><Check className="h-3 w-3" />Resolve</>}
      </button>}
    </div>}
  </li>;
}
