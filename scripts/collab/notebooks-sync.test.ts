// Shared notebooks end to end: two real hosts (Alice shares, Bob joins)
// against the real collab server, each with its own library folder.
// Subtests run in order on the same pair of folders.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { Reconciliation, ResolvedDoc } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { ContentKeys, ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { readManifest } from "../../electron/collab/notebooks/layout";
import { createSharedDocument } from "../../electron/collab/notebooks/documents";
import {
  api,
  closePeer,
  invite,
  makePeer,
  readText,
  register,
  sameTree,
  sleep,
  snapshotTree,
  tempRoot,
  until,
  writeTree,
  type Peer,
} from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]), randomBytes(2048)]);
const diagram = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), randomBytes(512)]);

const NOTEBOOK: Record<string, string | Buffer> = {
  "README.md": "# Shared\n\nHello **world**.\n\n![diagram](_assets/README/diagram.png)\n",
  "notes/windows.md": "line one\r\nline two\r\n",
  "notes/unicode.md": "Tiếng Việt — 日本語 — 🎉\n",
  "paper/main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n",
  "paper/chapters/intro.tex": "\\section{Intro}\nSee \\cite{knuth}.\n",
  "paper/refs.bib": "@book{knuth, title={The Art of Computer Programming}, author={Knuth}, year={1968}}\n",
  "paper/figures/plot.png": png,
  "_assets/README/diagram.png": diagram,
  "a/b/c/deep.md": "deep\n",
  "empty/": "",
  "data.json": '{"a":1}\n',
  "_archive/old.md": "archived, stays local\n",
  ".libera-notebook.json": '{"emoji":"x"}\n',
};

function hubFor(peer: Peer, liberaPath: string) {
  const resolved = peer.service.resolvePath(liberaPath);
  assert.ok(resolved, `${peer.name} resolves ${liberaPath}`);
  const hub = peer.host.acquire(resolved.docId);
  return { hub, resolved, release: () => peer.host.release(resolved.docId) };
}

