import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ControlServer } from "../../../electron/collab/control/server.ts";
import { readManifest } from "../../../electron/collab/notebooks/layout.ts";
import { sha256 } from "../../../electron/collab/notebooks/fs-ops.ts";
import { invalidateSharedNotebookCache } from "../../../src/lib/collab/shared-notebook.ts";
import { encodeInkSamples, sampleBounds } from "../../../src/lib/ink/codec.ts";
import { inkFolderPath, resetInkStorageForTests, writeInk } from "../../../src/lib/storage/ink.ts";
import { deletePhotos, editPhoto, getGallery, updateAlbumPhotos, writeGalleryPhoto } from "../../../src/lib/storage/gallery.ts";
import { NO_EDITS } from "../../../src/lib/photo-edits.ts";
import { closePeer, makePeer, register, tempRoot, until, writeTree } from "./notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "./server-process.ts";

const manifest = (peer, id) => readManifest(peer.service.project(id).manifestHub.getDoc("manifest"));
const inkStroke = (id) => {
  const samples = [{ x: 10, y: 10, pressure: 0.5 }, { x: 50, y: 20, pressure: 0.6 }];
  return { id, brush: "pen", color: "#123456", opacity: 1, width: 1, lineStyle: "solid", points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: "2026-11-07T00:00:00.000Z" };
};

