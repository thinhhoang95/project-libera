import assert from "node:assert/strict";
import test from "node:test";
import type { HostEvent } from "../../src/lib/collab/local-api";
import { MAX_INCREMENTAL_PATHS, SHARED_TREE_REFRESH_MS, subscribeSharedTreeChanges } from "../../src/lib/collab/ui/tree-changes";

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

const write = (paths: string[]): HostEvent => ({ t: "files-changed", projectId: "project", paths });

test("a batch of only working-copy writes reads just those files; a structural event makes it a full refresh", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let full = 0;
  const light: string[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { full++; }, () => undefined, null, (paths) => { light.push(paths); });
  events.emit(write(["Alpha/a.md"]));
  events.emit(write(["Alpha/b.md", "Alpha/a.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(full, 0, "writes alone never read the whole tree");
  assert.deepEqual(light, [["Alpha/a.md", "Alpha/b.md"]], "one light read for the collected paths");
  events.emit(write(["Alpha/a.md"]));
  events.emit({ t: "tree-changed", projectId: "project", notebook: "Alpha", added: ["Alpha/c.md"], moves: [], removed: [] });
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(full, 1, "a structural event in the batch reads the whole tree");
  assert.equal(light.length, 1, "and the writes in that batch are covered by it");
  events.emit(write(["Alpha/a.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.deepEqual(light, [["Alpha/a.md", "Alpha/b.md"], ["Alpha/a.md"]], "the next batch starts clean");
  stop();
});

test("a batch touching very many files reads the whole tree", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let full = 0;
  let light = 0;
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { full++; }, () => undefined, null, () => { light++; });
  events.emit(write(Array.from({ length: MAX_INCREMENTAL_PATHS + 1 }, (_, index) => `Alpha/${index}.md`)));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.deepEqual([full, light], [1, 0]);
  stop();
});

test("without a light reader, writes still refresh the whole tree", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let full = 0;
  const stop = subscribeSharedTreeChanges(events.subscribe, () => { full++; }, () => undefined, null);
  events.emit(write(["Alpha/a.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.equal(full, 1);
  stop();
});

test("writes that arrive while a light read is in flight get one follow-up with their own paths", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  const finish: (() => void)[] = [];
  const light: string[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => undefined, () => undefined, null, (paths) => {
    light.push(paths);
    return new Promise<void>((resolve) => finish.push(resolve));
  });
  events.emit(write(["Alpha/a.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  events.emit(write(["Alpha/b.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  assert.deepEqual(light, [["Alpha/a.md"]]);
  finish[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(light, [["Alpha/a.md"], ["Alpha/b.md"]]);
  stop();
});

test("writes collected while hidden are read once when the window is shown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = hostEvents();
  let hidden = true;
  let show: (() => void) | null = null;
  const visibility = { hidden: () => hidden, onVisible: (listener: () => void) => { show = listener; return () => undefined; } };
  const light: string[][] = [];
  const stop = subscribeSharedTreeChanges(events.subscribe, () => undefined, () => undefined, visibility, (paths) => { light.push(paths); });
  events.emit(write(["Alpha/a.md"]));
  t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
  events.emit(write(["Alpha/b.md"]));
  hidden = false;
  (show as unknown as () => void)();
  assert.deepEqual(light, [["Alpha/a.md", "Alpha/b.md"]]);
  stop();
});
