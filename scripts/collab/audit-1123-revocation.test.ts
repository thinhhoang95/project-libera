// Audit 2026-11-23, package RV: C3 (a confirmed 404 ends a markerless project),
// C10 (one file closing never revokes the notebook), C11 (an owner is never a
// removed member; album cleanup that cannot tell whose photos are whose
// deletes none), H3 (revocation marks every document read-only so a rejoin
// rolls pending edits back), M16 (album cleanup without a runtime, and
// uniform marker authority for a retried cleanup).

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { readNotebookBinding, readNotebookLifecycle } from "../../src/lib/collab/local-notebook-state";
import { ControlRoutes, type LocalAlbum } from "../../src/lib/collab/local-api";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { closePeer, invite, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";

/** A structurally valid JPEG (a quantization table and a scan) that differs by `marker`. */
function jpegWithExif(marker: string): Buffer {
  const segment = (code: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from(`image-data-${marker}`, "binary"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

interface Faults {
  /** What `GET /v1/projects/:id` does: fail like a dead network, answer 503, or answer 404. */
  project: "net" | "500" | "404" | null;
  /** `GET /v1/me` fails like a dead network. */
  me: boolean;
}

function flaky(faults: Faults): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/v1\/projects\/[^/?]+$/.test(url)) {
      if (faults.project === "net") throw new TypeError("fetch failed");
      if (faults.project === "500") return new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 503 });
      if (faults.project === "404") return new Response(JSON.stringify({ error: { code: "not-found", message: "Project not found." } }), { status: 404 });
    }
    if (faults.me && /\/v1\/me$/.test(url)) throw new TypeError("fetch failed");
    return fetch(url, init);
  };
}

interface Handle {
  revoked: boolean;
  runtime: { stop(options?: unknown): Promise<void> } | null;
  root: string;
  [key: string]: unknown;
}
interface Internals {
  projects: Map<string, Handle>;
  lifecycleDirectory: string;
  markerRepairDelayMs: number;
  cachedAccountId: string | null;
  repairMissingMarker(projectId: string, root: string): Promise<boolean>;
  doRevoke(projectId: string, deleted: boolean): Promise<void>;
  takeAlbumAway(handle: Handle): Promise<void>;
  runAlbumCleanup(entry: Record<string, unknown>): Promise<void>;
}
const internals = (peer: Peer) => peer.service as unknown as Internals;

async function albums(peer: Peer): Promise<LocalAlbum[]> {
  const response = await peer.router.call("GET", ControlRoutes.albums);
  assert.equal(response.status, 200);
  return response.body as LocalAlbum[];
}

const galleryOf = (peer: Peer) => path.join(peer.library, "..", "..", "gallery");

