import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { registerPdfRoutes } from "../../electron/collab/control/routes-pdf";
import type { DocHub } from "../../electron/collab/core/doc-hub";
import { PdfCommentService } from "../../electron/collab/notebooks/pdf-comments";
import { pdfDocId } from "../../electron/collab/notebooks/pdf-marks";
import { ControlRoutes, type ResolvedPdf } from "../../src/lib/collab/local-api";
import { applyMarksDiff, marksOf, readAllMarks, visibleMarks } from "../../src/lib/collab/pdf/model";
import { api, closePeer, invite, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";
import type { PdfAnnotation, PdfHighlightAnnotation, PdfTextAnnotation } from "../../src/lib/types";

const PDF = Buffer.from("%PDF-1.4\n% a paper\n%%EOF\n");
const FAST = { timings: { pdfWriteMs: 40 } };

function highlight(id: string, color = "#fde047"): PdfHighlightAnnotation {
  return { id, type: "highlight", pageNumber: 1, color, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "words", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
}

function note(id: string, text: string): PdfTextAnnotation {
  return { id, type: "text", pageNumber: 1, text, fontSize: 10, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
}

const sidecarPath = (root: string, file: string) => path.join(root, ".libera", "annotations", "pdf", "by-path", `${file}.json`);

function writeSidecar(root: string, file: string, annotations: PdfAnnotation[], extra: Record<string, unknown> = {}) {
  const target = sidecarPath(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ annotations, ...extra }));
}

const readSidecar = (root: string, file: string) => JSON.parse(readFileSync(sidecarPath(root, file), "utf8")) as { annotations: PdfAnnotation[]; sharedCopy?: string };

async function resolvePdf(peer: Peer, liberaPath: string): Promise<ResolvedPdf | null> {
  return peer.service.resolvePdf(liberaPath);
}

const marksIn = (hub: DocHub) => visibleMarks(readAllMarks(hub.getDoc("annotations")));

function change(hub: DocHub, accountId: string, update: (marks: PdfAnnotation[]) => PdfAnnotation[]) {
  const before = marksIn(hub);
  hub.applyLocalChange("annotations", (doc) => { applyMarksDiff(doc, before, update(before), { accountId }, null); });
}

interface Pair {
  server: ServerProcess;
  owner: Peer;
  member: Peer;
  projectId: string;
  ownerRoot: string;
  memberRoot: string;
  memberNotebook: string;
  cleanup(): Promise<void>;
}

async function pair(prefix: string, files: Record<string, string | Buffer>, role = "commenter", sidecars?: (root: string) => void, pdfWriteMs = 40): Promise<Pair> {
  const temp = tempRoot(prefix);
  const server = await startServerProcess();
  const ownerAuth = await register(server, "Owner");
  const memberAuth = await register(server, "Member");
  const owner = await makePeer(temp.dir, "owner", server, ownerAuth, { timings: { ...FAST.timings, pdfWriteMs } });
  const member = await makePeer(temp.dir, "member", server, memberAuth, { timings: { ...FAST.timings, pdfWriteMs } });
  const ownerRoot = path.join(owner.library, "Papers");
  writeTree(ownerRoot, files);
  sidecars?.(ownerRoot);
  const shared = await owner.router.call("POST", ControlRoutes.share, { notebook: "Papers" });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const { projectId } = shared.body as { projectId: string };
  const link = await invite(server, ownerAuth, projectId, "member@example.test", role);
  const joined = await member.router.call("POST", ControlRoutes.join, { invitation: link });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const memberNotebook = (joined.body as { notebook: string }).notebook;
  return {
    server, owner, member, projectId, ownerRoot, memberNotebook, memberRoot: path.join(member.library, memberNotebook),
    cleanup: async () => {
      await closePeer(owner).catch(() => undefined);
      await closePeer(member).catch(() => undefined);
      await server.stop();
      removeDataDir(server.dataDir);
      temp.cleanup();
    },
  };
}

async function enable(setup: Pair) {
  const enabled = await setup.owner.router.call("POST", ControlRoutes.pdfLive(setup.projectId));
  assert.equal(enabled.status, 204, JSON.stringify(enabled.body));
  await until(async () => (await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`)) !== null, "the member sees live PDFs");
}

test("live PDFs stay off until the owner turns them on, and only the owner can", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-off-", { "paper.pdf": PDF, "note.md": "hello\n" }, "editor");
  try {
    assert.equal(await resolvePdf(setup.owner, "Papers/paper.pdf"), null);
    const refused = await setup.member.router.call("POST", ControlRoutes.pdfLive(setup.projectId));
    assert.equal(refused.status, 403);
    const before = setup.member.events.length;
    await enable(setup);
    await until(() => setup.member.events.slice(before).some((event) => event.t === "project-changed" && event.projectId === setup.projectId), "F2: the settings-only activation notifies the other renderer");
    assert.ok(await resolvePdf(setup.owner, "Papers/paper.pdf"));
    assert.equal(await resolvePdf(setup.owner, "Papers/note.md"), null);
    assert.equal(setup.owner.service.localProjects()[0].pdfLive, true);
  } finally {
    await setup.cleanup();
  }
});

test("marks reach the other person, in both directions, and the sidecar becomes a copy", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-live-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const theirs = (await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`)) as ResolvedPdf;
    assert.equal(mine.docId, theirs.docId);
    assert.equal(mine.docId, pdfDocId(setup.projectId, mine.fileId));
    assert.equal(theirs.readOnly, false, "a commenter can annotate");
    const ownerHub = setup.owner.host.acquire(mine.docId);
    const memberHub = setup.member.host.acquire(theirs.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote" && memberHub.getStatus().state === "saved-remote", "both opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("h1")]);
    await until(() => marksIn(memberHub).length === 1, "the commenter sees the mark");
    change(memberHub, setup.member.auth.account.id, (marks) => marks.map((mark) => ({ ...mark, color: "#22c55e" }) as PdfAnnotation));
    await until(() => (marksIn(ownerHub)[0] as PdfHighlightAnnotation).color === "#22c55e", "the owner sees the commenter's change");
    await until(() => existsSync(sidecarPath(setup.memberRoot, "paper.pdf")) && readSidecar(setup.memberRoot, "paper.pdf").annotations.length === 1, "the copy is written");
    assert.equal(readSidecar(setup.memberRoot, "paper.pdf").sharedCopy, theirs.docId);
    setup.owner.host.release(mine.docId);
    setup.member.host.release(theirs.docId);
  } finally {
    await setup.cleanup();
  }
});

