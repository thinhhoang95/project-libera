// The gallery's side of shared albums: what sharing does to an album's files,
// what each role may change, and the details shared albums add to the
// gallery. The collab host is a stub HTTP server here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import type { LocalAlbum } from "../../src/lib/collab/local-api";
import { parsePhotoEdits } from "../../src/lib/photo-edits";
import {
  archivePhotos, createAlbum, deleteAlbum, deletePhotos, editPhoto, getGallery, getGalleryRoot, renameAlbum, revertPhoto,
  savePhotosToGallery, shareGalleryAlbum, shareGalleryPhoto, updateAlbumPhotos, writeGalleryPhoto,
} from "../../src/lib/storage/gallery";
import { forgetHostAlbums, withSharing } from "../../src/lib/storage/gallery-sharing";

const tile = (color = "#4060a0") => sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer();
const list = (...parts: string[]) => readdir(path.join(getGalleryRoot(), ...parts)).then((names) => names.filter((name) => !name.startsWith(".")).sort(), () => [] as string[]);

type Call = { method: string; url: string; body: any };

/** A stand-in for the collab host's control API. */
class HostStub {
  albums: LocalAlbum[] = [];
  calls: Call[] = [];
  original: Buffer | null = null;
  originalUnavailable = false;
  server: Server;

  constructor() {
    this.server = createServer(async (request, response) => {
      const body = await readBody(request);
      this.calls.push({ method: request.method ?? "GET", url: request.url ?? "", body });
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/albums") return reply(200, this.albums);
      if (request.method === "POST" && url === "/albums/share") {
        // The host marks the folder; the album lists as the owner's.
        const projectId = `prj_${body.folder.replace(/\W/g, "")}`;
        await writeFile(path.join(getGalleryRoot(), body.folder, ".libera-shared.json"), JSON.stringify({ projectId, manifestDocId: `${projectId}_m`, kind: "album" }));
        this.setAlbums([...this.albums, album(projectId, body.folder, "owner", { name: body.name, direct: body.direct === true })]);
        return reply(200, { projectId, name: body.name, folder: body.folder, photos: body.photos.length, skipped: [], synced: true });
      }
      if (request.method === "POST" && /^\/projects\/[^/]+\/invitations$/.test(url)) {
        if (body.email === "fails@example.test") return reply(400, { error: { code: "bad-request", message: "No such address." } });
        return reply(201, { id: "inv" });
      }
      if (request.method === "POST" && /^\/albums\/[^/]+\/original$/.test(url)) {
        if (this.originalUnavailable) return reply(503, { error: { message: "The original is offline." } });
        await mkdir(path.join(getGalleryRoot(), ".originals"), { recursive: true });
        await writeFile(path.join(getGalleryRoot(), ".originals", "shared-original.png"), this.original ?? Buffer.alloc(0));
        return reply(200, { original: "shared-original.png" });
      }
      if (request.method === "POST" && /^\/albums\/[^/]+$/.test(url)) return reply(200, this.albums[0]);
      reply(404, { error: { code: "not-found", message: "No route." } });
    });
  }

  setAlbums(albums: LocalAlbum[]) {
    this.albums = albums;
    forgetHostAlbums();
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text ? JSON.parse(text) : undefined));
  });
}

function album(projectId: string, folder: string, role: LocalAlbum["role"], extra: Partial<LocalAlbum> = {}): LocalAlbum {
  return { projectId, name: folder, folder, manifestDocId: `${projectId}_m`, role, revoked: false, direct: false, keepLocation: false, sharePrompts: false, photos: [], ...extra };
}

