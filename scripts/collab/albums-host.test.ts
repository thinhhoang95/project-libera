// Shared albums through the real host and server: share a gallery folder,
// join it from another account, add and edit photos on either side, and
// what is left when access ends.

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ControlRoutes, type LocalAlbum, type ShareAlbumResult } from "../../src/lib/collab/local-api";
import { exifOrientation, stripPhotoMetadata } from "../../src/lib/collab/photo-metadata";
import { api, closePeer, invite, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

/** A structurally valid JPEG: EXIF (orientation, plus a stand-in for GPS data), a quantization table, a scan. */
export function jpegWithExif(marker: string, orientation = 6): Buffer {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "binary"),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from(`GPS:${marker}`, "binary"),
  ]);
  const segment = (code: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    segment(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from(`image-data-${marker}`, "binary"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function app1(bytes: Buffer): Buffer | null {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const code = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (code === 0xe1) return bytes.subarray(offset + 4, offset + 2 + length);
    if (code === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

async function albums(peer: Peer): Promise<LocalAlbum[]> {
  const response = await peer.router.call("GET", ControlRoutes.albums);
  assert.equal(response.status, 200);
  return response.body as LocalAlbum[];
}

const galleryOf = (peer: Peer) => path.join(peer.library, "..", "..", "gallery");

test("photo metadata: location details go, orientation and image data stay", () => {
  const jpeg = jpegWithExif("secret");
  const stripped = Buffer.from(stripPhotoMetadata(jpeg, "image/jpeg")!);
  assert.ok(!stripped.includes("GPS:secret"));
  assert.ok(stripped.includes("image-data-secret"));
  assert.equal(exifOrientation(app1(stripped)!), 6);
  assert.equal(stripPhotoMetadata(stripped, "image/jpeg"), null, "nothing left to remove");
  assert.equal(app1(Buffer.from(stripPhotoMetadata(jpegWithExif("x", 1), "image/jpeg")!)), null, "no EXIF block is needed for orientation 1");

  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "binary"), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.alloc(13)),
    chunk("tEXt", Buffer.from("Location\0Paris")),
    chunk("eXIf", Buffer.from("MM")),
    chunk("IDAT", Buffer.from("pixels")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const cleanPng = Buffer.from(stripPhotoMetadata(png, "image/png")!);
  assert.ok(!cleanPng.includes("Paris") && !cleanPng.includes("eXIf"));
  assert.ok(cleanPng.includes("pixels") && cleanPng.includes("IEND"));

  const riff = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "binary");
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04;
  const body = Buffer.concat([riff("VP8X", vp8x), riff("VP8 ", Buffer.from("frame")), riff("EXIF", Buffer.from("GPS-here")), riff("XMP ", Buffer.from("<x/>"))]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length + 4);
  const webp = Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), body]);
  const cleanWebp = Buffer.from(stripPhotoMetadata(webp, "image/webp")!);
  assert.ok(!cleanWebp.includes("GPS-here") && !cleanWebp.includes("<x/>"));
  assert.equal(cleanWebp.readUInt32LE(4), cleanWebp.length - 8);
  assert.equal(cleanWebp[20] & 0x0c, 0, "VP8X no longer announces EXIF or XMP");

  assert.equal(stripPhotoMetadata(Buffer.from("not a jpeg"), "image/jpeg"), null);
  assert.equal(stripPhotoMetadata(Buffer.from("GIF89a"), "image/gif"), null);
});

