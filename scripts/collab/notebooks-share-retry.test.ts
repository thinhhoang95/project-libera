// An interrupted share, retried, completes without duplicate projects,
// documents or manifest entries, and keeps edits made in between.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { DocumentInfo, ProjectSummary } from "../../src/lib/collab/protocol/api";
import { readManifest } from "../../electron/collab/notebooks/layout";
import type { FetchLike } from "../../electron/collab/core";
import { api, closePeer, invite, makePeer, readText, register, sameTree, snapshotTree, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("an interrupted share is retried to completion without duplicates", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-notebooks-retry-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");

    // Failure injection on Alice's REST traffic.
    let documentCreates = 0;
    let failAfterDocuments = Number.POSITIVE_INFINITY;
    let dropProjectResponse = false;
    const flaky: FetchLike = async (url, init) => {
      const isDocumentCreate = init.method === "POST" && /\/documents$/.test(new URL(url).pathname);
      const isProjectCreate = init.method === "POST" && new URL(url).pathname === "/v1/projects";
      if (isDocumentCreate) {
        documentCreates += 1;
        if (documentCreates > failAfterDocuments) throw new TypeError("fetch failed (injected)");
      }
      const response = await fetch(url, init);
      if (isProjectCreate && dropProjectResponse) {
        dropProjectResponse = false;
        // The server created the project, but the answer never arrives.
        throw new TypeError("connection reset (injected)");
      }
      return response;
    };
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth, { fetch: flaky });
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    const root = path.join(alice.library, "Thesis");
    const files: Record<string, string | Buffer> = {
      "one.md": "one\n",
      "two.md": "two\n",
      "three.md": "three\n",
      "four.tex": "\\section{Four}\n",
      "five.bib": "@misc{five}\n",
      "img/pic.png": Buffer.from([1, 2, 3, 4, 0, 5, 6]),
    };
    writeTree(root, files);

    // Attempt 1: the project is created but its answer is lost.
    dropProjectResponse = true;
    let result = await alice.router.call("POST", ControlRoutes.share, { notebook: "Thesis" });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.ok(existsSync(path.join(root, ".libera-share-pending.json")), "the plan survives the failure");
    assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);

    // Attempt 2: dies after two documents.
    failAfterDocuments = documentCreates + 2;
    result = await alice.router.call("POST", ControlRoutes.share, { notebook: "Thesis" });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    const plan = JSON.parse(readFileSync(path.join(root, ".libera-share-pending.json"), "utf8")) as { projectId?: string; files: Array<{ path: string; docId?: string; uploaded?: boolean }> };
    assert.ok(plan.projectId, "the orphaned project was found and recorded");
    assert.equal(plan.files.filter((file) => file.uploaded).length, 2);

    // An edit between attempts, to a document the server already has.
    const uploaded = plan.files.find((file) => file.uploaded && file.docId);
    assert.ok(uploaded);
    writeFileSync(path.join(root, uploaded.path), "edited between attempts\n");

    // Attempt 3 succeeds.
    failAfterDocuments = Number.POSITIVE_INFINITY;
    result = await alice.router.call("POST", ControlRoutes.share, { notebook: "Thesis" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const projectId = (result.body as { projectId: string }).projectId;
    assert.equal(projectId, plan.projectId);
    assert.equal(existsSync(path.join(root, ".libera-share-pending.json")), false);

    const projects = await api<ProjectSummary[]>(server, "/v1/projects", undefined, aliceAuth.accessToken);
    assert.equal(projects.body.filter((project) => project.name === "Thesis").length, 1, "one project");
    const marker = JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8")) as { manifestDocId: string };
    const hub = alice.host.acquire(marker.manifestDocId);
    const entries = [...readManifest(hub.getDoc("manifest")).values()];
    alice.host.release(marker.manifestDocId);
    assert.equal(entries.length, 7, "five documents, one blob, one folder");
    assert.equal(new Set(entries.map((entry) => entry.path)).size, 7);
    // The documents created before the failure kept their ids (no second copy).
    const plannedDocs = new Map(plan.files.map((file) => [file.path, file.docId]));
    const docEntries = entries.filter((entry) => entry.kind === "doc");
    assert.equal(docEntries.length, 5, "one document per text file");
    for (const entry of docEntries) {
      assert.equal(entry.docId, plannedDocs.get(entry.path), `${entry.path} kept its planned id`);
      const info = await api<DocumentInfo>(server, `/v1/documents/${entry.docId}`, undefined, aliceAuth.accessToken);
      assert.equal(info.status, 200);
    }

    // The edit made between attempts reaches the shared document.
    await until(() => {
      const resolved = alice.service.resolvePath(`Thesis/${uploaded.path}`);
      if (!resolved) return false;
      const docHub = alice.host.acquire(resolved.docId);
      const text = docHub.getText();
      alice.host.release(resolved.docId);
      return text === "edited between attempts\n";
    }, "the in-between edit to sync");

    const link = await invite(server, aliceAuth, projectId, "bob@example.test", "viewer");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bobRoot = path.join(bob.library, (joined.body as { notebook: string }).notebook);
    await until(() => readText(bobRoot, uploaded.path) === "edited between attempts\n", "Bob to get the edited text");
    const difference = sameTree(snapshotTree(root), snapshotTree(bobRoot));
    assert.equal(difference, null, difference ?? "");

    // Bob is a viewer: file operations are refused, and his disk edits stay local.
    const refused = await bob.router.call("POST", ControlRoutes.files(projectId), { op: "delete", path: "one.md" });
    assert.equal(refused.status, 403);
    assert.equal(bob.service.resolvePath(`${(joined.body as { notebook: string }).notebook}/one.md`)?.readOnly, true);
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
