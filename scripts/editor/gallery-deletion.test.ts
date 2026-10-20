import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { filterGalleryChatPhotos, type ChatPhoto, type ChatStore } from "../../src/lib/document-chat";
import { parsePhotoEdits } from "../../src/lib/photo-edits";
import { readChatState, writeChatState } from "../../src/lib/storage/document-chat";
import {
  archivePhotos, createAlbum, deleteArchivedPhotos, deletePhotos, editPhoto, getArchive, getGallery, getGalleryRoot,
  readArchivedThumbnail, readGalleryThumbnail, renameAlbum, restoreArchivedPhotos, revertPhoto, writeGalleryPhoto,
} from "../../src/lib/storage/gallery";
import { getAdminRoot } from "../../src/lib/storage/paths";

const tile = (color = "#4060a0") => sharp({ create: { width: 90, height: 60, channels: 3, background: color } }).png().toBuffer();
const list = async (...parts: string[]) => readdir(path.join(getGalleryRoot(), ...parts)).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [] as string[];
  throw error;
});

async function withDataDirectory(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-deletion-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("edits, moves, album renames and reverts discard previous previews while retaining other photos' caches", () => withDataDirectory(async () => {
  const kept = await writeGalleryPhoto("", "keep.png", await tile(), {});
  const keptThumbnail = (await readGalleryThumbnail(kept.path)).body;
  const [keptCache] = await list(".thumbnails");
  const photo = await writeGalleryPhoto("", "remove.png", await tile("#aa0000"), {});
  await readGalleryThumbnail(photo.path);
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 30 }), "replace");
  assert.deepEqual(await list(".thumbnails"), [keptCache]);
  await readGalleryThumbnail(photo.path);

  const { album, gallery } = await createAlbum("Trip", [photo.id]);
  assert.deepEqual(await list(".thumbnails"), [keptCache]);
  await readGalleryThumbnail(gallery.photos.find((p) => p.id === photo.id)!.path);
  const renamed = await renameAlbum(album.id, "Holiday");
  assert.deepEqual(await list(".thumbnails"), [keptCache]);
  await readGalleryThumbnail(renamed.photos.find((p) => p.id === photo.id)!.path);
  const reverted = await revertPhoto(photo.id);
  assert.deepEqual(await list(".thumbnails"), [keptCache]);
  await readGalleryThumbnail(reverted.photos.find((p) => p.id === photo.id)!.path);

  const result = await deletePhotos([photo.id]);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.gallery.deletedPhotoIds, [photo.id]);
  assert.deepEqual(await list(".thumbnails"), [keptCache]);
  assert.deepEqual((await readGalleryThumbnail(kept.path)).body, keptThumbnail);
  assert.deepEqual(await list(".originals"), []);
  assert.deepEqual(result.gallery.photos.map((p) => p.id), [kept.id]);
  assert.equal(result.gallery.albums[0].count, 0);
}));

