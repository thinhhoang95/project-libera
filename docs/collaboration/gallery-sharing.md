# Shared albums and photos

**Status:** implemented on `collaboration-photos` (24 Oct 2026), except on-demand originals and public links (see the end).

Gallery sharing extends real-time collaboration ([README.md](README.md)) from notebooks to the gallery. Read the collaboration map first: albums reuse its projects, roles, invitations, blobs, manifest sync and comment threads.

---

## 1. The model

A **shared album is a shared project whose folder is a gallery album**. The server stores it as a project with `kind = 'album'` (migration `006_project_kind.sql`). On each member's computer it is a folder in `<data>/gallery/`, synced by the same collab host code that syncs notebook folders, running in **album mode**.

| | Notebook | Album |
|---|---|---|
| Folder | `<data>/users/admin/<name>/` | `<data>/gallery/<name>/` |
| Files shared | Documents (CRDT), blobs, folders | Top-level PNG, JPEG, WebP and GIF photos only. SVG and other files stay local. |
| Manifest | `files`, `settings` | `files` (flat blob entries), `settings`, and `photos`: one `AlbumPhotoRecord` per photo |
| Shown in | Notebooks tree | Gallery: the album, and the **Shared** tab |

**Sharing one photo** creates a one-photo album with `settings.direct = true`. It holds a copy of the photo in a folder named `<photo> (shared)`. The gallery lists it under Shared instead of Albums.

### Manifest records

```ts
settings: { cover?: fileId, direct?: true, keepLocation: boolean, sharePrompts: boolean }
photos:   { [fileId]: { fileId, addedBy, caption?, prompt?, model?, edits?, originalHash?, order?, updatedBy?, updatedAt } }
```

The server enforces these rules in `server/src/sync/validate.ts`:

- An album's `files` entries are flat blobs with a photo extension, and their mime type must match it.
- `photos` records are plain JSON keyed by a fileId the album has.
- `updatedBy` must be the sender.
- Captions are limited to 2,000 characters.
- Notebook manifests may not have `photos`.

Writing to the manifest needs the editor role, as for notebooks.

## 2. Roles

| | Viewer | Commenter | Contributor (editor) | Owner |
|---|:-:|:-:|:-:|:-:|
| See photos, captions, comments; save a copy | ✓ | ✓ | ✓ | ✓ |
| Comment on a photo or part of it | | ✓ | ✓ | ✓ |
| Add, remove, edit and caption photos; set the cover | | | ✓ | ✓ |
| Rename; invite; change roles; privacy settings; take down | | | | ✓ |

The server enforces the roles, including owner-only privacy changes in manifest sync and renaming through its `rename-project` check. The host also checks these in `updateAlbum`. The gallery mirrors the roles: viewers and commenters cannot delete, remove, upload or edit in place (an edit is saved as a copy in their own gallery).

## 3. Data flows

**Share (owner).** `POST /api/gallery/albums/share`:

1. `gallery.ts` moves any photos no longer in the album out of its folder, then gathers the album's photos into it. A photo is moved, or copied when another album also has it. Photos removed from local membership are never uploaded just because their files used to live in that folder.
2. The host's `POST /albums/share` (`NotebookServiceImpl.shareAlbum`) runs the resumable notebook share flow in album mode. It removes location details, uploads blobs, creates the project with `kind: "album"`, and writes `files`, `photos` and `settings` in one manifest change.
3. Invitations go through the usual invitation route.

Album uploads checkpoint each completed photo in `.libera-share-uploaded.jsonl`, alongside the full recovery plan. Resuming replays matching file ids and hashes, tolerates an interrupted last append, and reuploads changed photos. Completion removes both recovery files. This keeps checkpoint bytes linear in the number of photos.

**Join (member).** The usual invitation join. When the project is an album, the host creates the folder in the gallery and marks it `kind: "album"`. The gallery's scan turns the new folder into an album, and `withSharing` decorates it with the project's name, role and cover.

**Changes.** Files in a shared album folder are changed the way Libera changes any gallery photo (upload, add to album, edit, delete). The host's watcher turns those changes into album changes:

- A new file becomes a new blob and a `photos` record, and the server is told about it (`album-activity`).
- Replaced bytes are recorded as an edit: `originalHash` is kept. Writing the original back clears the edit.
- A deletion leaves the album for everyone and is deleted from every member's computer. Unlike notebooks, albums keep no `_archive` copies (of removed photos, or of local versions replaced by a member's newer one); a member keeps a photo by saving it to their gallery.

The gallery copies (never moves) photos out of a shared folder: "Save to my gallery", making a new album from shared photos, adding a shared photo to another album.

**Edits and revert.** After an in-place edit, the gallery records the `PhotoEdits` in the photo's record. Editing another member's edited photo does not back up the intermediate version. Revert uses the album's original from the host (`POST /albums/:id/original`), written into `gallery/.originals`, unless a local backup's hash matches the album's original. A verified local backup can be used offline; obsolete backups are removed after a successful revert.

**Metadata refresh.** Captions, covers and privacy changes emit `project-changed` even when no file bytes change. The gallery coalesces concurrent host requests but does not reuse completed snapshots, so an immediate refresh sees the latest metadata and role.

**Comments.** A comment on a photo is an ordinary thread on the album's manifest document. Its `anchorId` is the photo's fileId, plus an optional area: `fil_…-r<x>-<y>-<w>-<h>` in thousandths (`src/lib/collab/album-comments.ts`). Mentions, replies and resolving work as they do in notebooks.

**Notifications.** `album-photos-added` merges additions from one member while the notification is unread. It, and comments on album photos, open the album in the gallery (`requestSharedAlbum`), at the photo or the comment.

## 4. Privacy

- **Location and camera details** are removed by default (`src/lib/collab/photo-metadata.ts`), losslessly:
  - JPEG: APP1 (EXIF and XMP), APP3–APP13, APP15 and COM segments are dropped. Orientation is kept as a minimal EXIF block.
  - PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` chunks are dropped.
  - WebP: `EXIF` and `XMP ` chunks are dropped.

  This happens in the album folder on the sharer's computer too, because the copy on disk has to be the copy members get (the watcher compares hashes). The owner can let new photos keep their details.
- **Prompts** are shared only when the album shares them.
- **Stays local:** stars, AI chats, the Protected Archive. Shared photos cannot be archived until they are saved to the gallery.
- **When access ends:** photos other members added leave the member's gallery, unless they saved them. Their own photos stay, as an ordinary album. Taking an album down leaves the owner's folder as a local album.

## 5. Where it lives

| Piece | Files |
|---|---|
| Protocol | `src/lib/collab/protocol/schema.ts` (`ProjectKind`, `ManifestKeys.photos`, `AlbumPhotoRecord`, `albumPathError`), `protocol/api.ts` (`kind`, `album-photos-added`, `albumActivity`), `local-api.ts` (`LocalAlbum`, album control routes) |
| Server | `db/migrations/006_project_kind.sql`, `api/projects.ts`, `api/albums.ts`, `sync/validate.ts`, `sync/room.ts`, `jobs/digest.ts` |
| Host | `electron/collab/notebooks/project.ts` (album mode), `service.ts` (share, join, take-away, routes), `photo-metadata.ts` |
| Next | `src/lib/storage/gallery.ts`, `gallery-sharing.ts`, `src/app/api/gallery/{albums,photos}/share`, `photos/save` |
| UI | `src/components/libera/gallery-sharing.tsx`, `image-gallery-view.tsx`, `photo-viewer.tsx` |
| Tests | `server/test/albums.test.ts`, `scripts/collab/albums-host.test.ts`, `scripts/editor/gallery-sharing.test.ts`, `scripts/editor/album-comments.test.ts` |

## 6. Not done yet

- **On-demand originals.** Every member downloads every photo when they join, which is fine for albums of hundreds of photos but not thousands. Downloading on demand needs placeholder files that the gallery scan and thumbnailer understand, plus a "keep offline" choice. Both are still to design.
- **Public links** (people without an account). The server has no anonymous access, and adding it needs its own security review.
- **Photo order.** The `order` field exists in the manifest and the host API, but the gallery still sorts by date, so dragging to reorder isn't offered.