test("revocation audit fixes", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-revocation-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const ownerAuth = await register(server, "RevOwner");
    const memberAuth = await register(server, "RevMember");
    const ownerFaults: Faults = { project: null, me: false };
    const memberFaults: Faults = { project: null, me: false };
    let owner = await makePeer(temp.dir, "owner", server, ownerAuth, { fetch: flaky(ownerFaults) });
    const member = await makePeer(temp.dir, "member", server, memberAuth, { fetch: flaky(memberFaults) });
    peers.push(member);

    await t.test("C3: a markerless project ends locally only on a confirmed 404", async () => {
      writeTree(path.join(owner.library, "Thesis"), { "note.md": "thesis\n" });
      const shared = await owner.service.share({ notebook: "Thesis" });
      await owner.service.project(shared.projectId)?.whenIdle();
      await closePeer(owner);
      const root = path.join(owner.library, "Thesis");
      rmSync(path.join(root, MARKER));
      owner = await makePeer(temp.dir, "owner", server, ownerAuth, { fetch: flaky(ownerFaults) });
      const service = internals(owner);
      service.markerRepairDelayMs = 0;
      const binding = readNotebookBinding(service.lifecycleDirectory, root)!;
      assert.ok(binding, "the folder is still bound");
      assert.ok(!service.projects.has(shared.projectId), "no runtime runs for a markerless folder");
      for (const fault of ["net", "500"] as const) {
        ownerFaults.project = fault;
        assert.equal(await service.repairMissingMarker(shared.projectId, root), false);
        assert.ok(owner.host.store.getProject(shared.projectId), `${fault}: the project row stays`);
        assert.equal(readNotebookLifecycle(service.lifecycleDirectory, binding), null, `${fault}: no terminal outcome is recorded`);
      }
      ownerFaults.project = "404";
      assert.equal(await service.repairMissingMarker(shared.projectId, root), false);
      assert.equal(owner.host.store.getProject(shared.projectId), null, "the project row is gone");
      assert.equal(readNotebookLifecycle(service.lifecycleDirectory, binding), "local", "an owner's project ends as local");
      ownerFaults.project = null;
    });

    let projectId = "";
    let noteDoc = "";
    let memberRoot = "";

    await t.test("C10 and C11: one file closing, or a server that cannot be asked, never revokes an owner", async () => {
      writeTree(path.join(owner.library, "Ten"), { "note.md": "ten\n", "other.md": "other\n" });
      const shared = await owner.service.share({ notebook: "Ten" });
      projectId = shared.projectId;
      const project = owner.service.project(projectId)!;
      await project.whenIdle();
      noteDoc = owner.service.resolvePath("Ten/note.md")!.docId;
      const handle = internals(owner).projects.get(projectId)!;
      const marker = () => JSON.parse(readFileSync(path.join(owner.library, "Ten", MARKER), "utf8")) as { revoked?: boolean };

      for (const reason of ["access-revoked", "not-found"] as const) {
        const hub = owner.host.acquire(noteDoc);
        try {
          hub.handleClosed({ type: MessageType.Closed, docId: noteDoc, reason });
        } finally {
          owner.host.release(noteDoc);
        }
        await sleep(300);
        assert.equal(handle.revoked, false, `a file closing as ${reason} does not revoke the notebook`);
        assert.notEqual(marker().revoked, true, `${reason}: the marker is not written revoked`);
        owner.host.clearReadOnly(noteDoc);
      }

      for (const fault of ["net", "500", null] as const) {
        ownerFaults.project = fault;
        await internals(owner).doRevoke(projectId, false);
        assert.equal(handle.revoked, false, `server ${fault ?? "answers"}: an owner is not treated as a removed member`);
        assert.ok(handle.runtime, `${fault}: the runtime keeps running`);
        assert.notEqual(marker().revoked, true);
      }
      ownerFaults.project = null;
    });

    await t.test("H3: revocation marks every document of the project, and a rejoin rolls pending edits back", async () => {
      const joined = await member.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, projectId, "revmember@example.test") });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      memberRoot = path.join(member.library, (joined.body as { notebook: string }).notebook);
      await until(() => existsSync(path.join(memberRoot, "note.md")), "the note reaches the member");
      await member.service.project(projectId)?.whenIdle();
      await internals(member).doRevoke(projectId, false);
      const docIds = member.host.store.projectDocIds(projectId);
      assert.ok(docIds.length >= 3, "manifest and both files are known");
      for (const docId of docIds) {
        assert.equal(member.host.store.getDocMeta(docId)?.readOnlyReason, "access-revoked", `${docId} is read-only after revocation`);
      }
      const hub = member.host.acquire(noteDoc);
      try {
        hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "STALE-PRE-REVOCATION "));
        member.host.restoreProjectAccess(projectId, "editor");
        await sleep(1_500);
        assert.ok(!hub.getText().includes("STALE-PRE-REVOCATION"), "the member's copy loaded the live version");
      } finally {
        member.host.release(noteDoc);
      }
      const live = owner.host.acquire(noteDoc);
      try {
        assert.ok(!live.getText().includes("STALE-PRE-REVOCATION"), "the stale edit never reached the server");
      } finally {
        owner.host.release(noteDoc);
      }
    });

    /** A fresh album shared by `owner` and joined by `member`, with a photo each. */
    const albumScene = async (name: string) => {
      const ownerAlbum = path.join(galleryOf(owner), name);
      writeTree(ownerAlbum, { "beach.jpg": jpegWithExif(`${name}-beach`) });
      const shared = await owner.router.call("POST", ControlRoutes.albumShare, { folder: name, name, photos: [{ name: "beach.jpg" }] });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const id = (shared.body as { projectId: string }).projectId;
      const joined = await member.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, id, "revmember@example.test") });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const memberAlbum = path.join(galleryOf(member), (joined.body as { notebook: string }).notebook);
      await until(() => existsSync(path.join(memberAlbum, "beach.jpg")), "the photo reaches the member");
      writeFileSync(path.join(memberAlbum, "dog.jpg"), jpegWithExif(`${name}-dog`));
      await until(async () => (await albums(member)).find((album) => album.projectId === id)?.photos.some((photo) => photo.name === "dog.jpg" && photo.addedBy === memberAuth.account.id) === true, "the member's photo is recorded as theirs");
      await until(() => existsSync(path.join(ownerAlbum, "dog.jpg")), "the photo reaches the owner");
      await member.service.project(id)?.whenIdle();
      return { id, memberAlbum };
    };

    await t.test("C11: with no account id to be had, album cleanup keeps the member's own photos", async () => {
      const { id, memberAlbum } = await albumScene("Trip");
      memberFaults.me = true;
      const service = internals(member);
      service.cachedAccountId = null;
      await service.takeAlbumAway(service.projects.get(id)!);
      memberFaults.me = false;
      assert.ok(existsSync(path.join(memberAlbum, "dog.jpg")), "the member's own photo stays");
      assert.ok(!existsSync(path.join(memberAlbum, "beach.jpg")), "the owner's photo goes");
    });

    await t.test("M16: album cleanup still removes other members' photos when the runtime is gone", async () => {
      const { id, memberAlbum } = await albumScene("Hike");
      const service = internals(member);
      const handle = service.projects.get(id)!;
      await handle.runtime!.stop();
      handle.runtime = null;
      await service.takeAlbumAway(handle);
      assert.ok(existsSync(path.join(memberAlbum, "dog.jpg")), "the member's own photo stays");
      assert.ok(!existsSync(path.join(memberAlbum, "beach.jpg")), "the owner's photo goes");
    });

    await t.test("M16: a retried writer cleanup is not cancelled by another installation of the account in the marker", async () => {
      const { id, memberAlbum } = await albumScene("Lake");
      const service = internals(member);
      const handle = service.projects.get(id)!;
      await handle.runtime!.stop();
      handle.runtime = null;
      const markerFile = path.join(memberAlbum, MARKER);
      const marker = JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, unknown>;
      writeFileSync(markerFile, JSON.stringify({ ...marker, writer: "inst_other_device" }));
      const stat = statSync(memberAlbum);
      await service.runAlbumCleanup({
        version: 1,
        projectId: id,
        manifestDocId: handle.manifestDocId,
        ...(handle.folderId ? { folderId: handle.folderId } : {}),
        writer: true,
        root: memberAlbum,
        rootId: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs },
        remove: ["beach.jpg"],
      });
      assert.ok(!existsSync(path.join(memberAlbum, "beach.jpg")), "the cleanup ran");
      assert.ok(existsSync(path.join(memberAlbum, "dog.jpg")));
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