test("share, join and keep two notebook folders in step", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-notebooks-it-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    const aliceRoot = path.join(alice.library, "Research");
    writeTree(aliceRoot, NOTEBOOK);
    // Bob already has a notebook with the same name: the join must not touch it.
    writeTree(path.join(bob.library, "research"), { "mine.md": "Bob's own notes\n" });

    let projectId = "";
    let bobRoot = "";
    let bobNotebook = "";

    await t.test("share imports every file and writes the marker", async () => {
      const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const body = shared.body as { projectId: string; documents: number; blobs: number; folders: number; synced: boolean; notes: string[] };
      projectId = body.projectId;
      assert.equal(body.documents, 8);
      assert.equal(body.blobs, 2);
      assert.ok(body.folders >= 8);
      assert.equal(body.synced, true);
      assert.ok(body.notes.some((note) => /review comments/i.test(note)));
      const marker = JSON.parse(readFileSync(path.join(aliceRoot, ".libera-shared.json"), "utf8"));
      assert.equal(marker.projectId, projectId);
      assert.equal(marker.accountId, aliceAuth.account.id);
      assert.ok(marker.manifestDocId && marker.serverUrl && marker.sharedAt);
      assert.equal(existsSync(path.join(aliceRoot, ".libera-share-pending.json")), false);
      assert.ok(alice.events.some((event) => event.t === "share-progress" && event.progress.phase === "done"));
      assert.equal(alice.host.store.getProject(projectId)?.role, "owner");
      assert.equal(alice.host.store.listDocs(projectId).length, 8);
      const again = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
      assert.equal(again.status, 409);
    });

    await t.test("join materializes identical bytes into a fresh folder, with a suffix on a name clash", async () => {
      const link = await invite(server, aliceAuth, projectId, "bob@example.test");
      const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const body = joined.body as { notebook: string; materialized: boolean; role: string };
      assert.equal(body.notebook, "Research (2)");
      assert.equal(body.materialized, true);
      assert.equal(body.role, "editor");
      bobNotebook = body.notebook;
      bobRoot = path.join(bob.library, bobNotebook);
      assert.equal(readText(path.join(bob.library, "research"), "mine.md"), "Bob's own notes\n");
      const difference = sameTree(snapshotTree(aliceRoot), snapshotTree(bobRoot));
      assert.equal(difference, null, difference ?? "");
      assert.ok(existsSync(path.join(bobRoot, "empty")), "the empty folder exists");
      assert.equal(existsSync(path.join(bobRoot, "_archive")), false, "the archive stays local");
      assert.ok(readFileSync(path.join(bobRoot, "notes", "windows.md")).includes(Buffer.from("\r\n")), "CRLF kept");
      const resolved = bob.service.resolvePath(`${bobNotebook}/paper/refs.bib`) as ResolvedDoc;
      assert.equal(resolved.kind, "latex");
      assert.equal(resolved.readOnly, false);
      assert.equal(bob.service.resolvePath(`${bobNotebook}/paper/figures/plot.png`), null, "blobs are not documents");
      assert.equal(JSON.parse(readFileSync(path.join(bobRoot, ".libera-shared.json"), "utf8")).projectId, projectId);
    });

    await t.test("live edits materialize on the other side, and self-writes never echo", async () => {
      const { hub, release } = hubFor(alice, "Research/README.md");
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "Alice was here. "), { source: "typing" });
      release();
      await until(() => readText(bobRoot, "README.md")?.startsWith("Alice was here. ") === true, "Bob's README to update");
      await until(() => readText(aliceRoot, "README.md")?.startsWith("Alice was here. ") === true, "Alice's README to update");
      // Two poll intervals: nothing Bob wrote may come back as Bob's own edit.
      await sleep(1600);
      const bobDoc = bob.service.resolvePath(`${bobNotebook}/README.md`) as ResolvedDoc;
      const local = bob.host.store.allUpdates(bobDoc.docId).filter((row) => row.origin?.kind === "local");
      assert.equal(local.length, 0, "Bob's materializer produced no local updates");
      const aliceDoc = alice.service.resolvePath("Research/README.md") as ResolvedDoc;
      const aliceLocal = alice.host.store.allUpdates(aliceDoc.docId).filter((row) => row.origin?.kind === "local");
      assert.equal(aliceLocal.length, 1, "only Alice's typing");
    });

    await t.test("an external edit merges as minimal edits with external-file provenance", async () => {
      const file = path.join(bobRoot, "paper", "chapters", "intro.tex");
      writeFileSync(file, readFileSync(file, "utf8").replace("Intro", "Introduction"));
      await until(() => readText(aliceRoot, "paper/chapters/intro.tex")?.includes("Introduction") === true, "Alice to see Bob's disk edit");
      const doc = bob.service.resolvePath(`${bobNotebook}/paper/chapters/intro.tex`) as ResolvedDoc;
      const local = bob.host.store.allUpdates(doc.docId).filter((row) => row.origin?.kind === "local");
      assert.equal(local.length, 1);
      assert.equal(local[0].origin?.kind === "local" && local[0].origin.provenance?.source, "external-file");
      const { hub, release } = hubFor(alice, "Research/paper/chapters/intro.tex");
      assert.equal(hub.getText(), "\\section{Introduction}\nSee \\cite{knuth}.\n");
      release();
    });

    await t.test("file operations go through the manifest and both disks follow", async () => {
      const files = ControlRoutes.files(projectId);
      let result = await alice.router.call("POST", files, { op: "rename", path: "notes/unicode.md", to: "notes/renamed.md" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await alice.router.call("POST", files, { op: "create-file", path: "new/created.md", content: "# Created\r\n" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await alice.router.call("POST", files, { op: "create-folder", path: "brand-new" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await alice.router.call("POST", files, { op: "delete", path: "data.json" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await alice.router.call("POST", files, { op: "rename", path: "a", to: "alpha" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await alice.router.call("POST", files, { op: "create-file", path: "README.MD", content: "" });
      assert.equal(result.status, 409, "a case-insensitive clash is refused up front");
      assert.equal(readText(aliceRoot, "new/created.md"), "# Created\r\n");

      await until(() => readText(bobRoot, "notes/renamed.md") === NOTEBOOK["notes/unicode.md"], "Bob's rename");
      await until(() => readText(bobRoot, "new/created.md") === "# Created\r\n", "Bob's new file");
      await until(() => existsSync(path.join(bobRoot, "brand-new")), "Bob's new folder");
      await until(() => !existsSync(path.join(bobRoot, "data.json")), "Bob's delete");
      await until(() => readText(bobRoot, "alpha/b/c/deep.md") === "deep\n", "Bob's folder rename");
      assert.equal(existsSync(path.join(bobRoot, "notes", "unicode.md")), false);
      assert.equal(existsSync(path.join(bobRoot, "a")), false, "the old folder is gone");
      assert.equal(readText(bobRoot, "_archive/data.json"), '{"a":1}\n', "a remote delete is archived locally");
      await alice.service.project(projectId)?.whenIdle();
      await bob.service.project(projectId)?.whenIdle();
      const difference = sameTree(snapshotTree(aliceRoot), snapshotTree(bobRoot));
      assert.equal(difference, null, difference ?? "");
    });

    await t.test("renames, moves, deletes and new files on disk become manifest operations", async () => {
      renameSync(path.join(bobRoot, "alpha", "b", "c", "deep.md"), path.join(bobRoot, "alpha", "deep-moved.md"));
      rmSync(path.join(bobRoot, "notes", "windows.md"));
      writeFileSync(path.join(bobRoot, "bob-new.md"), "from Bob's editor\n");
      mkdirSync(path.join(bobRoot, "pictures"));
      writeFileSync(path.join(bobRoot, "pictures", "photo.png"), png.subarray(0, 900));
      await until(() => readText(aliceRoot, "alpha/deep-moved.md") === "deep\n", "Alice to see the move");
      await until(() => !existsSync(path.join(aliceRoot, "alpha", "b", "c", "deep.md")), "the old path to go");
      await until(() => !existsSync(path.join(aliceRoot, "notes", "windows.md")), "Alice to see the delete");
      await until(() => readText(aliceRoot, "bob-new.md") === "from Bob's editor\n", "Alice to get Bob's new file");
      await until(() => existsSync(path.join(aliceRoot, "pictures", "photo.png")), "Alice to get Bob's new image");
      assert.ok(readFileSync(path.join(aliceRoot, "pictures", "photo.png")).equals(png.subarray(0, 900)));
      // The move kept the document (same fileId and docId), it was not recreated.
      const moved = alice.service.resolvePath("Research/alpha/deep-moved.md") as ResolvedDoc;
      assert.ok(moved);
      const manifestHub = alice.host.acquire((JSON.parse(readFileSync(path.join(aliceRoot, ".libera-shared.json"), "utf8")) as { manifestDocId: string }).manifestDocId);
      const entries = [...readManifest(manifestHub.getDoc("manifest")).values()];
      alice.host.release(manifestHub.docId);
      assert.equal(entries.filter((entry) => entry.docId === moved.docId).length, 1);
      assert.equal(entries.filter((entry) => entry.path.endsWith("deep.md")).length, 0);
      // A binary replaced on disk becomes a new blob.
      writeFileSync(path.join(bobRoot, "paper", "figures", "plot.png"), diagram);
      await until(() => readFileSync(path.join(aliceRoot, "paper", "figures", "plot.png")).equals(diagram), "Alice to get the new image bytes");
    });

    await t.test("a concurrent external and remote edit opens a reconciliation; resolving it converges", async () => {
      const relative = "paper/main.tex";
      const file = path.join(bobRoot, ...relative.split("/"));
      const { hub, resolved, release } = hubFor(bob, `${bobNotebook}/${relative}`);
      // Disk edit and a document edit in the same instant: neither side may win silently.
      writeFileSync(file, readFileSync(file, "utf8").replace("article", "report"));
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "% shared edit\n"), { source: "typing" });
      release();
      await until(() => bob.events.some((event) => event.t === "reconcile-needed"), "a reconciliation");
      const listed = await bob.router.call("GET", ControlRoutes.reconciliations);
      const items = listed.body as Reconciliation[];
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.docId, resolved.docId);
      assert.equal(item.path, `${bobNotebook}/${relative}`);
      assert.ok(item.disk.includes("{report}") && !item.disk.includes("% shared edit"));
      assert.ok(item.shared.includes("% shared edit") && item.shared.includes("{article}"));
      assert.ok(item.base.includes("{article}") && !item.base.includes("% shared edit"));
      // Neither side is overwritten while it is open.
      await sleep(600);
      assert.ok(readText(bobRoot, relative)?.includes("{report}"));
      assert.ok(!readText(bobRoot, relative)?.includes("% shared edit"));
      assert.equal(bob.service.localProjects()[0]?.reconcilePending, 1);

      const merged = item.shared.replace("article", "report");
      const resolvedResult = await bob.router.call("POST", ControlRoutes.reconciliation(item.id), { text: merged });
      assert.equal(resolvedResult.status, 200, JSON.stringify(resolvedResult.body));
      assert.equal(readText(bobRoot, relative), merged);
      await until(() => readText(aliceRoot, relative) === merged, "Alice to converge on the merged text");
      assert.equal(((await bob.router.call("GET", ControlRoutes.reconciliations)).body as unknown[]).length, 0);
    });

    await t.test("a case-insensitive clash in the manifest gets a deterministic visible suffix", async () => {
      const marker = JSON.parse(readFileSync(path.join(aliceRoot, ".libera-shared.json"), "utf8")) as { manifestDocId: string };
      const apiClient = alice.host.api;
      assert.ok(apiClient);
      // Another client adds "readme.md" next to "README.md" (Alice's own UI would refuse it).
      await createSharedDocument(apiClient, projectId, { docId: "doc_clash_readme_lower", fileId: "fil_clash_readme_lower" }, "markdown", "lower case\n");
      const hub = alice.host.acquire(marker.manifestDocId);
      hub.applyLocalChange("manifest", (doc) =>
        doc.getMap(ManifestKeys.files).set("fil_clash_readme_lower", {
          fileId: "fil_clash_readme_lower",
          path: "readme.md",
          kind: "doc",
          docId: "doc_clash_readme_lower",
          docKind: "markdown",
          createdBy: aliceAuth.account.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      alice.host.release(marker.manifestDocId);
      for (const [root, label] of [[aliceRoot, "Alice"], [bobRoot, "Bob"]] as const) {
        await until(() => readText(root, "readme (2).md") === "lower case\n", `${label} to place the clashing file`);
        assert.ok(readText(root, "README.md")?.startsWith("Alice was here."), `${label} keeps the original`);
      }
      assert.equal(bob.service.resolvePath(`${bobNotebook}/readme (2).md`)?.docId, "doc_clash_readme_lower");
    });

    await t.test("paths that escape the notebook are refused, including through a link", async () => {
      const outside = path.join(temp.dir, "outside");
      mkdirSync(outside);
      symlinkSync(outside, path.join(bobRoot, "link"), "junction");
      const created = await alice.router.call("POST", ControlRoutes.files(projectId), { op: "create-file", path: "link/evil.md", content: "nope\n" });
      assert.equal(created.status, 200);
      const escape = await alice.router.call("POST", ControlRoutes.files(projectId), { op: "create-file", path: "../escape.md", content: "nope\n" });
      assert.equal(escape.status, 400);
      const absolute = await alice.router.call("POST", ControlRoutes.files(projectId), { op: "create-file", path: "C:/escape.md", content: "nope\n" });
      assert.equal(absolute.status, 400);
      await sleep(1500);
      assert.equal(existsSync(path.join(outside, "evil.md")), false, "nothing written through the junction");
      assert.equal(existsSync(path.join(temp.dir, "escape.md")), false);
      assert.equal(existsSync(path.join(alice.library, "escape.md")), false);
    });

    await t.test("revocation stops syncing, keeps the files and makes them read-only", async () => {
      const removed = await api(server, `/v1/projects/${projectId}/members/${bobAuth.account.id}`, undefined, aliceAuth.accessToken, "DELETE");
      assert.ok(removed.status === 204 || removed.status === 200, `remove member: ${removed.status}`);
      await until(() => bob.service.localProjects().some((project) => project.revoked), "Bob's project to be revoked");
      await until(() => JSON.parse(readFileSync(path.join(bobRoot, ".libera-shared.json"), "utf8")).revoked === true, "the marker to say revoked");
      assert.ok(bob.events.some((event) => event.t === "project-changed"));
      assert.equal(readText(bobRoot, "bob-new.md"), "from Bob's editor\n", "files are kept");
      const resolved = bob.service.resolvePath(`${bobNotebook}/README.md`);
      assert.ok(resolved);
      assert.equal(resolved.readOnly, true);
      const { hub, release } = hubFor(alice, "Research/README.md");
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "After revocation. "), { source: "typing" });
      release();
      await until(() => readText(aliceRoot, "README.md")?.startsWith("After revocation.") === true, "Alice's own file");
      await sleep(800);
      assert.ok(!readText(bobRoot, "README.md")?.startsWith("After revocation."), "Bob no longer receives edits");
      const op = await bob.router.call("POST", ControlRoutes.files(projectId), { op: "delete", path: "README.md" });
      assert.equal(op.status, 403);
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
