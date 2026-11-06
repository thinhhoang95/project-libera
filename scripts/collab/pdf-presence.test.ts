import assert from "node:assert/strict";
import test from "node:test";

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { PdfGhosts, PdfPresenceStore, readPdfPresence, type PdfDraftFrame } from "../../src/lib/collab/pdf/presence";

/** Runs scheduled work when asked, so tests decide when a frame goes out. */
function manualSchedule() {
  const queue: Array<{ work: () => void; cancelled: boolean }> = [];
  return {
    schedule: (work: () => void) => {
      const entry = { work, cancelled: false };
      queue.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    run() {
      for (const entry of queue.splice(0)) if (!entry.cancelled) entry.work();
    },
  };
}

function pair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  a.setLocalStateField("user", { name: "Ada", color: "#112233", userId: "acc_a" });
  b.setLocalStateField("user", { name: "Bo", color: "#445566", userId: "acc_b" });
  a.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [...added, ...updated, ...removed]), "wire");
  });
  return { a, b };
}

const frame = (start: number, points: Array<[number, number]>, id = "s1"): PdfDraftFrame => ({ id, start, page: 2, kind: "ink", color: "#112233", strokeWidth: 2, points: points.map(([x, y]) => ({ x, y })) });

test("presence fields from others are checked", () => {
  assert.equal(readPdfPresence(null), null);
  assert.equal(readPdfPresence({ page: 0, top: 0, bottom: 1 }), null);
  assert.equal(readPdfPresence({ page: 1, top: "x", bottom: 1 }), null);
  const clean = readPdfPresence({ page: 3, top: -99, bottom: 99, pointer: { page: 3, x: 0.5, y: 0.5 }, selection: ["a", 7, "b"], draft: { id: "d", start: 0, page: 3, kind: "ink", color: "url(x)", strokeWidth: 2, points: [] } });
  assert.ok(clean);
  assert.equal(clean.top, -5);
  assert.equal(clean.bottom, 5);
  assert.deepEqual(clean.selection, ["a", "b"]);
  assert.equal(clean.draft, undefined, "a bad colour drops the draft");
  const capped = readPdfPresence({ page: 1, top: 0, bottom: 1, draft: frame(0, Array.from({ length: 900 }, () => [0.1, 0.1])) });
  assert.equal(capped?.draft?.points.length, 400);
});

test("a ghost grows from tails, and a dropped frame only leaves a gap", () => {
  const ghosts = new PdfGhosts();
  ghosts.apply(1, frame(0, [[0, 0], [0.1, 0.1]]));
  ghosts.apply(1, frame(2, [[0.2, 0.2]]));
  assert.equal(ghosts.get(1)?.points.length, 3);
  // Index 3 was lost.
  ghosts.apply(1, frame(4, [[0.4, 0.4]]));
  assert.deepEqual(ghosts.get(1)?.points.at(-1), { x: 0.4, y: 0.4 });
  // A resend replaces, so nothing doubles.
  ghosts.apply(1, frame(2, [[0.2, 0.2], [0.3, 0.3]]));
  assert.equal(ghosts.get(1)?.points.length, 4);
  // A new stroke starts over.
  ghosts.apply(1, frame(0, [[0.9, 0.9]], "s2"));
  assert.equal(ghosts.get(1)?.points.length, 1);
});

test("a stroke in progress reaches the other client as tails, then clears", () => {
  const { a, b } = pair();
  const timers = manualSchedule();
  const sender = new PdfPresenceStore(a, timers.schedule);
  const receiverTimers = manualSchedule();
  const receiver = new PdfPresenceStore(b, receiverTimers.schedule);
  sender.setView({ page: 2, top: 0.1, bottom: 0.9 });
  timers.run();
  assert.equal(receiver.getSnapshot().users[0].presence?.page, 2);

  const points = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }];
  sender.setDraft({ id: "s", page: 2, kind: "ink", color: "#112233", strokeWidth: 2, points });
  timers.run();
  assert.equal(receiver.getSnapshot().ghosts[0].points.length, 2);
  const tail = (a.getLocalState()?.pdf as { draft: PdfDraftFrame }).draft;
  assert.equal(tail.start, 0);

  sender.setDraft({ id: "s", page: 2, kind: "ink", color: "#112233", strokeWidth: 2, points: [...points, { x: 0.3, y: 0.3 }] });
  timers.run();
  const next = (a.getLocalState()?.pdf as { draft: PdfDraftFrame }).draft;
  assert.equal(next.start, 2, "only the new point travels");
  assert.equal(next.points.length, 1);
  assert.equal(receiver.getSnapshot().ghosts[0].points.length, 3);

  sender.setDraft(null);
  assert.equal(receiver.getSnapshot().ghosts.length, 1, "it lingers until the real mark lands");
  receiverTimers.run();
  assert.equal(receiver.getSnapshot().ghosts.length, 0);
  sender.destroy();
  receiver.destroy();
});