test("a viewer sees marks but cannot change them", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-viewer-", { "paper.pdf": PDF }, "viewer");
  try {
    await enable(setup);
    const theirs = (await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`)) as ResolvedPdf;
    assert.equal(theirs.readOnly, true);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    const memberHub = setup.member.host.acquire(theirs.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote", "opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("h1")]);
    await until(() => marksIn(memberHub).length === 1, "the viewer sees the mark");
    setup.owner.host.release(mine.docId);
    setup.member.host.release(theirs.docId);
  } finally {
    await setup.cleanup();
  }
});

test("existing sidecars merge once, from every person who has one, without bringing deletions back", { timeout: 90_000 }, async () => {
  const setup = await pair("libera-pdf-import-", { "paper.pdf": PDF }, "commenter", (root) => writeSidecar(root, "paper.pdf", [highlight("from-owner"), note("note-owner", "written alone")]));
  try {
    writeSidecar(setup.memberRoot, "paper.pdf", [highlight("from-member")]);
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(() => marksIn(ownerHub).length === 3, "both sidecars merged");
    assert.equal((marksIn(ownerHub).find((mark) => mark.id === "note-owner") as PdfTextAnnotation).text, "written alone");
    change(ownerHub, setup.owner.auth.account.id, (marks) => marks.filter((mark) => mark.id !== "from-owner"));
    await until(() => readAllMarks(ownerHub.getDoc("annotations")).filter((record) => record.deleted).length === 1, "deleted");
    await until(() => ownerHub.getStatus().state === "saved-remote", "acked");
    await until(() => readSidecar(setup.ownerRoot, "paper.pdf").sharedCopy === mine.docId && readSidecar(setup.ownerRoot, "paper.pdf").annotations.length === 2, "copy written");
    setup.owner.host.release(mine.docId);

    // An old build on a synced device rewrites the sidecar with the mark back in it, and a new mark.
    await closePeer(setup.owner);
    writeSidecar(setup.ownerRoot, "paper.pdf", [highlight("from-owner"), highlight("from-old-build")]);
    const restarted = await makePeer(path.dirname(path.dirname(path.dirname(setup.owner.library))), "owner", setup.server, setup.owner.auth, { ...FAST, library: setup.owner.library });
    setup.owner = restarted;
    await until(async () => (await resolvePdf(restarted, "Papers/paper.pdf")) !== null, "restarted");
    const hub = restarted.host.acquire(mine.docId);
    await until(() => marksIn(hub).some((mark) => mark.id === "from-old-build"), "the unseen mark is added");
    assert.equal(marksIn(hub).some((mark) => mark.id === "from-owner"), false, "the deleted mark stays deleted");
    restarted.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("a viewer's private sidecar is neither merged nor overwritten", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-private-", { "paper.pdf": PDF }, "viewer");
  try {
    writeSidecar(setup.memberRoot, "paper.pdf", [highlight("private")]);
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote", "opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("shared")]);
    await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`);
    await sleep(500);
    assert.deepEqual(readSidecar(setup.memberRoot, "paper.pdf").annotations.map((mark) => mark.id), ["private"]);
    assert.equal(marksIn(ownerHub).some((mark) => mark.id === "private"), false);
    setup.owner.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("a rename keeps the marks, and deleting the PDF closes its document", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-lifecycle-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote", "opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("h1")]);
    await until(() => ownerHub.getStatus().state === "saved-remote", "acked");

    await setup.owner.service.fileOp(setup.projectId, { op: "rename", path: "paper.pdf", to: "renamed.pdf" });
    await until(async () => (await resolvePdf(setup.owner, "Papers/renamed.pdf"))?.docId === mine.docId, "the rename keeps the document");
    await until(async () => (await resolvePdf(setup.member, `${setup.memberNotebook}/renamed.pdf`))?.docId === mine.docId, "the rename reaches the member");
    const memberHub = setup.member.host.acquire(mine.docId);
    await until(() => marksIn(memberHub).length === 1, "the member reads the same marks at the new name");

    await setup.owner.service.fileOp(setup.projectId, { op: "delete", path: "renamed.pdf" });
    await until(() => ownerHub.getMeta().readOnlyReason === "document-deleted" || setup.owner.service.project(setup.projectId)?.pdfs.openCount === 0, "the document closes");
    await until(async () => (await resolvePdf(setup.member, `${setup.memberNotebook}/renamed.pdf`)) === null, "gone for the member");
    setup.owner.host.release(mine.docId);
    setup.member.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("offline marks on both sides merge when the connection returns", { timeout: 90_000 }, async () => {
  const setup = await pair("libera-pdf-offline-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    const memberHub = setup.member.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote" && memberHub.getStatus().state === "saved-remote", "opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, note("n", "hello")]);
    await until(() => marksIn(memberHub).length === 1, "shared");

    const account = { accountId: setup.member.auth.account.id };
    const connected = (setup.member.host as unknown as { options: unknown; account: unknown });
    const saved = connected.account;
    setup.member.host.setAccount(null);
    await until(() => memberHub.getStatus().state !== "saved-remote", "the member is offline");
    change(memberHub, account.accountId, (marks) => [...marks.map((mark) => ({ ...mark, text: "hello from offline" }) as PdfAnnotation), highlight("offline-mark")]);
    change(ownerHub, setup.owner.auth.account.id, (marks) => marks.map((mark) => ({ ...mark, text: "well, hello" }) as PdfAnnotation));
    await sleep(200);
    assert.equal(marksIn(ownerHub).some((mark) => mark.id === "offline-mark"), false);

    setup.member.host.setAccount(saved as Parameters<typeof setup.member.host.setAccount>[0]);
    await until(() => marksIn(ownerHub).length === 2 && marksIn(memberHub).length === 2, "both sides have both marks");
    await until(() => (marksIn(ownerHub).find((mark) => mark.id === "n") as PdfTextAnnotation).text === (marksIn(memberHub).find((mark) => mark.id === "n") as PdfTextAnnotation).text, "the note converges");
    assert.match((marksIn(ownerHub).find((mark) => mark.id === "n") as PdfTextAnnotation).text, /well/);
    assert.match((marksIn(ownerHub).find((mark) => mark.id === "n") as PdfTextAnnotation).text, /offline/);
    setup.owner.host.release(mine.docId);
    setup.member.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("marks made before anyone else opened the PDF, while offline, make the document when back", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-first-offline-", { "paper.pdf": PDF, "other.pdf": Buffer.from("%PDF-1.4 other\n") });
  try {
    await enable(setup);
    const saved = (setup.owner.host as unknown as { account: unknown }).account;
    setup.owner.host.setAccount(null);
    const mine = (await resolvePdf(setup.owner, "Papers/other.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("before-the-document-existed")]);
    assert.equal(marksOf(ownerHub.getDoc("annotations")).size, 1);
    setup.owner.host.setAccount(saved as Parameters<typeof setup.owner.host.setAccount>[0]);
    await until(() => ownerHub.getStatus().state === "saved-remote", "synced");
    const memberHub = setup.member.host.acquire(((await resolvePdf(setup.member, `${setup.memberNotebook}/other.pdf`)) as ResolvedPdf).docId);
    await until(() => marksIn(memberHub).length === 1, "the member receives it");
    setup.owner.host.release(mine.docId);
    setup.member.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("leaving keeps the last state as an ordinary sidecar", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-leave-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote", "opened");
    change(ownerHub, setup.owner.auth.account.id, (marks) => [...marks, highlight("kept")]);
    const memberHub = setup.member.host.acquire(((await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`)) as ResolvedPdf).docId);
    await until(() => marksIn(memberHub).length === 1, "received");
    setup.member.host.release(mine.docId);
    await setup.member.service.project(setup.projectId)?.stop({ preserveContent: true });
    const sidecar = readSidecar(setup.memberRoot, "paper.pdf");
    assert.deepEqual(sidecar.annotations.map((mark) => mark.id), ["kept"]);
    assert.equal(sidecar.sharedCopy, undefined);
    setup.owner.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});


const anchor = { segments: [{ pageNumber: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }] }], quote: "a passage" };
const comments = (peer: Peer) => new PdfCommentService(peer.host, () => peer.auth.account.id);

test("comments are shared threads with authors, and only the author edits", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-comments-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`);
    const ownerHub = setup.owner.host.acquire(mine.docId);
    const memberHub = setup.member.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote" && memberHub.getStatus().state === "saved-remote", "opened");
    const [thread] = await comments(setup.owner).change(mine.docId, { action: "comment", anchor, text: "Is this right?" });
    assert.equal(thread.messages[0].own, true);
    assert.equal(thread.messages[0].authorName, "Owner");
    await until(async () => (await comments(setup.member).list(mine.docId)).length === 1, "the commenter sees the thread");
    const seen = (await comments(setup.member).list(mine.docId))[0];
    assert.deepEqual(seen.anchor.quote, "a passage");
    assert.equal(seen.messages[0].own, false);
    const replied = await comments(setup.member).change(mine.docId, { action: "reply", threadId: seen.id, text: "Yes." });
    assert.equal(replied[0].messages.length, 2);
    await comments(setup.owner).change(mine.docId, { action: "resolve", threadId: seen.id, resolved: true });
    assert.equal((await comments(setup.member).list(mine.docId))[0].status, "resolved");
    await assert.rejects(comments(setup.member).change(mine.docId, { action: "edit", threadId: seen.id, messageId: seen.messages[0].id, text: "Not mine" }));
    setup.owner.host.release(mine.docId);
    setup.member.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("comments written offline show as pending, then land", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-comments-offline-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(() => ownerHub.getStatus().state === "saved-remote", "opened");
    const service = comments(setup.owner);
    const [online] = await service.change(mine.docId, { action: "comment", anchor, text: "Online" });
    const saved = (setup.owner.host as unknown as { account: unknown }).account;
    setup.owner.host.setAccount(null);
    const threads = await service.change(mine.docId, { action: "comment", anchor, text: "Offline" });
    assert.equal(threads.length, 2, "the cached thread and the queued one");
    assert.equal(threads.find((thread) => thread.id !== online.id)?.pending, true);
    const replied = await service.change(mine.docId, { action: "reply", threadId: online.id, text: "Offline reply" });
    assert.equal(replied.find((thread) => thread.id === online.id)?.messages.at(-1)?.pending, true);
    setup.owner.host.setAccount(saved as Parameters<typeof setup.owner.host.setAccount>[0]);
    await until(async () => {
      const list = await comments(setup.member).list(mine.docId);
      return list.length === 2 && list.find((thread) => thread.id === online.id)?.messages.length === 2;
    }, "the queue drains");
    setup.owner.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("local comments become threads once, even from two devices", { timeout: 60_000 }, async () => {
  const local = [{ id: "local-1", anchor, status: "resolved", messages: [{ id: "m1", text: "First", createdAt: "2026-01-01T00:00:00.000Z" }, { id: "m2", text: "Second", createdAt: "2026-01-02T00:00:00.000Z" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }];
  const setup = await pair("libera-pdf-comments-import-", { "paper.pdf": PDF }, "commenter", (root) => writeSidecar(root, "paper.pdf", [], { comments: local }));
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf;
    await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`);
    const ownerHub = setup.owner.host.acquire(mine.docId);
    await until(async () => {
      const list = await comments(setup.owner).list(mine.docId);
      return list.length === 1 && list[0].messages.length === 2 && list[0].status === "resolved";
    }, "the comment arrives as a thread");
    await Promise.all([comments(setup.owner).importLocal(mine.docId, local as never), comments(setup.member).importLocal(mine.docId, local as never)]);
    await sleep(600);
    const list = await comments(setup.owner).list(mine.docId);
    assert.equal(list.length, 1);
    assert.equal(list[0].messages.length, 2);
    assert.ok(ownerHub);
    setup.owner.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("marks made offline survive a restart of the host, and land afterwards", { timeout: 90_000 }, async () => {
  const setup = await pair("libera-pdf-restart-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`)) as ResolvedPdf;
    const memberHub = setup.member.host.acquire(mine.docId);
    await until(() => memberHub.getStatus().state === "saved-remote", "opened");
    const saved = (setup.member.host as unknown as { account: unknown }).account;
    setup.member.host.setAccount(null);
    change(memberHub, setup.member.auth.account.id, (marks) => [...marks, highlight("while-offline"), note("n", "typed offline")]);
    setup.member.host.release(mine.docId);
    await closePeer(setup.member);
    void saved;
    const restarted = await makePeer(path.dirname(path.dirname(path.dirname(setup.member.library))), "member", setup.server, setup.member.auth, { ...FAST, library: setup.member.library });
    setup.member = restarted;
    const ownerHub = setup.owner.host.acquire(((await resolvePdf(setup.owner, "Papers/paper.pdf")) as ResolvedPdf).docId);
    await until(() => marksIn(ownerHub).length === 2, "the queued marks reach the owner");
    setup.owner.host.release(mine.docId);
  } finally {
    await setup.cleanup();
  }
});

test("a new PDF arriving with a sidecar merges it, even one copied from another PDF's document", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-arrival-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    writeSidecar(setup.ownerRoot, "copy.pdf", [highlight("came-with-the-copy")], { sharedCopy: "pdf_some_other_document" });
    writeFileSync(path.join(setup.ownerRoot, "copy.pdf"), Buffer.from("%PDF-1.4 a copy\n"));
    await until(() => resolvePdf(setup.owner, "Papers/copy.pdf").then((value) => value !== null), "the copy is in the manifest");
    const copy = (await resolvePdf(setup.owner, "Papers/copy.pdf")) as ResolvedPdf;
    const hub = setup.owner.host.acquire(copy.docId);
    await until(() => marksIn(hub).some((mark) => mark.id === "came-with-the-copy"), "the copy's marks are its own");
    setup.owner.host.release(copy.docId);
  } finally {
    await setup.cleanup();
  }
});


test("F10: revocation before the sidecar debounce exports the latest marks", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-revoke-", { "paper.pdf": PDF }, "commenter", undefined, 60_000);
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.member, `${setup.memberNotebook}/paper.pdf`))!;
    const hub = setup.member.host.acquire(mine.docId);
    await until(() => hub.getStatus().state === "saved-remote", "opened");
    change(hub, setup.member.auth.account.id, (marks) => [...marks, note("latest-at-revoke", "kept before debounce")]);
    assert.equal(existsSync(sidecarPath(setup.memberRoot, "paper.pdf")), false);
    const response = await api(setup.server, `/v1/projects/${setup.projectId}/members/${setup.member.auth.account.id}`, undefined, setup.owner.auth.accessToken, "DELETE");
    assert.equal(response.status, 204);
    await until(() => setup.member.service.localProjects().some((project) => project.revoked), "revocation finishes");
    const sidecar = readSidecar(setup.memberRoot, "paper.pdf");
    assert.equal(sidecar.sharedCopy, undefined);
    assert.equal((sidecar.annotations.find((mark) => mark.id === "latest-at-revoke") as PdfTextAnnotation).text, "kept before debounce");
    setup.member.host.release(mine.docId);
  } finally { await setup.cleanup(); }
});

test("F11: a later external sidecar adds unseen ids before the next copy replaces it", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-later-sidecar-", { "paper.pdf": PDF });
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf"))!;
    const hub = setup.owner.host.acquire(mine.docId);
    await until(() => hub.getStatus().state === "saved-remote", "opened");
    change(hub, setup.owner.auth.account.id, () => [highlight("deleted"), highlight("current")]);
    await until(() => existsSync(sidecarPath(setup.ownerRoot, "paper.pdf")), "initial copy");
    change(hub, setup.owner.auth.account.id, (marks) => marks.filter((mark) => mark.id !== "deleted"));
    await until(() => readSidecar(setup.ownerRoot, "paper.pdf").annotations.length === 1, "deletion copied");
    writeSidecar(setup.ownerRoot, "paper.pdf", [highlight("deleted"), highlight("late-from-cloud")]);
    change(hub, setup.owner.auth.account.id, (marks) => marks.map((mark) => ({ ...mark, color: "#22c55e" }) as PdfAnnotation));
    await until(() => marksIn(hub).some((mark) => mark.id === "late-from-cloud"), "late work reaches shared state");
    await until(() => readSidecar(setup.ownerRoot, "paper.pdf").annotations.some((mark) => mark.id === "late-from-cloud"), "late work survives replacement");
    assert.equal(marksIn(hub).some((mark) => mark.id === "deleted"), false);
    assert.equal((marksIn(hub).find((mark) => mark.id === "current") as PdfHighlightAnnotation).color, "#22c55e");
    setup.owner.host.release(mine.docId);
  } finally { await setup.cleanup(); }
});

test("F12: a copied PDF is seeded from the host snapshot before anyone can open it", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-copy-", { "paper.pdf": PDF }, "commenter", undefined, 60_000);
  try {
    await enable(setup);
    const source = (await resolvePdf(setup.owner, "Papers/paper.pdf"))!;
    const hub = setup.owner.host.acquire(source.docId);
    await until(() => hub.getStatus().state === "saved-remote", "opened");
    change(hub, setup.owner.auth.account.id, () => [note("fresh", "not on disk yet")]);
    assert.equal(existsSync(sidecarPath(setup.ownerRoot, "paper.pdf")), false);
    registerPdfRoutes(setup.owner.router as never, { host: setup.owner.host, accounts: { account: setup.owner.auth.account } } as never);
    const snapshot = await setup.owner.router.call("GET", ControlRoutes.pdfSnapshot(source.docId));
    assert.equal(snapshot.status, 200);
    const marks = (snapshot.body as { marks: PdfAnnotation[] }).marks.map((mark) => ({ ...mark, id: "fresh-copy" }));
    await setup.owner.service.fileOp(setup.projectId, { op: "write-blob", path: "copy.pdf", contentBase64: PDF.toString("base64"), createOnly: true, pdfSeed: { marks } });
    const copied = (await resolvePdf(setup.owner, "Papers/copy.pdf"))!;
    const destination = setup.owner.host.acquire(copied.docId);
    await until(() => marksIn(destination).length === 1, "the destination already has the live mark");
    assert.notEqual(copied.fileId, source.fileId);
    assert.equal((marksIn(destination)[0] as PdfTextAnnotation).text, "not on disk yet");
    await until(async () => Boolean(await resolvePdf(setup.member, `${setup.memberNotebook}/copy.pdf`)), "the copy reaches the manifest");
    const remote = (await resolvePdf(setup.member, `${setup.memberNotebook}/copy.pdf`))!;
    const memberHub = setup.member.host.acquire(remote.docId);
    await until(() => marksIn(memberHub).length === 1, "the first remote open includes the copied mark");
    setup.owner.host.release(source.docId);
    setup.owner.host.release(copied.docId);
    setup.member.host.release(remote.docId);
  } finally { await setup.cleanup(); }
});

test("F15/F16: sidecar imports keep their original source hash and isolate invalid records", { timeout: 60_000 }, async () => {
  const invalid = { ...note("invalid-local", "x".repeat(10_001)), updatedAt: "invalid" };
  const setup = await pair("libera-pdf-import-validation-", { "paper.pdf": PDF }, "commenter", (root) => writeSidecar(root, "paper.pdf", [highlight("old-version"), invalid], { source: { size: 123, contentHash: "b".repeat(64) } }));
  try {
    await enable(setup);
    const mine = (await resolvePdf(setup.owner, "Papers/paper.pdf"))!;
    const hub = setup.owner.host.acquire(mine.docId);
    await until(() => marksIn(hub).length === 1, "the valid record imports");
    assert.equal(marksOf(hub.getDoc("annotations")).get("old-version")!.get("sourceHash"), "b".repeat(64));
    assert.notEqual(mine.blobHash, "b".repeat(64));
    assert.equal(marksOf(hub.getDoc("annotations")).has("invalid-local"), false);
    await until(() => existsSync(path.join(setup.ownerRoot, ".libera", "collab", "rejected-pdf")), "invalid sidecar remains recoverable");
    assert.equal(hub.getStatus().state, "saved-remote", "the queue was never poisoned");
    setup.owner.host.release(mine.docId);
  } finally { await setup.cleanup(); }
});


test("F17: a queued first comment waits for PDF open instead of settling a 404", { timeout: 60_000 }, async () => {
  const setup = await pair("libera-pdf-command-open-", { "paper.pdf": PDF, "unopened.pdf": PDF });
  try {
    await enable(setup);
    const saved = (setup.owner.host as unknown as { account: Parameters<typeof setup.owner.host.setAccount>[0] }).account;
    setup.owner.host.setAccount(null);
    const target = (await resolvePdf(setup.owner, "Papers/unopened.pdf"))!;
    const hub = setup.owner.host.acquire(target.docId);
    const canSync = hub.canSync;
    hub.canSync = () => false;
    await comments(setup.owner).change(target.docId, { action: "comment", anchor, text: "first while offline" });
    assert.equal(setup.owner.host.commands.list().length, 1);
    setup.owner.host.setAccount(saved);
    await until(() => setup.owner.host.connectionState === "connected", "socket connects before PDF open");
    await sleep(300);
    assert.equal(setup.owner.host.commands.list().length, 1, "the durable command survives the missing server document");
    assert.equal(hub.hasOpened, false);
    hub.canSync = canSync;
    setup.owner.host.setAccount(null);
    setup.owner.host.setAccount(saved);
    await until(() => hub.hasOpened, "the delayed PDF open is acknowledged");
    setup.owner.host.commands.setOnline(true);
    await until(async () => setup.owner.host.commands.list().length === 0 && (await comments(setup.owner).list(target.docId)).some((thread) => thread.messages[0]?.text === "first while offline"), "the comment lands after open");
    setup.owner.host.release(target.docId);
  } finally { await setup.cleanup(); }
});
