// Regressions for the 2026-11-20 collaboration integrity review, package H1
// (the host's explicit file operations): folder rename and delete bound to the
// reviewed descendants (S3), companions planned with the primary move (S13),
// Python code under a renamed folder (S14) and in a folder delete (S16), and
// companion saves bound to their owner file (S45). Real host and server.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { entryRecord } from "../../electron/collab/notebooks/layout";
import type { FileListResponse, FileOpRequest, FileOpResult } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, register, tempRoot, until } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const bytes = (text: string) => Buffer.from(text).toString("base64");

test("host file operations: reviewed folders, companions planned together, owner-bound companion saves", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-collab-integrity-h1-");
  const server = await startServerProcess();
  const auth = await register(server, "Alice");
  const alice = await makePeer(temp.dir, "alice", server, auth);
  try {
    const root = path.join(alice.library, "Notes");
    const write = (relative: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    };
    write("n1.md", "# one\n");
    write("n2.md", "# two\n");
    write("Drafts/a.md", "# a\n");
    write("Drafts/sub/b.md", "# b\n");
    write("_assets/n2.md/n2.py", "print(2)\n");
    write("_assets/Drafts/a.md/a.py", "print('a')\n");
    write("_assets/Drafts/sub/b.md/b.py", "print('b')\n");
    write("Other/c.md", "# c\n");
    write("_assets/Other/c.md/c.py", "print('c')\n");
    write("Gone/g.md", "# g\n");
    write("_assets/Gone/g.md/g.py", "print('g')\n");
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Notes" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const manifestDocId = JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8")).manifestDocId as string;
    const op = (request: FileOpRequest) => alice.router.call("POST", ControlRoutes.files(projectId), request);
    const ok = async (request: FileOpRequest) => {
      const result = await op(request);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body as FileOpResult;
    };
    const refused = async (request: FileOpRequest, pattern: RegExp) => {
      const result = await op(request);
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.match(JSON.stringify(result.body), pattern);
    };
    const list = async () => ((await alice.router.call("GET", ControlRoutes.fileEntries(projectId))).body as FileListResponse).entries;
    const paths = async () => (await list()).map((entry) => entry.path).sort();
    const files = async () => (await list()).filter((entry) => entry.kind !== "folder").map((entry) => entry.path);
    const idsUnder = async (prefix: string) => (await list()).filter((entry) => entry.path.startsWith(`${prefix}/`)).map((entry) => entry.fileId);
    /** Another member's entry already holding a companion slot. */
    const occupy = (slot: string) => {
      const hub = alice.host.acquire(manifestDocId);
      try {
        hub.applyLocalChange("manifest", (doc) => {
          const entry = { fileId: `fil_taken_${slot.replace(/\W/g, "_")}`, path: slot, kind: "folder" as const, createdBy: auth.account.id, createdAt: 1, updatedAt: 1 };
          doc.getMap<unknown>(ManifestKeys.files).set(entry.fileId, entryRecord(entry));
        }, { source: "typing" });
      } finally {
        alice.host.release(manifestDocId);
      }
    };
    await until(async () => (await paths()).includes("_assets/Gone/g.md/g.py"), "the notebook's files are in the manifest");

    // ---- S13: an occupied companion slot refuses the rename before anything is published.
    await ok({ op: "write-blob", path: "_ink/n1.md/p.json", contentBase64: bytes("{}") });
    occupy("_ink/n1x.md");
    const beforeInk = await paths();
    await refused({ op: "rename", path: "n1.md", to: "n1x.md" }, /ink/);
    assert.deepEqual(await paths(), beforeInk, "the refused rename published nothing");

    occupy("_assets/n2x.md/n2x.py");
    const beforePython = await paths();
    await refused({ op: "rename", path: "n2.md", to: "n2x.md" }, /Python code/);
    assert.deepEqual(await paths(), beforePython, "nothing moved for a Python slot either");

    await ok({ op: "write-blob", path: "rec.m4a", contentBase64: bytes("audio") });
    await ok({ op: "write-blob", path: "rec.m4a.transcript", contentBase64: bytes("{}") });
    occupy("recx.m4a.transcript");
    const beforeRecording = await paths();
    await refused({ op: "rename", path: "rec.m4a", to: "recx.m4a" }, /transcript/);
    assert.deepEqual(await paths(), beforeRecording, "nothing moved for a transcript slot either");

    // ---- S14: Python code follows every note of a renamed folder; an occupied slot refuses it.
    occupy("_assets/Blocked/c.md/c.py");
    const beforeFolder = await paths();
    await refused({ op: "rename", path: "Other", to: "Blocked" }, /Python code/);
    assert.deepEqual(await paths(), beforeFolder, "a folder rename with a taken Python slot published nothing");

    // ---- S3: the folder must still hold what was reviewed.
    const reviewed = await idsUnder("Drafts");
    assert.ok(reviewed.length >= 2);
    await ok({ op: "create-file", path: "Drafts/late.md", content: "added after the review\n" });
    await refused({ op: "rename", path: "Drafts", to: "Done", expectedDescendantIds: reviewed }, /changed since you reviewed/);
    await refused({ op: "delete", path: "Drafts", expectedDescendantIds: reviewed }, /changed since you reviewed/);
    assert.ok((await paths()).includes("Drafts/late.md") && (await paths()).includes("Drafts/a.md"), "a stale review changed nothing");

    const current = await idsUnder("Drafts");
    const renamed = await ok({ op: "rename", path: "Drafts", to: "Done", expectedDescendantIds: current });
    const after = await paths();
    assert.ok(after.includes("Done/a.md") && after.includes("Done/sub/b.md") && after.includes("Done/late.md"));
    assert.ok(after.includes("_assets/Done/a.md/a.py") && after.includes("_assets/Done/sub/b.md/b.py"), "Python code moved with the folder's notes");
    assert.ok(!(await files()).some((entry) => entry.startsWith("_assets/Drafts/")), "no Python code stays under the old prefix");
    const moved = new Map((renamed.moves ?? []).map((move) => [move.from, move.to]));
    assert.equal(moved.get("Notes/Drafts/a.md"), "Notes/Done/a.md");
    assert.equal(moved.get("Notes/_assets/Drafts/a.md/a.py"), "Notes/_assets/Done/a.md/a.py", "the result lists the companions too");
    assert.equal(new Set((renamed.moves ?? []).map((move) => move.fileId)).size, renamed.moves?.length, "one mapping per entry");

    // A folder replaced after the review: the old one was renamed away, a new one took its name.
    const gone = await idsUnder("Gone");
    await ok({ op: "rename", path: "Gone", to: "Gone-old" });
    await ok({ op: "create-file", path: "Gone/new.md", content: "new\n" });
    await refused({ op: "delete", path: "Gone", expectedDescendantIds: gone }, /changed since you reviewed/);
    assert.ok((await paths()).includes("Gone/new.md"), "the replacement folder was not deleted");

    // ---- S16: a folder delete takes the Python code of its notes in the same committed set.
    const olds = await idsUnder("Gone-old");
    const deleted = await ok({ op: "delete", path: "Gone-old", expectedDescendantIds: olds });
    const left = await paths();
    assert.ok(!(await files()).some((entry) => entry.startsWith("_assets/Gone-old/") || entry.startsWith("_assets/Gone/g.md")), "the deleted notes' Python code is gone from the manifest");
    assert.ok((deleted.moves ?? []).some((move) => move.from.endsWith("g.py") && move.to === null), "the result names the removed Python code");
    assert.ok(left.includes("Gone/new.md"));

    // ---- S45: a companion save is bound to its owner.
    await refused({ op: "write-blob", path: "_ink/ghost.md/p.json", contentBase64: bytes("{}") }, /not in this notebook/);
    await refused({ op: "write-blob", path: "ghost.m4a.transcript", contentBase64: bytes("{}") }, /not in this notebook/);
    const owner = (await list()).find((entry) => entry.path === "n1.md")!;
    await refused({ op: "write-blob", path: "_ink/n1.md/q.json", contentBase64: bytes("{}"), ownerFileId: "fil_other" }, /different file/);
    await ok({ op: "write-blob", path: "_ink/n1.md/q.json", contentBase64: bytes("{}"), ownerFileId: owner.fileId });
    await ok({ op: "rename", path: "n1.md", to: "n1-moved.md" });
    // A save that started before the rename must not recreate ink at the old path.
    await refused({ op: "write-blob", path: "_ink/n1.md/r.json", contentBase64: bytes("{}"), ownerFileId: owner.fileId }, /moved or removed/);
    const final = await paths();
    assert.ok(final.includes("_ink/n1-moved.md/p.json") && !final.some((entry) => entry.startsWith("_ink/n1.md")), "ink moved with its owner and nothing was recreated at the old path");
    const rec = (await list()).find((entry) => entry.path === "rec.m4a")!;
    await ok({ op: "delete", path: "rec.m4a", expectedFileId: rec.fileId });
    await refused({ op: "write-blob", path: "rec.m4a.transcript", contentBase64: bytes("{}"), ownerFileId: rec.fileId }, /moved or removed/);
    assert.ok(!(await paths()).includes("rec.m4a.transcript"));
  } finally {
    await closePeer(alice);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
