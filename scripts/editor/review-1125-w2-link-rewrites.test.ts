import assert from "node:assert/strict";
import test from "node:test";
import { moveItemLinks } from "../../src/components/libera/batch-move-links";
import { announceTextReplaced, forgetPublished, onTextReplaced } from "../../src/components/libera/link-rewrite-echo";
import { reviewPathsTouchedBy, reviewsMovedAffect, trackLeavingWrite } from "../../src/components/libera/reviews-moved";
import { createSaveQueue } from "../../src/components/libera/tab-retarget";
import { agentReviewStore } from "../../src/lib/agent-review/store";
import type { LiberaLinkRewrites } from "../../src/lib/types";

// These tests exercise renderer-side helpers; no notebook is changed on disk, so assertNotebookSound has nothing to check here.

const links = (...paths: string[]): LiberaLinkRewrites => ({
  rewritten: paths.map((path) => ({ path, rewrite: { moved: [], root: "" } as never })),
  skipped: [], unchecked: [],
});

// U-H5
test("a batch item without a payload still gets its own link rewrite, from the item or the batch", () => {
  const batch = links("Nb/a/moved.md", "Nb/other.md");
  assert.deepEqual(moveItemLinks({ to: "Nb/a/moved.md" }, batch)?.rewritten.map((n) => n.path), ["Nb/a/moved.md"]);
  assert.equal(moveItemLinks({ to: "Nb/a/plain.md" }, batch), undefined, "nothing rewritten in a file: nothing to deliver");
  const own = links("Nb/a/moved.md");
  assert.equal(moveItemLinks({ to: "Nb/a/moved.md", links: own }, batch), own, "links the server attached to the item win");
  assert.equal(moveItemLinks({ to: "Nb/a/moved.md" }, undefined), undefined);
});

// U-H3
test("a review reload announced for a folder or a path reaches the reviews under it, not a sibling", () => {
  assert.equal(reviewsMovedAffect(["Nb/a.md"], "Nb/a.md"), true);
  assert.equal(reviewsMovedAffect(["Nb/Folder"], "Nb/Folder/a.md"), true);
  assert.equal(reviewsMovedAffect(["Nb/Folder"], "Nb/Folder2/a.md"), false);
  assert.equal(reviewsMovedAffect(undefined, "Nb/a.md"), false);
});

test("every move, and every note whose links were rewritten, is announced to open reviews", () => {
  assert.deepEqual(
    reviewPathsTouchedBy({ moved: [{ from: "Nb/a.md", to: "Nb/x/a.md" }] }, links("Nb/other.md", "Nb/x/a.md")),
    ["Nb/x/a.md", "Nb/other.md"],
  );
  assert.deepEqual(reviewPathsTouchedBy({ moved: { from: "Nb/F", to: "Nb/G" } }), ["Nb/G"]);
  assert.deepEqual(reviewPathsTouchedBy({ paths: ["Nb/saved.md"] }), [], "a plain save moves no review");
});

test("a failed leave-sync does not fail the next tab's load, which waits only for the write to end", async () => {
  const leaving = new Set<Promise<unknown>>();
  let reject!: (error: Error) => void;
  const write = new Promise<void>((_, fail) => { reject = fail; });
  trackLeavingWrite(leaving, write);
  assert.equal(leaving.size, 1);
  const load = Promise.all(leaving);
  reject(new Error("The text changed in another window."));
  await load; // before the fix this rejected and the new tab's review load ended in an error
  await Promise.resolve();
  assert.equal(leaving.size, 0, "a finished write leaves the set");
});

// U-H6
test("an editor does not mistake a link rewrite for the echo of a draft it published before (A to B to A)", () => {
  // The editor published A, then B; a move rewrites the open text back to A.
  const published = ["A", "B"];
  const heard: string[] = [];
  const stop = onTextReplaced((text) => { heard.push(text); forgetPublished(published, text); });
  announceTextReplaced("A");
  stop();
  assert.deepEqual(heard, ["A"]);
  assert.equal(published.indexOf("A"), -1, "the incoming A is no longer swallowed as an echo");
  assert.deepEqual(published, ["B"], "other pending echoes stay");
  announceTextReplaced("A");
  assert.deepEqual(heard, ["A"], "an unsubscribed editor hears nothing");
});

test("a rewrite waits for the save in flight and runs after it, in the queue", async () => {
  const queue = createSaveQueue();
  const order: string[] = [];
  let finishSave!: () => void;
  const saving = queue.run("Nb/a.md", () => new Promise<void>((resolve) => { finishSave = () => { order.push("save"); resolve(); }; }));
  await Promise.resolve();
  assert.equal(queue.busy("Nb/a.md"), true, "the workspace sees the save and defers the rewrite");
  const rewrite = queue.run("Nb/a.md", async () => { order.push("rewrite"); });
  finishSave();
  await Promise.all([saving, rewrite]);
  assert.deepEqual(order, ["save", "rewrite"]);
  assert.equal(queue.busy("Nb/a.md"), false);
});

// U-H4
test("the agent-review store sends waiting baselines before a move and reads its state again after it", async () => {
  const realFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;
  if (!hadWindow) (globalThis as Record<string, unknown>).window = { liberaPersistence: true };
  const posts: Record<string, unknown>[] = [];
  let gets = 0;
  let server = [{ path: "Nb/a.md", baseline: "b0", current: "c0", created: false, revision: "r1" }];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return new Response(JSON.stringify({ pending: true, revision: "r2" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    gets++;
    return new Response(JSON.stringify({ files: server }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await agentReviewStore.refreshIfLoaded();
    assert.equal(gets, 0, "never read: nothing is stale, nothing is fetched");
    await agentReviewStore.refresh();
    assert.equal(gets, 1);

    agentReviewStore.setBaseline("Nb/a.md", "b1");
    assert.equal(posts.length, 0, "the baseline waits for its delay");
    await agentReviewStore.flushUnsent();
    assert.equal(posts.length, 1, "a move does not leave it to the delay, keyed by the old path");
    assert.equal(posts[0].path, "Nb/a.md");
    await agentReviewStore.flushUnsent();
    assert.equal(posts.length, 1, "nothing waiting: nothing sent");

    // The move rewrote the review under the new path.
    server = [{ path: "Nb/x/a.md", baseline: "b1", current: "c0", created: false, revision: "r3" }];
    await agentReviewStore.refreshIfLoaded();
    assert.equal(gets, 2);
    assert.deepEqual(agentReviewStore.list().map((file) => file.path), ["Nb/x/a.md"]);
    assert.equal(agentReviewStore.get("Nb/x/a.md")?.revision, "r3", "the new revision, so Keep and Revert do not meet a conflict");
  } finally {
    globalThis.fetch = realFetch;
    if (!hadWindow) delete (globalThis as Record<string, unknown>).window;
  }
});
