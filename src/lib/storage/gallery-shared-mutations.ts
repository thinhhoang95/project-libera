import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../electron/collab/notebooks/fs-ops";
import { fileOp } from "@/lib/collab/host-client";
import { StorageError } from "@/lib/storage/errors";
import { assertCanChangeFolder, sharedAlbumMarker, sharingError } from "./gallery-sharing";

/** Publish explicit gallery intent; the follower's working copy is never the writer. */
export async function publishAlbumPhoto(root: string, folder: string, name: string, body: Buffer, createOnly = false, expectedHash?: string): Promise<boolean> {
  const shared = await assertCanChangeFolder(root, folder);
  if (!shared) return false;
  let staged: string | undefined;
  try {
    if (body.byteLength > 11 * 1024 * 1024) {
      const directory = path.join(root, folder);
      const original = await fs.lstat(directory);
      staged = randomUUID();
      const target = path.join(directory, ".libera", "collab", "incoming", staged);
      const guard = { root: directory, canCommit: async () => {
        const current = await fs.lstat(directory).catch(() => null);
        return !!current && current.ino === original.ino && current.dev === original.dev && current.birthtimeMs === original.birthtimeMs &&
          sharedAlbumMarker(root, folder)?.projectId === shared.projectId && await fs.lstat(target).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return true; throw error; });
      } };
      await writeFileAtomic(target, body, guard);
    }
    await fileOp(shared.projectId, { op: "write-blob", path: name, createOnly, expectedBlobHash: expectedHash,
      ...(staged ? { stagedFile: staged } : { contentBase64: body.toString("base64") }) });
    return true;
  } catch (error) { throw sharingError(error); }
  finally { if (staged) await fs.rm(path.join(root, folder, ".libera", "collab", "incoming", staged), { force: true }).catch(() => undefined); }
}

/** Refuse a stale visible identity instead of deleting a replacement photo. */
export async function removeAlbumPhoto(root: string, folder: string, name: string, bytes?: Buffer): Promise<boolean> {
  const shared = await assertCanChangeFolder(root, folder);
  if (!shared) return false;
  const photo = shared.album?.photos.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!photo) throw new StorageError("This shared photo changed. Refresh the album before removing it.", 409);
  try {
    await fileOp(shared.projectId, { op: "delete", path: name, expectedFileId: photo.fileId,
      ...(bytes ? { expectedBlobHash: createHash("sha256").update(bytes).digest("hex") } : {}) });
  } catch (error) { throw sharingError(error); }
  return true;
}