test("scans remove legacy orphaned previews in both caches and notice files deleted in Explorer", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "remove.png", await tile(), {});
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 30 }), "replace");
  await readGalleryThumbnail(photo.path);
  const archived = await writeGalleryPhoto("", "archived.png", await tile(), {});
  await editPhoto(archived.id, parsePhotoEdits({ brightness: 30 }), "replace");
  await archivePhotos([archived.id]);
  await readArchivedThumbnail("archived.png");
  for (const folder of [[".thumbnails"], [".protected", ".thumbnails"]]) {
    const directory = path.join(getGalleryRoot(), ...folder);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${"f".repeat(40)}.webp`), await tile());
    await writeFile(path.join(directory, "unrelated.txt"), "leave alone");
  }
  await rm(path.join(getGalleryRoot(), photo.path));
  await rm(path.join(getGalleryRoot(), ".protected", "archived.png"));
  const gallery = await getGallery();
  assert.deepEqual(new Set(gallery.deletedPhotoIds), new Set([photo.id, archived.id]));
  assert.deepEqual(gallery.photos, []);
  assert.deepEqual((await getArchive()).photos, []);
  assert.deepEqual(await list(".thumbnails"), ["unrelated.txt"]);
  assert.deepEqual(await list(".protected", ".thumbnails"), ["unrelated.txt"]);
  assert.deepEqual(await list(".originals"), []);
  assert.deepEqual(await list(".protected", ".originals"), []);
}));

test("archiving, external archive edits, restoring and permanent deletion clean both thumbnail stores", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "private.png", await tile(), {});
  await readGalleryThumbnail(photo.path);
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 30 }), "replace");
  await readGalleryThumbnail(photo.path);
  const moved = await createAlbum("Trip", [photo.id]);
  await readGalleryThumbnail(moved.gallery.photos[0].path);
  const archived = await archivePhotos([photo.id]);
  assert.deepEqual(archived.gallery.deletedPhotoIds, [], "archiving retains the photo's identity");
  assert.deepEqual(await list(".thumbnails"), []);
  await readArchivedThumbnail("private.png");
  await writeFile(path.join(getGalleryRoot(), ".protected", "private.png"), await tile("#ffff00"));
  await getArchive();
  assert.deepEqual(await list(".protected", ".thumbnails"), []);
  await readArchivedThumbnail("private.png");
  const restored = await restoreArchivedPhotos([photo.id]);
  assert.deepEqual(restored.archive.deletedPhotoIds, []);
  assert.deepEqual(await list(".protected", ".thumbnails"), []);
  await readGalleryThumbnail(restored.gallery.photos[0].path);
  await archivePhotos([photo.id]);
  await readArchivedThumbnail("private.png");
  const deleted = await deleteArchivedPhotos([photo.id]);
  assert.deepEqual(deleted.archive.deletedPhotoIds, [photo.id]);
  assert.deepEqual(await list(".thumbnails"), []);
  assert.deepEqual(await list(".protected", ".thumbnails"), []);
  assert.deepEqual(await list(".protected", ".originals"), []);
}));

for (const mode of ["gallery", "archive", "external-gallery", "external-archive"] as const) {
  test(`${mode} deletion purges every linked chat version and draft, and stale saves cannot restore them`, () => withDataDirectory(async () => {
    const photo = await writeGalleryPhoto("", "remove.png", await tile(), {});
    const kept = await writeGalleryPhoto("", "keep.png", await tile(), {});
    const attachment = (source?: string): ChatPhoto => ({ id: source ?? "upload", name: "remove.png", dataUrl: "data:image/png;base64,aGVsbG8=", ...(source ? { source } : {}) });
    const first = attachment(`gallery:${photo.id}:v1`);
    const second = attachment(`gallery:${photo.id}:v2`);
    const keep = attachment(`gallery:${kept.id}:v1`);
    const upload = attachment();
    const history: ChatStore = { activeId: "chat", chats: [
      { id: "chat", title: "keep title", prompt: "unsent draft", selections: [], photos: [second, upload], excludedPhotoSources: [first.source!, keep.source!], messages: [
        { id: "m", role: "user", text: "keep message", photos: [first, keep, upload] },
        { id: "a", role: "assistant", text: "keep reply" },
      ] },
      { id: "branch", title: "branch", prompt: "", selections: [], messages: [{ id: "m2", role: "user", text: "another version", photos: [second] }] },
    ] };
    await writeChatState("history", history);
    const isArchive = mode.includes("archive");
    if (isArchive) {
      await archivePhotos([photo.id]);
      assert.deepEqual(await readChatState("history"), history, "moving into the archive is not permanent deletion");
    }
    // Simulate a save already in flight while the gallery mutation starts.
    const stale = writeChatState("history", history);
    if (mode.startsWith("external")) {
      await rm(path.join(getGalleryRoot(), ...(isArchive ? [".protected"] : []), photo.path));
      await getGallery();
    } else if (isArchive) await deleteArchivedPhotos([photo.id]);
    else await deletePhotos([photo.id]);
    await stale;
    const expected = filterGalleryChatPhotos(history, (id) => id !== photo.id);
    const savedPath = path.join(getAdminRoot(), ".libera", "document-chat-history.json");
    assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), expected, "the on-disk history is purged before deletion returns");
    await Promise.all([writeChatState("history", history), writeChatState("history", history)]);
    assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), expected, "late snapshots cannot reintroduce attachments");
    assert.deepEqual(await readChatState("history"), expected);
    assert.equal(expected.chats[0].prompt, "unsent draft");
    assert.deepEqual(expected.chats[0].messages[0].photos, [keep, upload]);
    assert.deepEqual(expected.chats[0].photos, [upload]);
  }));
}

test("a thumbnail already rendering finishes before deletion sweeps its cache", (context) => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "race.png", await tile(), {});
  let started!: () => void;
  let release!: () => void;
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = sharp.prototype.toBuffer as (this: sharp.Sharp) => Promise<Buffer>;
  context.mock.method(sharp.prototype, "toBuffer", async function (this: sharp.Sharp) {
    const body = await original.call(this);
    started();
    await gate;
    return body;
  });
  const thumbnail = readGalleryThumbnail(photo.path);
  await rendering;
  const deletion = deletePhotos([photo.id]);
  release();
  await Promise.all([thumbnail, deletion]);
  assert.deepEqual(await list(".thumbnails"), []);
  await assert.rejects(readGalleryThumbnail(photo.path), { code: "ENOENT" });
  assert.deepEqual((await getGallery()).photos, [], "failed reads do not poison later mutations");
}));

test("loading old saved history repairs orphaned attachments without changing unrelated state", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "keep.png", await tile(), {});
  const history: ChatStore = { activeId: "chat", chats: [{ id: "chat", title: "History", prompt: "draft", selections: [], messages: [
    { id: "m", role: "user", text: "keep text", photos: [
      { id: "old", name: "old.png", source: "gallery:already-deleted:v1", dataUrl: "data:image/png;base64,aGVsbG8=" },
      { id: "live", name: "keep.png", source: `gallery:${photo.id}:v1`, dataUrl: "data:image/png;base64,aGVsbG8=" },
    ] },
  ] }] };
  const target = path.join(getAdminRoot(), ".libera", "document-chat-history.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(history));
  const expected = filterGalleryChatPhotos(history, (id) => id === photo.id);
  assert.deepEqual(await readChatState("history"), expected);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), expected);
  assert.equal(filterGalleryChatPhotos(expected, () => true), expected, "unchanged histories keep their identity");
}));
