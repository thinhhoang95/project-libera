import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { SharedPdfStore } from "../../src/lib/collab/pdf/store";
import type { PdfAnnotation, PdfHighlightAnnotation, PdfInkAnnotation, PdfSpaceAnnotation, PdfTextAnnotation } from "../../src/lib/types";

// Random people doing random things with marks, going offline and coming
// back, with updates delivered late, repeated and out of order. Whatever the
// schedule: everyone ends up seeing the same thing, and no mark disappears
// unless someone deleted it.

const RUNS = Number(process.env.LIBERA_COLLAB_FUZZ_RUNS ?? (process.env.LIBERA_COLLAB_HEAVY ? 200 : 40));
const BASE_SEED = Number(process.env.LIBERA_COLLAB_FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (max: number) => Math.floor(next() * max), pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)] };
}

interface Person {
  name: string;
  doc: Y.Doc;
  store: SharedPdfStore;
  online: boolean;
  /** Updates this person has not received yet. */
  inbox: Uint8Array[];
  deletedByMe: Set<string>;
}

function person(name: string, everyone: Person[]): Person {
  const doc = new Y.Doc();
  const self: Person = { name, doc, store: new SharedPdfStore({ annotations: doc, onRebuild: () => () => {} }, `doc_${name}`, { accountId: name }), online: true, inbox: [], deletedByMe: new Set() };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "wire") return;
    for (const other of everyone) if (other !== self) other.inbox.push(update);
  });
  return self;
}

function deliver(target: Person, random: ReturnType<typeof generator>) {
  const updates = [...target.inbox];
  target.inbox = [];
  // Out of order, and some twice.
  updates.sort(() => random.next() - 0.5);
  for (const update of updates) {
    Y.applyUpdate(target.doc, update, "wire");
    if (random.next() < 0.2) Y.applyUpdate(target.doc, update, "wire");
  }
}

const when = (n: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, 0, n)).toISOString();

function newMark(id: string, random: ReturnType<typeof generator>, marks: readonly PdfAnnotation[]): PdfAnnotation {
  const common = { id, pageNumber: 1 + random.int(3), createdAt: when(random.int(1000)), updatedAt: when(1000) };
  const spaces = marks.filter((mark): mark is PdfSpaceAnnotation => mark.type === "space" && mark.pageNumber === common.pageNumber);
  const space = spaces.length && random.next() < 0.5 ? { space: random.pick(spaces).id } : {};
  switch (random.int(4)) {
    case 0: return { ...common, type: "highlight", color: "#fde047", rects: [{ x: random.next(), y: random.next(), width: 0.1, height: 0.02 }], quote: "words" } satisfies PdfHighlightAnnotation;
    case 1: return { ...common, ...space, type: "text", text: `note ${id}`, fontSize: 10, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } } satisfies PdfTextAnnotation;
    case 2: return { ...common, ...space, type: "ink", color: "#111111", strokeWidth: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] } satisfies PdfInkAnnotation;
    default: {
      const y = Math.round(random.next() * 10) / 10;
      return { ...common, type: "space", y, height: 0.05 + random.next() * 0.2, band: { top: y, bottom: y, splits: [] }, column: 0 } satisfies PdfSpaceAnnotation;
    }
  }
}

function act(actor: Person, random: ReturnType<typeof generator>, counter: { value: number }) {
  const marks = actor.store.getSnapshot();
  const target = marks.length ? random.pick(marks) : null;
  switch (random.int(8)) {
    case 0:
    case 1:
      counter.value += 1;
      actor.store.commit([...marks, newMark(`${actor.name}-${counter.value}`, random, marks)]);
      break;
    case 2:
      if (target) actor.store.commit(marks.map((mark) => mark.id === target.id ? { ...mark, color: random.pick(["#111111", "#222222", "#333333"]), updatedAt: when(1001) } as PdfAnnotation : mark));
      break;
    case 3:
      if (target?.type === "text") actor.store.commit(marks.map((mark) => mark.id === target.id ? { ...target, text: `${random.pick(["A ", "B "])}${target.text}${random.pick([" x", " y"])}`, updatedAt: when(1002) } : mark));
      break;
    case 4:
      if (target) {
        actor.deletedByMe.add(target.id);
        actor.store.commit(marks.filter((mark) => mark.id !== target.id));
      }
      break;
    case 5:
      actor.store.undo();
      break;
    case 6:
      actor.store.redo();
      break;
    default: {
      const deleted = actor.store.deleted();
      if (deleted.length) actor.store.restore(random.pick(deleted).annotation.id);
    }
  }
}

function runSchedule(seed: number) {
  const random = generator(seed);
  const everyone: Person[] = [];
  for (const name of ["ada", "bo", "cy"]) everyone.push(person(name, everyone));
  const counter = { value: 0 };
  for (let step = 0; step < 120; step += 1) {
    const actor = random.pick(everyone);
    if (random.next() < 0.1) actor.online = !actor.online;
    act(actor, random, counter);
    for (const target of everyone) if (target.online && random.next() < 0.4) deliver(target, random);
  }
  for (const target of everyone) {
    target.online = true;
    deliver(target, random);
  }
  const shown = everyone.map((item) => JSON.stringify(item.store.getSnapshot()));
  assert.equal(shown[1], shown[0], `seed ${seed}: ada and bo differ`);
  assert.equal(shown[2], shown[0], `seed ${seed}: ada and cy differ`);
  // Every mark ever made is still in the document, live or deleted.
  for (const item of everyone) {
    const made = new Set(everyone.flatMap((other) => [...other.doc.getMap("pdfMarks").keys()]));
    assert.equal(item.doc.getMap("pdfMarks").size, made.size, `seed ${seed}: a mark was removed from ${item.name}`);
  }
  for (const item of everyone) item.store.destroy();
}

test(`marks converge under ${RUNS} random schedules`, { timeout: 120_000 }, () => {
  console.log(`[collab-fuzz] pdf marks, seed ${BASE_SEED}, ${RUNS} runs`);
  for (let run = 0; run < RUNS; run += 1) runSchedule(BASE_SEED + run);
});
