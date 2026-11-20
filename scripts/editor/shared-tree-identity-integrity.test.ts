import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileListEntry } from "../../src/lib/collab/local-api";
import { attachSharedFileIdTo, attachSharedFileIds, resolveSharedActionFileId } from "../../src/lib/collab/tree-file-ids";
import { createMoveFollower, keepFileIdentity, replaceNotebook, type MovedFileRead } from "../../src/lib/collab/ui/tree-changes";
import { applyFileMetadata, mergeTree } from "../../src/lib/tree-merge";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";

function file(name: string, extra: Partial<LiberaFileNode> = {}): LiberaFileNode {
  return { kind: "file", name, path: `Shared/${name}`, notebook: "Shared", fileType: "pdf", createdAt: "", updatedAt: "", size: 10, ...extra };
}
function book(children: LiberaFileNode[]): LiberaNotebookNode {
  return { kind: "notebook", name: "Shared", path: "Shared", createdAt: "", color: "", emoji: "", groupId: null, updatedAt: "", children } as unknown as LiberaNotebookNode;
}
function treeOf(notebook: LiberaNotebookNode): LiberaTree {
  return { notebooks: [notebook], notebookViewOptions: { hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: true } } as unknown as LiberaTree;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const entryOf = (name: string, fileId: string, extra: Partial<FileListEntry> = {}): FileListEntry => ({ fileId, path: `Shared/${name}`, kind: "blob", updatedAt: 0, ...extra });

async function withSharedDisk<T>(files: Record<string, string>, run: () => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-tree-identity-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const root = path.join(directory, "users/admin/Shared");
    await mkdir(root, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function spyOnReads(t: test.TestContext) {
  // tree-file-ids reads through node:fs/promises; count the reads it makes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
  return t.mock.method(fsp, "readFile");
}

test("S1: a tree load reads no bytes and gives no id by size; an action resolves the id from the bytes of that one file", async (t) => {
  await withSharedDisk({ "a.pdf": "AAAAA", "b.pdf": "BBBBB" }, async () => {
    const reads = spyOnReads(t);
    const entries = [
      entryOf("a.pdf", "id-a", { size: 5, blobHash: sha("AAAAA") }),
      entryOf("b.pdf", "id-b", { size: 5, blobHash: sha("OTHER") }), // the manifest's b is another file of the same size
    ];
    let listings = 0;
    const list = async () => { listings++; return entries; };
    const nodes = [file("a.pdf", { size: 5 }), file("b.pdf", { size: 5 })];
    await attachSharedFileIds([book(nodes)], list, () => true);
    assert.equal(reads.mock.callCount(), 0, "a tree load reads no file");
    assert.deepEqual(nodes.map((node) => [node.fileId, node.fileIdState]), [[undefined, "unknown"], [undefined, "unknown"]]);

    // An action without an id: the one file is read once and checked against the manifest entry at its path.
    assert.equal(await resolveSharedActionFileId("Shared/a.pdf", undefined, "deleted", list), "id-a");
    assert.equal(reads.mock.callCount(), 1);
    await assert.rejects(resolveSharedActionFileId("Shared/b.pdf", undefined, "deleted", list), (error: Error & { status?: number }) =>
      error.status === 409 && /still being brought up to date by sync, so it cannot be deleted yet/.test(error.message), "equal size is not identity");
    assert.equal(reads.mock.callCount(), 2);
    assert.equal(await resolveSharedActionFileId("Shared/gone.pdf", undefined, "moved", list), undefined, "no entry: the operation's own validation reports it");
    assert.equal(await resolveSharedActionFileId("Shared/doc.md", undefined, "moved", async () => [entryOf("doc.md", "id-doc", { kind: "doc" })]), "id-doc", "a document is not read");
    assert.equal(reads.mock.callCount(), 2);
    assert.equal(await resolveSharedActionFileId("Shared/absent.pdf", undefined, "moved", async () => [entryOf("absent.pdf", "id-absent", { blobHash: "x" })]), "id-absent", "not on this disk yet: the host's check guards");
    // An id the request carries is passed to the host, which does the check; nothing is listed or read.
    const listed = listings;
    assert.equal(await resolveSharedActionFileId("Shared/b.pdf", "id-seen", "deleted", list), "id-seen");
    assert.equal(listings, listed);
    assert.equal(reads.mock.callCount(), 2);

    // The checked copy is remembered: the next tree load shows its id without reading, and the next action does not read again.
    const stats = await stat(path.join(process.env.LIBERA_DATA_DIR!, "users/admin/Shared/a.pdf"));
    const again = [file("a.pdf", { size: 5, changedAt: stats.ctime.toISOString() })];
    await attachSharedFileIds([book(again)], list, () => true);
    assert.equal(again[0].fileId, "id-a");
    assert.equal(await resolveSharedActionFileId("Shared/a.pdf", undefined, "moved", list), "id-a");
    assert.equal(reads.mock.callCount(), 2);
  });
});

test("S1: opening a file verifies the bytes that read already returned; a listing timeout or a file read without bytes stays unknown", async () => {
  const entries = [entryOf("a.md", "id-a", { kind: "blob", size: 5, blobHash: sha("hello") }), entryOf("b.md", "id-b", { kind: "blob", size: 5, blobHash: sha("other") })];
  const list = async () => entries;
  const matching = file("a.md", { fileType: "markdown", size: 5, changedAt: "t1" });
  await attachSharedFileIdTo(matching, "hello", list);
  assert.equal(matching.fileId, "id-a");
  const replaced = file("b.md", { fileType: "markdown", size: 5, changedAt: "t2" });
  await attachSharedFileIdTo(replaced, "hello", list);
  assert.deepEqual([replaced.fileId, replaced.fileIdState], [undefined, "mismatch"], "another file of the same size holds the name");
  const pdf = file("a.pdf");
  await attachSharedFileIdTo(pdf, undefined, async () => [entryOf("a.pdf", "id-pdf", { blobHash: "x" })]);
  assert.deepEqual([pdf.fileId, pdf.fileIdState], [undefined, "unknown"], "no bytes were read, none are read now");
  const hung = file("a.md");
  await attachSharedFileIdTo(hung, "hello", () => new Promise<FileListEntry[]>(() => undefined), 20);
  assert.deepEqual([hung.fileId, hung.fileIdState], [undefined, "unknown"]);
  const offline = [file("a.pdf")];
  await attachSharedFileIds([book(offline)], async () => { throw new Error("host offline"); }, () => true);
  assert.equal(offline[0].fileIdState, "unknown");
  // A listing that answers after the wait is over changes nothing in the sent tree.
  let release: (value: FileListEntry[]) => void = () => undefined;
  const late = [file("a.pdf")];
  await attachSharedFileIds([book(late)], () => new Promise<FileListEntry[]>((resolve) => { release = resolve; }), () => true, 20);
  release([entryOf("a.pdf", "id-a")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([late[0].fileId, late[0].fileIdState], [undefined, "unknown"]);
});

test("S2: a refresh that could not check keeps the shown id; one that checked and found another file drops it", () => {
  const shown = treeOf(book([file("a.pdf", { fileId: "id-a" })]));
  // Incremental read with no answer from the host.
  const unknown = applyFileMetadata(shown, [{ path: "Shared/a.pdf", metadata: { node: file("a.pdf", { size: 11, fileIdState: "unknown" }) } }])!;
  assert.equal((unknown.notebooks[0].children[0] as LiberaFileNode).fileId, "id-a");
  // The path is reused: the listing answered and the bytes are another file's.
  const reused = applyFileMetadata(shown, [{ path: "Shared/a.pdf", metadata: { node: file("a.pdf", { fileIdState: "mismatch" }) } }])!;
  assert.equal((reused.notebooks[0].children[0] as LiberaFileNode).fileId, undefined);
  // A verified id of the new occupant replaces the old one.
  const replaced = applyFileMetadata(shown, [{ path: "Shared/a.pdf", metadata: { node: file("a.pdf", { fileId: "id-b" }) } }])!;
  assert.equal((replaced.notebooks[0].children[0] as LiberaFileNode).fileId, "id-b");
  // Full reads and scoped notebook reads follow the same rule.
  assert.equal((mergeTree(shown, treeOf(book([file("a.pdf", { fileIdState: "unknown" })]))).notebooks[0].children[0] as LiberaFileNode).fileId, "id-a");
  assert.equal((mergeTree(shown, treeOf(book([file("a.pdf", { fileIdState: "mismatch" })]))).notebooks[0].children[0] as LiberaFileNode).fileId, undefined);
  assert.equal((replaceNotebook(shown, book([file("a.pdf", { fileIdState: "unknown" })])).notebooks[0].children[0] as LiberaFileNode).fileId, "id-a");
});

test("S32: a tab keeps its identity across a save; a mismatch read does not keep it", () => {
  const tab = file("a.md", { fileId: "id-a" });
  assert.equal(keepFileIdentity(tab, file("a.md")).fileId, "id-a");
  assert.equal(keepFileIdentity(tab, file("a.md", { fileIdState: "mismatch" })).fileId, undefined);
  assert.equal(keepFileIdentity(tab, file("b.md")).fileId, undefined, "another path is another file");
});

type Payload = { file: { path: string; fileId?: string } };
function followerOf(world: { byPath: Map<string, Payload>; byId: Map<string, Payload | null> }, applied: { from: string; to: string; fileId?: string }[]) {
  const read: MovedFileRead<Payload> = {
    atPath: async (p) => { const found = world.byPath.get(p); if (!found) throw new Error("not on disk"); return found; },
    byId: async (id) => { const found = world.byId.get(id); if (found === undefined) throw new Error("not on disk"); return found; },
  };
  return createMoveFollower<Payload>({ read, apply: (moves) => { for (const move of moves) applied.push({ from: move.from, to: move.payload.file.path, fileId: move.fileId }); } });
}

test("S32: a destination that another file took does not take the tab; the file is found by id", async () => {
  const applied: { from: string; to: string; fileId?: string }[] = [];
  const world = {
    byPath: new Map<string, Payload>([["N/b.md", { file: { path: "N/b.md", fileId: "id-B" } }]]),
    byId: new Map<string, Payload | null>([["id-A", { file: { path: "N/c.md", fileId: "id-A" } }]]),
  };
  const follower = followerOf(world, applied);
  await follower.follow([{ from: "N/a.md", to: "N/b.md", fileId: "id-A" }]);
  assert.deepEqual(applied, [{ from: "N/a.md", to: "N/c.md", fileId: "id-A" }], "A's draft goes where A is, never onto B");
  assert.deepEqual(follower.pending(), []);
});

test("S32: a destination without a verified id is not trusted", async () => {
  const applied: { from: string; to: string; fileId?: string }[] = [];
  const world = { byPath: new Map<string, Payload>([["N/b.md", { file: { path: "N/b.md" } }]]), byId: new Map<string, Payload | null>() };
  const follower = followerOf(world, applied);
  await follower.follow([{ from: "N/a.md", to: "N/b.md", fileId: "id-A" }]);
  assert.deepEqual(applied, []);
  assert.equal(follower.pending().length, 1);
});

test("S33: a move whose destination arrives late is kept by id and replayed on the next event, with no timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const applied: { from: string; to: string; fileId?: string }[] = [];
  const world = { byPath: new Map<string, Payload>(), byId: new Map<string, Payload | null>() };
  const follower = followerOf(world, applied);
  await follower.follow([{ from: "N/a.md", to: "N/b.md", fileId: "id-A" }]);
  assert.deepEqual(applied, []);
  assert.deepEqual(follower.pending(), [{ from: "N/a.md", to: "N/b.md", fileId: "id-A" }]);
  t.mock.timers.tick(10 * 60_000);
  await follower.retry();
  assert.deepEqual(applied, [], "no timer retried it; the destination is still absent and it stays kept");
  // A later move of the same file continues from where the kept one began.
  await follower.follow([{ from: "N/b.md", to: "N/c.md", fileId: "id-A" }]);
  assert.deepEqual(follower.pending(), [{ from: "N/a.md", to: "N/c.md", fileId: "id-A" }]);
  // The file arrives: the next event replays it.
  world.byPath.set("N/c.md", { file: { path: "N/c.md", fileId: "id-A" } });
  await follower.retry();
  assert.deepEqual(applied, [{ from: "N/a.md", to: "N/c.md", fileId: "id-A" }]);
  assert.deepEqual(follower.pending(), [], "nothing is kept once applied");
  // A file the manifest no longer has is dropped, not retried forever.
  await follower.follow([{ from: "N/x.md", to: "N/y.md", fileId: "id-X" }]);
  world.byId.set("id-X", null);
  await follower.retry();
  assert.deepEqual(follower.pending(), []);
  follower.stop();
});
