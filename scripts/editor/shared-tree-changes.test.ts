import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HostEvent } from "../../src/lib/collab/local-api";
import { subscribeSharedTreeChanges } from "../../src/lib/collab/ui/tree-changes";
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
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { refresh = getTree(); });
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
      t.mock.timers.tick(300);
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
  const batches: { from: string; to: string }[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, (moves) => batches.push(moves));
  const write: HostEvent = { t: "files-changed", projectId: "project", paths: ["Alpha/a.md"] };
  const move = { from: "Alpha/a.md", to: "Alpha/b.md" };
  events.emit({ t: "project-changed", projectId: "project" });
  events.emit({ ...write, paths: [] });
  t.mock.timers.tick(300);
  assert.deepEqual(batches, []);
  events.emit(write);
  t.mock.timers.tick(200);
  events.emit(write);
  events.emit({ t: "tree-changed", projectId: "project", notebook: "Alpha", added: [], moves: [move], removed: [] });
  t.mock.timers.tick(100);
  assert.deepEqual(batches, [[move]], "continued writes must not postpone the refresh");
  events.emit(write);
  t.mock.timers.tick(300);
  assert.deepEqual(batches, [[move], []], "later batches do not replay moves");
  events.emit(write);
  stop();
  events.emit(write);
  t.mock.timers.tick(300);
  assert.equal(batches.length, 2, "unmount cancels pending work and unsubscribes");
});