test("someone leaving mid-stroke leaves no ghost", () => {
  const { a, b } = pair();
  const timers = manualSchedule();
  const sender = new PdfPresenceStore(a, timers.schedule);
  const receiver = new PdfPresenceStore(b, manualSchedule().schedule);
  sender.setView({ page: 1, top: 0, bottom: 1 });
  sender.setDraft({ id: "s", page: 1, kind: "ink", color: "#112233", strokeWidth: 2, points: [{ x: 0, y: 0 }] });
  timers.run();
  assert.equal(receiver.getSnapshot().ghosts.length, 1);
  a.setLocalState(null);
  assert.equal(receiver.getSnapshot().ghosts.length, 0);
  assert.equal(receiver.getSnapshot().users.length, 0);
  receiver.destroy();
});

test("a shape's frames replace each other", () => {
  const { a, b } = pair();
  const timers = manualSchedule();
  const sender = new PdfPresenceStore(a, timers.schedule);
  const receiver = new PdfPresenceStore(b, manualSchedule().schedule);
  sender.setView({ page: 1, top: 0, bottom: 1 });
  for (const x of [0.2, 0.4]) {
    sender.setDraft({ id: "shape", page: 1, kind: "shape", shape: "rectangle", color: "#112233", strokeWidth: 2, points: [{ x: 0, y: 0 }, { x, y: x }] });
    timers.run();
  }
  assert.deepEqual(receiver.getSnapshot().ghosts[0].points, [{ x: 0, y: 0 }, { x: 0.4, y: 0.4 }]);
  sender.destroy();
  receiver.destroy();
});

test("frames stay small and within the server's rate", () => {
  const { a } = pair();
  const timers = manualSchedule();
  const sender = new PdfPresenceStore(a, timers.schedule);
  sender.setView({ page: 1, top: 0, bottom: 1 });
  sender.setDraft({ id: "s", page: 1, kind: "ink", color: "#112233", strokeWidth: 2, points: Array.from({ length: 1000 }, (_, index) => ({ x: index / 1000, y: 0.123456 })) });
  timers.run();
  assert.ok(JSON.stringify(a.getLocalState()?.pdf).length < 32 * 1024);
  timers.run();
  timers.run();
  const last = (a.getLocalState()?.pdf as { draft: PdfDraftFrame }).draft;
  assert.equal(last.start + last.points.length, 1000, "a burst drains over several frames");
  sender.destroy();
});

test("leaving clears this window's presence", () => {
  const { a, b } = pair();
  const timers = manualSchedule();
  const sender = new PdfPresenceStore(a, timers.schedule);
  const receiver = new PdfPresenceStore(b, manualSchedule().schedule);
  sender.setView({ page: 4, top: 0, bottom: 1 });
  timers.run();
  sender.leave();
  assert.equal(receiver.getSnapshot().users[0].presence, null);
  receiver.destroy();
});


test("F20: cumulative ghosts, lifetime and sequence progression are bounded", () => {
  let now = 0;
  const ghosts = new PdfGhosts(() => now);
  const points: Array<[number, number]> = Array.from({ length: 400 }, () => [0.1, 0.2]);
  for (let index = 0; index < 300; index += 1) ghosts.apply(1, frame(index * 400, points));
  assert.ok(ghosts.get(1)!.points.length <= 5000);
  const before = ghosts.get(1);
  assert.equal(ghosts.apply(1, frame(0, [[0.9, 0.9]])), false, "a backwards frame cannot rebuild the stroke");
  assert.equal(ghosts.get(1), before);
  assert.equal(ghosts.apply(1, frame(Number.MAX_SAFE_INTEGER, [[0.9, 0.9]])), false);
  now = 30_000;
  assert.equal(ghosts.get(1), undefined);
  ghosts.apply(1, frame(0, points));
  assert.equal(ghosts.get(1), undefined, "the expired draft id cannot start over");
  ghosts.apply(1, frame(0, points, "next-stroke"));
  assert.equal(ghosts.get(1)?.points.length, 400);
});