test("R06 and R17: follower storage operations use acknowledged authority", { timeout: 90_000 }, async (t) => {
  const temp = tempRoot("libera-critical-storage-"); const server = await startServerProcess();
  const peers = []; let control;
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const auth = await register(server, "StorageOwner");
    const owner = await makePeer(temp.dir, "storage-owner", server, auth, { leaseTtlMs: 60_000 }); peers.push(owner);
    const root = path.join(owner.library, "Ink"); writeTree(root, { "paper.pdf": "%PDF-1.4 follower ink" });
    const shared = await owner.service.share({ notebook: "Ink" }); await owner.service.project(shared.projectId).whenIdle();
    const image = await sharp({ create: { width: 5, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const gallery = path.join(owner.library, "..", "..", "gallery");
    writeTree(path.join(gallery, "Photos"), { "base.png": image, "remove.png": image });
    const album = await owner.service.shareAlbum({ folder: "Photos" }); await owner.service.project(album.projectId).whenIdle();
    const library = path.join(temp.dir, "storage-follower", "users", "admin"); mkdirSync(library, { recursive: true });
    cpSync(root, path.join(library, "Ink"), { recursive: true });
    const followerGallery = path.join(library, "..", "..", "gallery"); cpSync(gallery, followerGallery, { recursive: true });
    const follower = await makePeer(temp.dir, "storage-follower", server, auth, { library, leaseTtlMs: 60_000 }); peers.push(follower);
    await until(() => follower.service.project(shared.projectId)?.follower && follower.service.project(album.projectId)?.follower, "storage follower ready");
    await follower.service.project(shared.projectId).whenIdle(); await follower.service.project(album.projectId).whenIdle();
    control = new ControlServer({ logger: { warn() {}, error() {} } }); follower.service.registerRoutes(control.routes);
    const address = await control.listen();
    process.env.LIBERA_DATA_DIR = path.resolve(library, "../.."); process.env.LIBERA_CONFIG_PATH = path.join(temp.dir, "profile", "config.json");
    process.env.LIBERA_COLLAB_HOST_URL = address.url; process.env.LIBERA_COLLAB_HOST_TOKEN = address.token;
    invalidateSharedNotebookCache(); resetInkStorageForTests();

    await t.test("R06: repeated successful follower ink saves retain additions and erasures without disk delivery", async () => {
      const frame = { unit: "pt", width: 612, height: 792 };
      await writeInk("Ink/paper.pdf", "page-0001", { add: [inkStroke("stroke-a")] }, frame);
      resetInkStorageForTests(); // A new Next process still has its acknowledged author state.
      const second = await writeInk("Ink/paper.pdf", "page-0001", { add: [inkStroke("stroke-b")] }, frame);
      assert.deepEqual(second.chunks[0].strokes.map((entry) => entry.stroke.id), ["stroke-a", "stroke-b"]);
      await writeInk("Ink/paper.pdf", "page-0001", { erase: ["stroke-a"] }, frame);
      const final = await writeInk("Ink/paper.pdf", "page-0001", { add: [inkStroke("stroke-c")] }, frame);
      assert.deepEqual(final.chunks[0].strokes.map((entry) => entry.stroke.id), ["stroke-b", "stroke-c"]);
      assert.equal(existsSync(inkFolderPath("Ink", ["paper.pdf"])), false, "no author-file cloud delivery was simulated");
      const entry = [...manifest(follower, shared.projectId).values()].find((entry) => entry.path.endsWith(".ink"));
      const uploaded = JSON.parse(Buffer.from(await follower.host.api.downloadBlob(shared.projectId, entry.blobHash)).toString("utf8"));
      assert.deepEqual(uploaded.strokes.map((stroke) => stroke.id), ["stroke-b", "stroke-c"]);
    });

    await t.test("R17: follower gallery add, replace, remove and delete publish explicit manifest mutations", async () => {
      const initial = await getGallery(); const localAlbum = initial.albums.find((entry) => entry.folder === "Photos");
      const base = initial.photos.find((entry) => entry.name === "base.png"); const removed = initial.photos.find((entry) => entry.name === "remove.png");
      const addedBody = await sharp(image).negate().png().toBuffer();
      await writeGalleryPhoto(localAlbum.id, "added.png", addedBody, {});
      assert.ok([...manifest(follower, album.projectId).values()].some((entry) => entry.path === "added.png"));
      assert.equal(existsSync(path.join(followerGallery, "Photos", "added.png")), false, "follower does not write an added photo to disk");
      const originalHash = [...manifest(follower, album.projectId).values()].find((entry) => entry.path === "base.png").blobHash;
      await editPhoto(base.id, { ...NO_EDITS, rotate: 90 }, "replace");
      assert.notEqual([...manifest(follower, album.projectId).values()].find((entry) => entry.path === "base.png").blobHash, originalHash);
      assert.deepEqual(readFileSync(path.join(followerGallery, "Photos", "base.png")), image, "replacement reaches the host before any disk delivery");
      const acceptedHash = [...manifest(follower, album.projectId).values()].find((entry) => entry.path === "base.png").blobHash;
      await assert.rejects(editPhoto(base.id, { ...NO_EDITS, rotate: 180 }, "replace"), (error) => error.status === 409);
      assert.equal([...manifest(follower, album.projectId).values()].find((entry) => entry.path === "base.png").blobHash, acceptedHash, "another edit from stale disk cannot replace the accepted version");
      const refreshed = await getGallery();
      assert.ok(refreshed.photos.some((photo) => photo.name === "added.png"), "a published photo remains indexed before disk arrival");
      await updateAlbumPhotos(localAlbum.id, { remove: [removed.id] });
      assert.equal([...manifest(follower, album.projectId).values()].some((entry) => entry.path === "remove.png"), false);
      await deletePhotos([base.id]);
      assert.equal([...manifest(follower, album.projectId).values()].some((entry) => entry.path === "base.png"), false);
      assert.ok([...manifest(follower, album.projectId).values()].some((entry) => entry.path === "added.png"));
      await until(() => [...manifest(owner, album.projectId).values()].length === 1, "writer receives all gallery actions");
      await owner.service.project(album.projectId).whenIdle();
      assert.equal(sha256(readFileSync(path.join(gallery, "Photos", "added.png"))), sha256(addedBody));
    });

    await t.test("R17: large gallery photos use valid exclusive staging names", async () => {
      const contents = await getGallery(); const localAlbum = contents.albums.find((entry) => entry.folder === "Photos");
      const body = Buffer.concat([image, Buffer.alloc(11 * 1024 * 1024)]);
      await writeGalleryPhoto(localAlbum.id, "large.png", body, {});
      const entry = [...manifest(follower, album.projectId).values()].find((entry) => entry.path === "large.png");
      assert.equal(entry.blobHash, sha256(body));
      assert.equal(existsSync(path.join(followerGallery, "Photos", "large.png")), false);
      assert.deepEqual(readdirSync(path.join(followerGallery, "Photos", ".libera", "collab", "incoming")), []);
    });
  } finally {
    resetInkStorageForTests(); invalidateSharedNotebookCache();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await control?.close(); for (const peer of peers.reverse()) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
