// The audit viewer (plan M3.6): the owner's "Activity log" in the sharing
// dialog lists the project's audit entries from the server through the
// host's control route (a suggestion decision, a review request and
// decision), filtered by action and paged; editors get neither the section
// nor the route. AI actors are labelled with the person they acted for.

import { dom, createProject, installBridge, installRendererFetch, openWindow, startClient, statusStoreFor, until, type Client, type Window } from "./support/p3b-harness";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ControlRoutes, type AuditPage, type LocalProject } from "../../src/lib/collab/local-api";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { createReviewsApi } from "../../src/lib/collab/client/reviews";
import { auditActorLabel } from "../../src/components/libera/collab/activity-log";
import { ShareNotebookDialog } from "../../src/components/libera/collab/share-notebook-dialog";
import { removeDataDir, startServerProcess } from "./support/server-process";

after(() => dom.window.close());

const flush = async (rounds = 3) => { for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text);

async function renderDialog(client: Client, project: LocalProject) {
  setCollabStatusStore(statusStoreFor(client, [project]));
  const bridge = installBridge(client);
  const fetches = installRendererFetch(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ShareNotebookDialog, { notebook: project.notebook, onClose: () => {} })); });
  await flush();
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      bridge.remove();
      fetches.restore();
      setCollabStatusStore(null);
    },
  };
}

test("the Activity log is for owners and lists decisions and reviews", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-audit-"));
  const server = await startServerProcess();
  const clients: Client[] = [];
  const windows: Window[] = [];
  let mounted: Awaited<ReturnType<typeof renderDialog>> | null = null;
  try {
    const alice = await startClient(root, "alice", server.url);
    clients.push(alice);
    const project = await createProject(alice, "Team", server.url);
    const bob = await startClient(root, "bob", server.url, { invitationToken: await project.invite("bob@example.test", "editor") });
    clients.push(bob);
    const doc = await project.addDoc("Team/audit.md", "# Audit\n\nThe quick brown fox.\n", [[alice, "owner"], [bob, "editor"]]);
    const aliceWin = await openWindow(alice, doc, { role: "owner" });
    const bobWin = await openWindow(bob, { ...doc, role: "editor" }, { role: "editor" });
    windows.push(aliceWin, bobWin);

    // Things worth auditing: Alice accepts Bob's suggestion; Bob requests a review Alice approves.
    const quick = aliceWin.text().indexOf("quick");
    const created = bobWin.controller.suggest(quick, quick + 5, "slow");
    assert.ok(created.ok);
    await until(() => !!aliceWin.controller.group(created.ids[0]), "Alice to see the suggestion");
    assert.equal((await aliceWin.controller.decide(created.ids, "accept").settled).get(created.ids[0])?.kind, "applied");
    const bobReviews = createReviewsApi(bob.client);
    const review = await bobReviews.create(doc.docId, { scope: { kind: "document" }, assignees: [alice.userId], note: "Please check" });
    const decided = await createReviewsApi(alice.client).decide(review.id, { decision: "approved" });
    assert.equal(decided.queued, false);

    // The control route: owners only, filtered across server pages.
    const forBob = await bob.call<{ error: { code: string } }>("GET", ControlRoutes.audit(project.projectId));
    assert.equal(forBob.status, 403, "editors cannot read the audit log");
    const all = (await alice.call<AuditPage>("GET", ControlRoutes.audit(project.projectId))).body;
    assert.ok(all.entries.some((entry) => entry.action === "suggestion.decide"));
    const reviews = (await alice.call<AuditPage>("GET", `${ControlRoutes.audit(project.projectId)}?action=review`)).body;
    assert.deepEqual(reviews.entries.map((entry) => entry.action), ["review.decide", "review.request"]);
    const firstPage = (await alice.call<AuditPage>("GET", `${ControlRoutes.audit(project.projectId)}?limit=1`)).body;
    assert.equal(firstPage.entries.length, 1);
    assert.ok(firstPage.nextBefore, "more pages");
    const secondPage = (await alice.call<AuditPage>("GET", `${ControlRoutes.audit(project.projectId)}?limit=1&before=${firstPage.nextBefore}`)).body;
    assert.notEqual(secondPage.entries[0].id, firstPage.entries[0].id);

    const localProject = (role: LocalProject["role"]): LocalProject => ({ projectId: project.projectId, name: "Team", role, notebook: "Team", revoked: false, reconcilePending: 0 });

    // Bob's dialog has no Activity log.
    mounted = await renderDialog(bob, localProject("editor"));
    await until(async () => { await flush(1); return /People with access/.test(mounted!.container.ownerDocument.body.textContent ?? ""); }, "Bob's sharing dialog");
    assert.equal(/Activity log/.test(document.body.textContent ?? ""), false);
    await mounted.unmount();
    mounted = null;

    // Alice's shows the entries, labelled, and filters them.
    mounted = await renderDialog(alice, localProject("owner"));
    await until(async () => { await flush(1); return !!button(document, "Show") && /Bob/.test(document.body.textContent ?? ""); }, "Alice's dialog with members");
    await act(async () => { button(document, "Show")!.click(); });
    const list = () => document.querySelector('[aria-label="Activity"]');
    await until(async () => { await flush(1); return !!list()?.querySelector('[data-action="suggestion.decide"]'); }, "the activity list");
    const decision = list()!.querySelector('[data-action="suggestion.decide"]')!.textContent ?? "";
    assert.match(decision, /Alice decided a suggestion/);
    assert.match(decision, /applied/);
    assert.match(list()!.querySelector('[data-action="review.request"]')!.textContent ?? "", /Bob requested a review/);
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter activity"]')!;
    await act(async () => {
      select.value = "review";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await until(async () => { await flush(1); return !!list() && !list()!.querySelector('[data-action="suggestion.decide"]'); }, "the filtered list");
    assert.deepEqual([...list()!.querySelectorAll("li")].map((item) => item.getAttribute("data-action")), ["review.decide", "review.request"]);

    // AI actors carry the person they acted for.
    const names = new Map([[alice.userId, "Alice"]]);
    assert.equal(auditActorLabel({ kind: "ai", onBehalfOf: alice.userId, feature: "agent" }, names), "AI · requested by Alice");
    assert.equal(auditActorLabel(null, names), "Libera");
  } finally {
    await (mounted as Awaited<ReturnType<typeof renderDialog>> | null)?.unmount().catch(() => undefined);
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
