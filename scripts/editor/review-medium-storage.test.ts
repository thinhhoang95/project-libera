// Regressions for the November 2026 collaboration review's Medium findings in
// Next-side storage: shared-album markers fail closed (R23), long PDF comment
// threads read back whole (R28), and a gallery photo's identity is not given
// to a different photo (R42).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { utimesSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { recordNotebookBinding, recordNotebookLifecycle, type NotebookMarker } from "../../src/lib/collab/local-notebook-state";
import { MAX_PDF_COMMENT_MESSAGES, normalizePdfCommentThreads } from "../../src/lib/pdf-comments";
import { getGallery, getGalleryRoot, setPhotosStarred, writeGalleryPhoto } from "../../src/lib/storage/gallery";
import { assertCanChangeFolder, sharedAlbumMarker } from "../../src/lib/storage/gallery-sharing";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { changePdfComments } from "../../src/lib/storage/pdf-comments";

async function withData(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-medium-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_LIFECYCLE_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_COLLAB_LIFECYCLE_DIR = path.join(directory, "lifecycle");
  for (const key of ["LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const) delete process.env[key];
  try { await run(directory); } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    await rm(directory, { recursive: true, force: true });
  }
}

const albumMarker = (folderId = "fld_a"): NotebookMarker => ({
  projectId: "prj_album", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_album_m", sharedAt: "2026-11-01T00:00:00.000Z", kind: "album", folderId,
});

test("R23: a shared album whose marker is missing or unreadable stays guarded", () => withData(async () => {
  const root = getGalleryRoot();
  const folder = path.join(root, "Trip");
  await mkdir(folder, { recursive: true });
  const marker = albumMarker();
  await writeFile(path.join(folder, ".libera-shared.json"), JSON.stringify(marker));
  assert.equal(sharedAlbumMarker(root, "Trip")?.projectId, "prj_album");

  // Partly delivered by a cloud provider: present but unreadable.
  await writeFile(path.join(folder, ".libera-shared.json"), "{\"projectId\": \"prj_al");
  assert.equal(sharedAlbumMarker(root, "Trip")?.unavailable, true);
  await assert.rejects(assertCanChangeFolder(root, "Trip"), { status: 403 });

  // Missing while this installation has the folder bound to the live album.
  recordNotebookBinding(process.env.LIBERA_COLLAB_LIFECYCLE_DIR!, folder, marker);
  await unlink(path.join(folder, ".libera-shared.json"));
  assert.equal(sharedAlbumMarker(root, "Trip")?.unavailable, true);
  await assert.rejects(assertCanChangeFolder(root, "Trip"), { status: 403 });

  // Only the host's recorded outcome makes it an ordinary album again.
  recordNotebookLifecycle(process.env.LIBERA_COLLAB_LIFECYCLE_DIR!, marker, "revoked");
  assert.equal(sharedAlbumMarker(root, "Trip"), null);
  assert.equal(await assertCanChangeFolder(root, "Trip"), null);

  // A folder never bound is a local album when it has no marker.
  await mkdir(path.join(root, "Local"), { recursive: true });
  assert.equal(sharedAlbumMarker(root, "Local"), null);
}));

test("R28: a long comment thread reads back whole, and a reply past the limit is refused", () => withData(async () => {
  const messages = Array.from({ length: 600 }, (_, index) => ({ id: `m${index}`, text: `reply ${index}`, createdAt: "2026-11-01T00:00:00.000Z" }));
  const anchor = { segments: [{ pageNumber: 1, rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }] }], quote: "q" };
  const [thread] = normalizePdfCommentThreads([{ id: "t1", anchor, status: "open", messages, createdAt: "x", updatedAt: "x" }], randomUUID);
  assert.equal(thread.messages.length, 600, "later replies are not dropped on read");

  await createNotebook("Notes");
  const target = filePathFromParts("Notes", ["full.pdf"]);
  await writeFile(target, "%PDF-1.4\n%%EOF\n");
  const full = Array.from({ length: MAX_PDF_COMMENT_MESSAGES }, (_, index) => ({ id: `f${index}`, text: "x", createdAt: "2026-11-01T00:00:00.000Z" }));
  const sidecar = pdfAnnotationsPath("Notes", ["full.pdf"]);
  await mkdir(path.dirname(sidecar), { recursive: true });
  await writeFile(sidecar, JSON.stringify({ annotations: [], comments: [{ id: "t-full", anchor, status: "open", messages: full, createdAt: "x", updatedAt: "x" }] }));
  await assert.rejects(changePdfComments("Notes/full.pdf", { action: "reply", threadId: "t-full", text: "one more" }), { status: 413 });
}));

test("R42: a different photo with the same name and size does not inherit a missing photo's identity", () => withData(async () => {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#4060a0" } }).png().toBuffer();
  const photo = await writeGalleryPhoto("", "a.png", bytes, {});
  await setPhotosStarred([photo.id], true);

  // The original goes; another photo of the same name and size, made at another time, appears elsewhere.
  await unlink(path.join(getGalleryRoot(), "a.png"));
  await mkdir(path.join(getGalleryRoot(), "Imported"));
  const other = path.join(getGalleryRoot(), "Imported", "a.png");
  await writeFile(other, bytes);
  const earlier = new Date(Date.now() - 86_400_000);
  utimesSync(other, earlier, earlier);
  let gallery = await getGallery();
  const found = gallery.photos.find((entry) => entry.path === "Imported/a.png");
  assert.ok(found);
  assert.notEqual(found.id, photo.id);
  assert.equal(found.starred ?? false, false, "no star from the other photo");

  // A real move keeps its identity (name, size and modification time match).
  const moved = await writeGalleryPhoto("", "b.png", bytes, {});
  await setPhotosStarred([moved.id], true);
  await rename(path.join(getGalleryRoot(), "b.png"), path.join(getGalleryRoot(), "Imported", "b.png"));
  gallery = await getGallery();
  assert.equal(gallery.photos.find((entry) => entry.path === "Imported/b.png")?.id, moved.id);
}));
