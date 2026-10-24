# Shared albums and photos

Share a gallery album, or a single photo, with other people through your collaboration account. Everyone in a shared album sees the same photos, captions and comments, and contributors can add, edit and remove photos. Sharing needs collaboration (see the Collaboration section of the README) and a signed-in collaboration account.

## Sharing an album

Open an album and click **Share**. Choose the name members see, invite people by email with a role, and pick the privacy options:

- **Remove location and camera details** (on by default). Location, camera model and other EXIF, XMP and text details are removed from the album's photos, and from photos added later. The removal is lossless: the image itself is not re-encoded, and a JPEG keeps its orientation. It also applies to the copies on your computer, because the copy on disk is the copy members receive.
- **Share image prompts** (off by default). Members see the prompt and model of generated images.

Before sharing, the album's photos are gathered into its folder. A photo that is in no other album moves; a photo that is also in another album is copied, so the other album keeps its own. Only PNG, JPEG, WebP and GIF photos are shared. SVG images and other files in the folder stay on your computer.

Once the album is shared, the same dialog (the **Shared** button in the album's header) manages it: invite more people, see and revoke pending invitations, change roles, remove members, change the privacy options (owner only), and take the album down or leave it.

## Sharing one photo

Select a photo and choose **Share**, or use **Share photo…** in its right-click menu or the viewer's share button. The photo is shared on its own, as a copy in a new album folder named `<photo> (shared)`. It is listed in the **Shared** tab instead of **Albums**. Invite viewers or commenters the same way as for an album.

## Joining

An invitation link or code joins from **Collaboration → Join with an invitation…**, the bell's invitation notification, or **Accept an invitation…** in the gallery's **Shared** tab. The album downloads into your gallery as an album folder and keeps syncing. It never appears in the Notebooks list.

## Roles

| | Viewer | Commenter | Contributor | Owner |
|---|:-:|:-:|:-:|:-:|
| See photos, captions and comments; save a copy | ✓ | ✓ | ✓ | ✓ |
| Comment on a photo, or on part of it | | ✓ | ✓ | ✓ |
| Add, remove, edit and caption photos; choose the cover | | | ✓ | ✓ |
| Rename; invite and manage members; privacy options; take down | | | | ✓ |

Viewers and commenters cannot upload into the album, remove or delete its photos, or edit them in place. **Edit** still works for them, and **Save as copy** puts the edited copy in their own gallery.

## Working in a shared album

- **Adding photos.** Upload or drop photos on the album, generate into it, or use **Add to album**. A photo added from elsewhere in your gallery is copied into the album when it also belongs to another album.
- **Removing photos.** **Remove from album** takes photos out of the album for everyone and keeps them at the top of your gallery.
- **Deleting photos.** **Delete** removes the photo from the album, and from every member's computer. No hidden backup is kept. To keep a photo whatever happens to the album, save it first.
- **Save to my gallery.** Copies photos out of a shared album into your own gallery, from the selection toolbar, the right-click menu or the viewer.
- **Editing.** An edit saved over a photo is shared, and its original stays on the server, so any contributor can **Revert to original**, even on a computer where the photo was not edited. Edited GIFs become PNGs, so in a shared album they are saved as a copy.
- **Captions.** The viewer's Info panel shows the caption. Contributors edit it there; it saves when you leave the field or press Enter.
- **Comments.** The Info panel lists the photo's comments with replies, resolve and reopen. Click **Mark an area** and drag over the photo to comment on part of it; areas are outlined on the photo, and the selected comment's area is highlighted. `@` mentions and replies notify people as in shared notebooks.
- **Who added what.** The Info panel shows who added each photo.

The gallery shows other members' changes as they arrive. The **Shared** tab lists albums shared with you and albums you share, and shared albums carry a people icon in **Albums**.

## Notifications

When a member adds photos, the album's other members get one notification ("Bob added 3 photos to 'Summer trip'"). It counts up while it is unread instead of adding a new one each time. Clicking it opens the album, at the photo when there is only one. Notifications about comments on photos open the photo, at the comment.

## What stays on your computer

Stars, AI chats about photos, the Protected Archive, and image-generation settings are never shared. Photos in a shared album cannot be moved to the Protected Archive; save them to your gallery first, then archive the copy.

## When sharing ends

- **Leaving, or being removed.** Photos other members added leave your gallery, unless you saved them. The photos you added stay, as an ordinary album.
- **Taking an album down** (owner). The album and its comments are deleted from the server, and everyone loses access. Your folder stays as an ordinary local album with all its photos.

## Limits

- Every member downloads every photo of the album when joining. On-demand originals for very large albums are not available yet.
- There are no public links: everyone needs a collaboration account and an invitation.
- Photos are sorted by date; reordering them by hand is not available yet.

See [docs/collaboration/gallery-sharing.md](../collaboration/gallery-sharing.md) for how it works.
