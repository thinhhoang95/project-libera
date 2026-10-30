import { randomBytes } from "node:crypto";
import { copyFile, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import {
  BUILT_IN_ILLUSTRATIONS,
  isIllustrationImageId,
  isIllustrationSetId,
  isNotebookCoverFile,
} from "../../../electron/notebook-illustrations.cjs";
import { illustrationFilePath } from "../../../electron/notebook-illustration-store.cjs";
import { StorageError } from "@/lib/storage/errors";
import { readNotebookMetadata, writeNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { assertSafeSegment, getAdminRoot, getLinkedFolder, notebookMetadataPath, notebookPath } from "@/lib/storage/paths";
import { getTree, LINKED_FOLDER_METADATA_DEFAULTS } from "@/lib/storage/tree";
import { joinPath, workingDirectory } from "@/lib/runtime-path";

// A cover the user picks for a notebook is copied next to the notebook's
// metadata, so it stays when its set is deleted or the set's image is
// re-cropped. Picking another cover, or going back to a random one, deletes
// the copy.

/** The file an illustration URL from the picker points at. */
function illustrationSourceFile(url: string) {
  const builtIn = BUILT_IN_ILLUSTRATIONS.find((image) => image.url === url);
  if (builtIn) return joinPath(workingDirectory(), "public", "images", ...builtIn.file.split("/"));
  const match = /^\/api\/notebook-illustrations\/([^/]+)\/([^/]+)$/.exec(url);
  if (match && isIllustrationSetId(match[1]) && isIllustrationImageId(match[2])) {
    return illustrationFilePath(getAdminRoot(), match[1], match[2]);
  }
  throw new StorageError("Choose an illustration from one of your sets.", 400);
}

async function notebookMetadata(name: string) {
  return getLinkedFolder(name)
    ? readNotebookMetadata(name, new Date(0).toISOString(), LINKED_FOLDER_METADATA_DEFAULTS)
    : readNotebookMetadata(name, (await stat(notebookPath(name))).birthtime.toISOString());
}

function coverPath(name: string, file: string) {
  return path.join(path.dirname(notebookMetadataPath(name)), file);
}

/** Sets a notebook's cover to a copy of `illustrationUrl`, or with null back to a random one from the chosen set. */
export async function setNotebookIllustration(notebook: string, illustrationUrl: string | null) {
  const name = assertSafeSegment(notebook, "Notebook name");
  const metadata = await notebookMetadata(name);
  const previous = metadata.illustrationPath;
  let illustrationPath: string | undefined;
  // A new cover is not an edit: keep the folder's time, which the notebook shows as "Updated".
  const folder = path.dirname(notebookMetadataPath(name));
  const folderTimes = await stat(folder).catch(() => null);

  if (illustrationUrl) {
    const source = illustrationSourceFile(illustrationUrl);
    illustrationPath = `.libera-notebook-cover-${randomBytes(8).toString("hex")}${path.extname(source).toLowerCase() === ".png" ? ".png" : ".jpg"}`;
    try {
      await copyFile(source, coverPath(name, illustrationPath));
    } catch {
      throw new StorageError("That illustration is no longer available.", 404);
    }
  }

  const next = { ...metadata, illustrationPath };
  if (!illustrationPath) delete next.illustrationPath;
  await writeNotebookMetadata(name, next);
  if (previous && previous !== illustrationPath) await rm(coverPath(name, previous), { force: true });
  if (folderTimes) await utimes(folder, folderTimes.atime, folderTimes.mtime).catch(() => {});
  return getTree();
}

export async function readNotebookCover(notebook: string, file: string) {
  const name = assertSafeSegment(notebook, "Notebook name");
  if (!isNotebookCoverFile(file)) throw new StorageError("Cover not found.", 404);
  try {
    return { image: await readFile(coverPath(name, file)), type: file.endsWith(".png") ? "image/png" : "image/jpeg" };
  } catch {
    throw new StorageError("Cover not found.", 404);
  }
}