test("shared albums between two hosts", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-albums-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const ownerAuth = await register(server, "AlbumOwner");
    const memberAuth = await register(server, "AlbumMember");
    const owner = await makePeer(temp.dir, "owner", server, ownerAuth);
    const member = await makePeer(temp.dir, "member", server, memberAuth);
    peers.push(owner, member);
    const ownerAlbum = path.join(galleryOf(owner), "Trip");
    writeTree(ownerAlbum, { "beach.jpg": jpegWithExif("beach"), "notes.txt": "local only", "logo.svg": "<svg/>", "sub/inner.png": "x" });

    let projectId = "";
    let memberAlbum = "";

    await t.test("sharing an album uploads its photos without location details", async () => {
      const shared = await owner.router.call("POST", ControlRoutes.albumShare, {
        folder: "Trip",
        name: "Summer trip",
        photos: [{ name: "beach.jpg", caption: "Sunset", prompt: "a beach", model: "m" }],
      });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const result = shared.body as ShareAlbumResult;
      projectId = result.projectId;
      assert.equal(result.photos, 1);
      assert.deepEqual([...result.skipped].sort(), ["logo.svg", "notes.txt", "sub/inner.png"].sort());
      const onDisk = readFileSync(path.join(ownerAlbum, "beach.jpg"));
      assert.ok(!onDisk.includes("GPS:beach"), "the owner's copy is the shared one");
      assert.equal(exifOrientation(app1(onDisk)!), 6);
      const [album] = await albums(owner);
      assert.equal(album.name, "Summer trip");
      assert.equal(album.folder, "Trip");
      assert.equal(album.role, "owner");
      assert.deepEqual(album.photos.map((photo) => [photo.name, photo.caption, photo.prompt]), [["beach.jpg", "Sunset", undefined]], "prompts stay private unless shared");
      assert.equal(owner.service.localProjects()[0].kind, "album");
      assert.equal(owner.service.resolvePath("Trip/beach.jpg"), null, "albums are not notebooks");
    });

    await t.test("an invited member joins the album into their gallery", async () => {
      const joined = await member.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, projectId, "albummember@example.test") });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const body = joined.body as { notebook: string; kind: string; materialized: boolean };
      assert.equal(body.kind, "album");
      memberAlbum = path.join(galleryOf(member), body.notebook);
      assert.equal(body.notebook, "Summer trip");
      assert.ok(!existsSync(path.join(member.library, body.notebook)), "nothing lands in the Notebooks tree");
      await until(() => existsSync(path.join(memberAlbum, "beach.jpg")), "photo downloaded");
      assert.deepEqual(readFileSync(path.join(memberAlbum, "beach.jpg")), readFileSync(path.join(ownerAlbum, "beach.jpg")));
      const [album] = await albums(member);
      assert.equal(album.role, "editor");
      assert.equal(album.photos[0].caption, "Sunset");
      assert.equal(album.photos[0].downloaded, true);
    });

    await t.test("a member's new photo reaches the owner, stripped, and the owner hears about it", async () => {
      writeFileSync(path.join(memberAlbum, "dog.jpg"), jpegWithExif("dog"));
      writeFileSync(path.join(memberAlbum, "ignored.txt"), "stays here");
      await until(() => existsSync(path.join(ownerAlbum, "dog.jpg")), "photo reaches the owner");
      assert.ok(!readFileSync(path.join(ownerAlbum, "dog.jpg")).includes("GPS:dog"));
      assert.ok(!readFileSync(path.join(memberAlbum, "dog.jpg")).includes("GPS:dog"), "stripped in the member's folder too");
      assert.ok(!existsSync(path.join(ownerAlbum, "ignored.txt")));
      await until(async () => (await albums(owner))[0].photos.some((photo) => photo.name === "dog.jpg" && photo.addedBy === memberAuth.account.id), "addedBy recorded");
      await until(async () => {
        const notifications = await api<Array<{ kind: string; payload: { count: number } }>>(server, "/v1/notifications", undefined, ownerAuth.accessToken);
        return notifications.body.some((item) => item.kind === "album-photos-added" && item.payload.count === 1);
      }, "owner notified");
    });

    await t.test("captions and the cover are shared; viewers' changes are refused", async () => {
      const updated = await owner.router.call("POST", ControlRoutes.album(projectId), { photos: [{ name: "dog.jpg", caption: "Good dog" }], cover: "dog.jpg" });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      await until(async () => {
        const [album] = await albums(member);
        return album.cover === "dog.jpg" && album.photos.find((photo) => photo.name === "dog.jpg")?.caption === "Good dog";
      }, "caption and cover reach the member");
      const privacy = await member.router.call("POST", ControlRoutes.album(projectId), { keepLocation: true });
      assert.equal(privacy.status, 403, "only the owner decides what the album shares");
    });

    await t.test("an edit keeps the original on the server, so anyone can get it back", async () => {
      const original = readFileSync(path.join(ownerAlbum, "beach.jpg"));
      const edited = Buffer.from(stripPhotoMetadata(jpegWithExif("beach-edited", 1), "image/jpeg")!);
      writeFileSync(path.join(ownerAlbum, "beach.jpg"), edited);
      await until(() => existsSync(path.join(memberAlbum, "beach.jpg")) && readFileSync(path.join(memberAlbum, "beach.jpg")).equals(edited), "edit reaches the member");
      await until(async () => (await albums(member))[0].photos.find((photo) => photo.name === "beach.jpg")?.edited === true, "marked edited");
      const fetched = await member.router.call("POST", ControlRoutes.albumOriginal(projectId), { name: "beach.jpg" });
      assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
      const name = (fetched.body as { original: string }).original;
      assert.deepEqual(readFileSync(path.join(galleryOf(member), ".originals", name)), original);
      // Putting the original back clears the edit. (After the host has
      // recorded the download, as a person would be slower than that.)
      await member.service.project(projectId)!.whenIdle();
      writeFileSync(path.join(memberAlbum, "beach.jpg"), original);
      await until(async () => (await albums(owner))[0].photos.find((photo) => photo.name === "beach.jpg")?.edited === false, "revert clears the edit");
    });

    await t.test("a deleted photo leaves every member's computer, with no copy kept", async () => {
      writeFileSync(path.join(memberAlbum, "cat.jpg"), jpegWithExif("cat"));
      await until(() => existsSync(path.join(ownerAlbum, "cat.jpg")), "photo reaches the owner");
      await owner.service.project(projectId)!.whenIdle();
      rmSync(path.join(ownerAlbum, "cat.jpg"));
      await until(() => !existsSync(path.join(memberAlbum, "cat.jpg")), "deletion reaches the member");
      assert.ok(!existsSync(path.join(memberAlbum, "_archive")), "no hidden backup copy on the member's computer");
      assert.ok(!existsSync(path.join(ownerAlbum, "_archive")));
    });

    await t.test("when access ends, the member keeps the photos they added", async () => {
      const removed = await api(server, `/v1/projects/${projectId}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, "DELETE");
      assert.ok(removed.status === 204 || removed.status === 200, JSON.stringify(removed));
      await until(() => !existsSync(path.join(memberAlbum, "beach.jpg")), "the owner's photo goes");
      assert.ok(existsSync(path.join(memberAlbum, "dog.jpg")), "the member's own photo stays");
      assert.ok(existsSync(path.join(memberAlbum, "ignored.txt")), "local files are not touched");
      assert.ok(!existsSync(path.join(memberAlbum, ".libera-shared.json")), "the folder is an ordinary album now");
      assert.deepEqual(await albums(member), []);
      assert.ok(existsSync(path.join(ownerAlbum, "dog.jpg")), "the owner keeps everything");
    });

    await t.test("taking an album down leaves the owner's folder as a local album", async () => {
      const deleted = await owner.router.call("DELETE", ControlRoutes.project(projectId));
      assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
      assert.ok(!existsSync(path.join(ownerAlbum, ".libera-shared.json")));
      assert.ok(existsSync(path.join(ownerAlbum, "beach.jpg")) && existsSync(path.join(ownerAlbum, "dog.jpg")));
      assert.deepEqual(await albums(owner), []);
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