async function withSharedGallery(run: (host: HostStub) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-gallery-sharing-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, url: process.env.LIBERA_COLLAB_HOST_URL, token: process.env.LIBERA_COLLAB_HOST_TOKEN };
  const host = new HostStub();
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_COLLAB_HOST_URL = await host.start();
  process.env.LIBERA_COLLAB_HOST_TOKEN = "test-token";
  forgetHostAlbums();
  try {
    await run(host);
  } finally {
    for (const [key, value] of [["LIBERA_DATA_DIR", previous.data], ["LIBERA_COLLAB_HOST_URL", previous.url], ["LIBERA_COLLAB_HOST_TOKEN", previous.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    forgetHostAlbums();
    await new Promise((resolve) => host.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

/** A folder the host joined: a marker and the album as the host reports it. */
async function joinedAlbum(host: HostStub, folder: string, role: LocalAlbum["role"], photos: Array<{ name: string; caption?: string; edited?: boolean }>) {
  await mkdir(path.join(getGalleryRoot(), folder), { recursive: true });
  for (const photo of photos) await writeFile(path.join(getGalleryRoot(), folder, photo.name), await tile("#208040"));
  await writeFile(path.join(getGalleryRoot(), folder, ".libera-shared.json"), JSON.stringify({ projectId: "prj_joined", manifestDocId: "doc_joined", kind: "album" }));
  host.setAlbums([
    album("prj_joined", folder, role, {
      name: "Their trip",
      cover: photos.at(-1)?.name,
      photos: photos.map((photo, index) => ({ fileId: `fil_${index}`, name: photo.name, caption: photo.caption, edited: photo.edited === true, addedBy: "acc_friend", downloaded: true, updatedAt: 1 })),
    }),
  ]);
  const gallery = await getGallery();
  return { gallery, albumId: gallery.albums.find((entry) => entry.folder === folder)!.id };
}

test("sharing an album gathers its photos into its folder and sends invitations", () => withSharedGallery(async (host) => {
  const alone = await writeGalleryPhoto("", "alone.png", await tile(), { prompt: "a lake" });
  const both = await writeGalleryPhoto("", "both.png", await tile("#aa2020"), {});
  const { album: trip } = await createAlbum("Trip", []);
  const { album: other } = await createAlbum("Other", []);
  await updateAlbumPhotos(trip.id, { add: [alone.id, both.id] });
  await updateAlbumPhotos(other.id, { add: [both.id] });

  const result = await shareGalleryAlbum(trip.id, {
    name: "Summer",
    invitations: [{ email: "friend@example.test", role: "editor" }, { email: "fails@example.test", role: "viewer" }],
  });
  assert.equal(result.projectId, "prj_Trip");
  assert.deepEqual(result.invited, ["friend@example.test"]);
  assert.equal(result.failed[0].email, "fails@example.test");
  const share = host.calls.find((call) => call.url === "/albums/share")!.body;
  assert.equal(share.folder, "Trip");
  assert.equal(share.name, "Summer");
  assert.deepEqual(share.photos.map((photo: { name: string }) => photo.name).sort(), ["alone.png", "both.png"]);
  assert.ok(share.photos.every((photo: { prompt?: string }) => photo.prompt === undefined), "prompts stay private by default");
  assert.deepEqual(await list("Trip"), ["alone.png", "both.png"]);
  assert.deepEqual(await list(), ["Other", "Trip", "both.png"], "a photo in another album is copied, not moved");
  const gallery = await withSharing(result.gallery);
  const shared = gallery.albums.find((entry) => entry.folder === "Trip")!;
  assert.equal(shared.shared?.role, "owner");
  assert.equal(shared.count, 2);
  assert.equal(gallery.albums.find((entry) => entry.id === other.id)!.count, 1);

  await assert.rejects(shareGalleryAlbum(trip.id), /already shared/);
  await assert.rejects(deleteAlbum(trip.id), /Stop sharing it/);
  await assert.rejects(archivePhotos([gallery.photos.find((photo) => photo.folder === "Trip")!.id]), /Protected Archive/);
  // Making a new album from a shared photo copies it: the shared album keeps it.
  const sharedPhoto = gallery.photos.find((photo) => photo.path === "Trip/alone.png")!;
  await createAlbum("Copies", [sharedPhoto.id]);
  assert.deepEqual(await list("Trip"), ["alone.png", "both.png"]);
  assert.deepEqual(await list("Copies"), ["alone.png"]);
}));

test("a shared photo on its own is a copy in an album of its own", () => withSharedGallery(async (host) => {
  const photo = await writeGalleryPhoto("", "sunset.png", await tile(), { prompt: "sunset", model: "m" });
  const result = await shareGalleryPhoto(photo.id, { sharePrompts: true });
  const share = host.calls.find((call) => call.url === "/albums/share")!.body;
  assert.equal(share.direct, true);
  assert.equal(share.name, "sunset");
  assert.equal(share.folder, "sunset (shared)");
  assert.deepEqual(share.photos, [{ name: "sunset.png", prompt: "sunset", model: "m" }]);
  assert.deepEqual(await list(), ["sunset (shared)", "sunset.png"]);
  const gallery = await withSharing(result.gallery);
  assert.equal(gallery.albums.find((entry) => entry.folder === "sunset (shared)")?.shared?.direct, true);
  const svg = await writeGalleryPhoto("", "drawing.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), {});
  await assert.rejects(shareGalleryPhoto(svg.id), /Vector images cannot be shared/);
}));

test("sharing excludes photos removed from local membership, preserving their files and other albums", () => withSharedGallery(async (host) => {
  const privatePhoto = await writeGalleryPhoto("", "private.png", await tile(), {});
  const selected = await writeGalleryPhoto("", "selected.png", await tile("#aa2020"), {});
  const { album: trip } = await createAlbum("Trip", [privatePhoto.id, selected.id]);
  const { album: other } = await createAlbum("Other", []);
  await updateAlbumPhotos(other.id, { add: [privatePhoto.id] });
  await updateAlbumPhotos(trip.id, { remove: [privatePhoto.id] });
  const privateBytes = await readFile(path.join(getGalleryRoot(), "Trip/private.png"));
  // Moving a private photo out must not overwrite an unrelated gallery file.
  const collision = await writeGalleryPhoto("", "private.png", await tile("#ffffff"), {});
  const result = await shareGalleryAlbum(trip.id);
  assert.deepEqual(await list("Trip"), ["selected.png"]);
  assert.deepEqual(host.calls.find((call) => call.url === "/albums/share")!.body.photos, [{ name: "selected.png" }]);
  const kept = result.gallery.photos.find((photo) => photo.id === privatePhoto.id)!;
  assert.equal(kept.folder, "");
  assert.notEqual(kept.path, collision.path);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), kept.path)), privateBytes);
  assert.ok(kept.albumIds.includes(other.id));
  assert.equal(result.gallery.albums.find((entry) => entry.id === trip.id)!.count, 1);
}));

test("an existing local album keeps a copy after a shared photo disappears", () => withSharedGallery(async (host) => {
  await joinedAlbum(host, "Their trip", "viewer", [{ name: "beach.png" }]);
  const source = (await getGallery()).photos.find((photo) => photo.name === "beach.png")!;
  const bytes = await readFile(path.join(getGalleryRoot(), source.path));
  const { album: local } = await createAlbum("Saved", []);
  const added = await updateAlbumPhotos(local.id, { add: [source.id, source.id] });
  const copy = added.photos.find((photo) => photo.folder === "Saved")!;
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(await list("Saved"), ["beach.png"]);
  assert.ok(copy.albumIds.includes(local.id));
  await rm(path.join(getGalleryRoot(), source.path));
  const after = await getGallery();
  assert.equal(after.albums.find((entry) => entry.id === local.id)!.count, 1);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), copy.path)), bytes);
}));

