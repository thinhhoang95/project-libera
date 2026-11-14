import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HostEvent } from "../../src/lib/collab/local-api";
import { SHARED_TREE_REFRESH_MS, subscribeSharedTreeChanges } from "../../src/lib/collab/ui/tree-changes";
import { getTree } from "../../src/lib/storage/tree";

function hostEvents() {
  let listener: ((event: HostEvent) => void) | null = null;
  return {
    subscribe(callback: (event: HostEvent) => void) {
      listener = callback;
      return () => { listener = null; };
    },
    emit(event: HostEvent) { listener?.(event); },
  };
}

test("shared text writes refresh outgoing and backlink metadata when links are added and removed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-shared-links-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users/admin");
  const events = hostEvents();
  let refresh: Promise<Awaited<ReturnType<typeof getTree>>> | undefined;
  function refreshedTree() {
    assert.ok(refresh, "a content-only host event must refresh the tree");
    return refresh;
  }
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { refresh = getTree(); }, () => undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const notebook of ["Alpha", "Beta"]) await mkdir(path.join(root, notebook), { recursive: true });
    await writeFile(path.join(root, "Alpha/.libera-shared.json"), JSON.stringify({ projectId: "project" }));
    const source = path.join(root, "Alpha/source.md");
    await writeFile(source, "No links");
    await writeFile(path.join(root, "Beta/target.md"), "Target");
    const initial = await getTree();
    assert.deepEqual(initial.notebooks.find((node) => node.name === "Alpha")?.relatedNotebookNames, []);

    for (const [content, expected] of [["[target](../Beta/target.md)", ["Beta/target.md"]], ["Links removed", []]] as const) {
      // The host materializes CRDT text directly, bypassing ordinary Save.
      await writeFile(source, content);
      refresh = undefined;
      events.emit({ t: "files-changed", projectId: "project", paths: ["Alpha/source.md"] });
      t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
      const tree = await refreshedTree();
      const alpha = tree.notebooks.find((node) => node.name === "Alpha")!;
      assert.deepEqual(alpha.relatedNotebookNames, expected.length ? ["Beta"] : []);
      const file = alpha.children.find((node) => node.path === "Alpha/source.md")!;
      assert.equal(file.kind, "file");
      assert.deepEqual(file.kind === "file" ? file.linkedFilePaths ?? [] : [], expected,
        "sidebar backlink sources reflect the refreshed link index");
    }
  } finally {
    stop();
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared tree refreshes batch writes and moves, meet the first deadline, and cancel on cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let refreshes = 0;
  const delivered: { from: string; to: string }[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { refreshes++; }, (moves) => delivered.push(moves));
  const write: HostEvent = { t: "files-changed", projectId: "project", paths: ["Alpha/a.md"] };
  const move = { from: "Alpha/a.md", to: "Alpha/b.md" };
  events.emit({ t: "project-changed", projectId: "project" });
  events.emit({ ...write, paths: [] });
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(refreshes, 0);
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS - 100);
  events.emit(write);
  events.emit({ t: "tree-changed", projectId: "project", notebook: "Alpha", added: [], moves: [move], removed: [] });
  assert.deepEqual(delivered, [[move]], "moves are delivered as they happen");
  t.mock.timers.tick(100);
  assert.equal(refreshes, 1, "continued writes must not postpone the refresh");
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(refreshes, 2);
  assert.deepEqual(delivered, [[move]], "later refreshes do not replay moves");
  events.emit(write);
  stop();
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(refreshes, 2, "unmount cancels pending work and unsubscribes");
});

test("moves reach the consumer while the window is hidden, collapsed to their final destination", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  const visibility = { hidden: () => true, onVisible: () => () => undefined };
  let refreshes = 0;
  const delivered: { from: string; to: string }[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { refreshes++; }, (moves) => delivered.push(moves), visibility);
  const tree = (moves: { from: string; to: string }[]): HostEvent =>
    ({ t: "tree-changed", projectId: "project", notebook: "Alpha", added: [], moves, removed: [] });
  events.emit(tree([{ from: "a.md", to: "b.md" }, { from: "b.md", to: "c.md" }]));
  events.emit(tree([{ from: "x.md", to: "y.md" }, { from: "y.md", to: "x.md" }]));
  events.emit(tree([{ from: "c.md", to: "d.md" }]));
  assert.deepEqual(delivered, [[{ from: "a.md", to: "c.md" }], [{ from: "c.md", to: "d.md" }]],
    "chains collapse within a delivery and round trips are dropped");
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS * 2);
  assert.equal(refreshes, 0, "the tree refresh still waits for the window");
  stop();
});

test("a shared tree refresh is not started while one is in flight, and one follow-up runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  const finish: (() => void)[] = [];
  let started = 0;
  const stop = subscribeSharedTreeChanges(events.subscribe, () => {
    started++;
    return new Promise<void>((resolve) => finish.push(resolve));
  }, () => undefined, null);
  const write: HostEvent = { t: "files-changed", projectId: "project", paths: ["Alpha/a.md"] };
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(started, 1);
  for (let i = 0; i < 3; i++) {
    events.emit(write);
    t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  }
  assert.equal(started, 1, "no overlap while the first is in flight");
  finish[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 2, "exactly one follow-up starts when it settles");
  finish[1]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 2, "no further follow-up without new events");
  stop();
});

test("a shared tree refresh due while the window is hidden waits for it to be shown, once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let hidden = true;
  let show: (() => void) | null = null;
  const visibility = {
    hidden: () => hidden,
    onVisible: (listener: () => void) => { show = listener; return () => { show = null; }; },
  };
  let refreshes = 0;
  const delivered: { from: string; to: string }[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { refreshes++; }, (moves) => delivered.push(moves), visibility);
  const write: HostEvent = { t: "files-changed", projectId: "project", paths: ["Alpha/a.md"] };
  const move = { from: "Alpha/a.md", to: "Alpha/b.md" };
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(refreshes, 0, "a hidden window does not refresh");
  events.emit({ t: "tree-changed", projectId: "project", notebook: "Alpha", added: [], moves: [move], removed: [] });
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS * 3);
  assert.equal(refreshes, 0, "edits while hidden start no further timers");
  assert.deepEqual(delivered, [[move]], "the move was delivered while hidden");
  hidden = false;
  show!();
  assert.equal(refreshes, 1, "showing the window runs one refresh");
  show!();
  assert.equal(refreshes, 1, "showing it again with nothing pending does nothing");
  events.emit(write);
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(refreshes, 2, "visible again, edits refresh on the usual deadline");
  assert.deepEqual(delivered, [[move]], "moves are not replayed");
  stop();
  assert.equal(show, null, "cleanup stops listening for visibility");
});