test("metadata refreshes and permissions use the latest completed host snapshot", () => withSharedGallery(async (host) => {
  await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png", caption: "Before" }, { name: "dog.png" }]);
  const before = await withSharing(await getGallery());
  assert.equal(before.photos.find((photo) => photo.name === "beach.png")!.shared?.caption, "Before");
  // A host event can arrive immediately after a gallery read; no explicit cache invalidation runs here.
  host.albums = host.albums.map((entry) => ({ ...entry, role: "viewer", cover: "beach.png", photos: entry.photos.map((photo) => ({ ...photo, caption: "After" })) }));
  const after = await withSharing(await getGallery());
  const beach = after.photos.find((photo) => photo.name === "beach.png")!;
  assert.equal(beach.shared?.caption, "After");
  assert.equal(after.albums[0].coverId, beach.id);
  await assert.rejects(deletePhotos([beach.id]), /view this shared album/);
}));

test("a viewer sees captions and names but cannot change the album", () => withSharedGallery(async (host) => {
  const { albumId } = await joinedAlbum(host, "Their trip", "viewer", [{ name: "beach.png", caption: "Sunset" }, { name: "dog.png" }]);
  const gallery = await withSharing(await getGallery());
  const shared = gallery.albums.find((entry) => entry.id === albumId)!;
  assert.equal(shared.name, "Their trip");
  assert.equal(shared.shared?.role, "viewer");
  assert.equal(shared.coverId, gallery.photos.find((photo) => photo.name === "dog.png")!.id);
  const beach = gallery.photos.find((photo) => photo.name === "beach.png")!;
  assert.equal(beach.shared?.caption, "Sunset");
  assert.equal(beach.shared?.addedBy, "acc_friend");
  assert.equal(beach.shared?.fileId, "fil_0");

  await assert.rejects(deletePhotos([beach.id]), /view this shared album/);
  await assert.rejects(updateAlbumPhotos(albumId, { remove: [beach.id] }), /view this shared album/);
  await assert.rejects(editPhoto(beach.id, parsePhotoEdits({ brightness: 20 }), "replace"), /not edit its photos/);
  await assert.rejects(renameAlbum(albumId, "Mine"), /Only the album's owner/);
  await assert.rejects(writeGalleryPhoto(albumId, "new.png", await tile(), {}), /view this shared album/);
  // A copy of an edit lands in the viewer's own gallery.
  const copy = await editPhoto(beach.id, parsePhotoEdits({ brightness: 20 }), "copy");
  assert.equal(copy.gallery.photos.find((photo) => photo.id === copy.id)!.folder, "");
  assert.deepEqual(await list("Their trip"), ["beach.png", "dog.png"]);

  const saved = await savePhotosToGallery([beach.id]);
  assert.equal(saved.saved.length, 1);
  assert.equal(saved.gallery.photos.find((photo) => photo.id === saved.saved[0])!.path, "beach.png");
  assert.deepEqual(await list("Their trip"), ["beach.png", "dog.png"], "saving copies; the album keeps its photo");

  // Without an answer from the host nothing may change.
  host.setAlbums([]);
  await assert.rejects(deletePhotos([beach.id]), /collaboration service is not running/);
}));

test("a contributor adds photos by copy and removes them into their own gallery", () => withSharedGallery(async (host) => {
  const mine = await writeGalleryPhoto("", "mine.png", await tile("#102030"), {});
  const { album: kept } = await createAlbum("Kept", [mine.id]);
  const { albumId } = await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png" }]);
  await updateAlbumPhotos(albumId, { add: [mine.id] });
  assert.deepEqual(await list("Their trip"), ["beach.png", "mine.png"]);
  assert.deepEqual(await list("Kept"), ["mine.png"], "the photo's other album keeps it");
  let gallery = await getGallery();
  const beach = gallery.photos.find((photo) => photo.path === "Their trip/beach.png")!;
  gallery = await updateAlbumPhotos(albumId, { remove: [beach.id] });
  assert.deepEqual(await list("Their trip"), ["mine.png"]);
  assert.equal(gallery.photos.find((photo) => photo.id === beach.id)!.path, "beach.png", "removed from the album, kept in this gallery");
  assert.equal(gallery.albums.find((entry) => entry.id === kept.id)!.count, 1);
}));

test("reverting a photo edited elsewhere gets the original from the album", () => withSharedGallery(async (host) => {
  host.original = await tile("#ffffff");
  await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png", edited: true }]);
  const gallery = await withSharing(await getGallery());
  const beach = gallery.photos.find((photo) => photo.name === "beach.png")!;
  assert.equal(beach.edited, true, "a contributor can revert another member's edit");
  await revertPhoto(beach.id);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), "Their trip", "beach.png")), host.original);
  assert.ok(host.calls.some((call) => call.url === "/albums/prj_joined/original" && call.body.name === "beach.png"));
}));

test("editing another member's edit does not back up the intermediate photo or require its original", () => withSharedGallery(async (host) => {
  host.original = await tile("#ffffff");
  await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png", edited: true }]);
  const photo = (await getGallery()).photos[0];
  host.originalUnavailable = true;
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 20 }), "replace");
  const index = JSON.parse(await readFile(path.join(getGalleryRoot(), ".libera-gallery.json"), "utf8"));
  assert.equal(index.photos[photo.id].original, undefined);
  assert.ok(!host.calls.some((call) => call.url.endsWith("/original")));
  host.originalUnavailable = false;
  await revertPhoto(photo.id);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), photo.path)), host.original);
  assert.deepEqual(await readdir(path.join(getGalleryRoot(), ".originals")), []);
}));

test("a verified local backup can be reverted while the shared original is offline", () => withSharedGallery(async (host) => {
  await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png" }]);
  const photo = (await getGallery()).photos[0];
  const original = await readFile(path.join(getGalleryRoot(), photo.path));
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 20 }), "replace");
  Object.assign(host.albums[0].photos[0], { edited: true, originalHash: createHash("sha256").update(original).digest("hex") });
  host.originalUnavailable = true;
  await revertPhoto(photo.id);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), photo.path)), original);
  assert.ok(!host.calls.some((call) => call.url.endsWith("/original")));
}));

test("revert replaces a stale local backup with the album original and cleans up both backups", () => withSharedGallery(async (host) => {
  host.original = await tile("#ffffff");
  await joinedAlbum(host, "Their trip", "editor", [{ name: "beach.png" }]);
  const photo = (await getGallery()).photos[0];
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 20 }), "replace");
  host.albums[0].photos[0].edited = true;
  const editedBytes = await readFile(path.join(getGalleryRoot(), photo.path));
  host.originalUnavailable = true;
  await assert.rejects(revertPhoto(photo.id), /original is offline/);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), photo.path)), editedBytes, "failed download does not restore the wrong backup");
  host.originalUnavailable = false;
  await revertPhoto(photo.id);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), photo.path)), host.original);
  assert.deepEqual(await readdir(path.join(getGalleryRoot(), ".originals")), []);
}));
