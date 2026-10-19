import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import * as Y from "yjs";
import {
  addAnchor, createAnchor, findReattachCandidates, listAnchors, reattachAnchor, readAnchor, resolveAnchor, resolveAnchors,
} from "../../src/lib/collab/anchors";
import type { AnchorRecord } from "../../src/lib/collab/protocol";

function docs(text: string) {
  const content = new Y.Doc();
  const ytext = content.getText("source");
  ytext.insert(0, text);
  return { content, ytext, annotations: new Y.Doc() };
}

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const anchorText = (ytext: Y.Text, record: AnchorRecord) => {
  const resolved = resolveAnchor(ytext, record);
  return resolved.state === "attached" ? ytext.toString().slice(resolved.start, resolved.end) : null;
};

const opts = (id: string) => ({ id, kind: "comment" as const, createdBy: "alice", createdAt: 1 });

test("anchors are stored in the annotations doc and resolve through it", () => {
  const { ytext, annotations } = docs("Hello brave new world.");
  const record = addAnchor(annotations, ytext, 6, 15, opts("a1"));
  assert.equal(readAnchor(annotations, "a1")?.id, "a1");
  assert.deepEqual(listAnchors(annotations).map((anchor) => anchor.id), ["a1"]);
  // A replica receives the anchor through the annotations doc only.
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(annotations));
  const stored = readAnchor(replica, "a1")!;
  assert.deepEqual(stored, record);
  assert.deepEqual(resolveAnchor(ytext.doc!, stored), { start: 6, end: 15, state: "attached" });
  assert.equal(resolveAnchors(annotations, ytext).get("a1")?.state, "attached");
  assert.throws(() => createAnchor(ytext, 4, 4, opts("x")));
  assert.throws(() => createAnchor(ytext, 4, 400, opts("x")));
});

test("typing at either edge does not grow an anchor; interior edits stay inside", () => {
  const { ytext } = docs("Hello brave new world.");
  const record = createAnchor(ytext, 6, 15, opts("a"));
  ytext.insert(15, "!!");
  ytext.insert(6, ">>");
  assert.equal(anchorText(ytext, record), "brave new");
  ytext.insert(ytext.toString().indexOf(" new"), " and bold");
  assert.equal(anchorText(ytext, record), "brave and bold new");
  ytext.delete(ytext.toString().indexOf("ve "), 1); // "brave" → "brae"
  assert.equal(anchorText(ytext, record), "brae and bold new");
});

test("anchors stay attached through concurrent inserts and deletes around and inside them", () => {
  const { content, ytext } = docs("One two three four five.");
  const record = createAnchor(ytext, 4, 18, opts("a")); // "two three four"
  const bob = new Y.Doc();
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(content));
  const bobText = bob.getText("source");
  ytext.insert(0, "Zero. ");          // before
  ytext.delete(ytext.toString().indexOf(" three"), 6); // inside
  bobText.insert(bobText.toString().indexOf(" four"), " and a half"); // inside, concurrently
  bobText.insert(bobText.length - 1, " six"); // after
  sync(content, bob);
  assert.equal(ytext.toString(), bobText.toString());
  assert.equal(anchorText(ytext, record), "two and a half four");
  assert.equal(anchorText(bobText, record), "two and a half four");
});

test("deleting the anchored text detaches the anchor", () => {
  const { ytext } = docs("Keep this. Delete me please. Keep that.");
  const record = createAnchor(ytext, 11, 28, opts("a"));
  ytext.delete(11, 18);
  const resolved = resolveAnchor(ytext, record);
  assert.equal(resolved.state, "detached");
  assert.equal(resolved.reason, "deleted");
  // Typing where it was does not resurrect it.
  ytext.insert(11, "New text. ");
  assert.equal(resolveAnchor(ytext, record).state, "detached");
  // A position from another document cannot be resolved.
  const other = docs("Different");
  assert.equal(resolveAnchor(other.ytext, record).reason, "unresolvable");
});

test("splitting a paragraph keeps the anchor spanning both parts", () => {
  const { ytext } = docs("Intro.\n\nFirst sentence. Second sentence.\n\nOutro.");
  const start = ytext.toString().indexOf("First");
  const end = ytext.toString().indexOf("\n\nOutro");
  const record = createAnchor(ytext, start, end, opts("a"));
  ytext.insert(ytext.toString().indexOf(" Second"), "\n\n");
  assert.equal(anchorText(ytext, record), "First sentence.\n\n Second sentence.");
});

test("copy/paste does not duplicate anchors; cut+paste detaches with a reattach candidate", () => {
  const { ytext, annotations } = docs("Alpha beta gamma.\n\nDelta.");
  addAnchor(annotations, ytext, 6, 10, opts("a")); // "beta"
  // Copy "beta" and paste it at the end.
  ytext.insert(ytext.length, " beta");
  assert.equal(listAnchors(annotations).length, 1);
  const resolved = resolveAnchor(ytext, readAnchor(annotations, "a")!);
  assert.deepEqual([resolved.start, resolved.end], [6, 10]);

  // Cut "beta " and paste it after "Delta."
  ytext.delete(6, 5);
  ytext.insert(ytext.toString().indexOf("Delta.") + 6, " beta");
  const after = resolveAnchor(ytext, readAnchor(annotations, "a")!);
  assert.equal(after.state, "detached");
  const text = ytext.toString();
  const candidates = findReattachCandidates(text, "beta", { prefix: "Alpha ", suffix: " gamma.", near: after.start });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => text.slice(candidate.start, candidate.end) === "beta"));
  // Reattach keeps id and author.
  const moved = reattachAnchor(annotations, ytext, "a", candidates[0].start, candidates[0].end);
  assert.equal(moved.createdBy, "alice");
  assert.equal(resolveAnchor(ytext, moved).state, "attached");
});

test("reattach candidates rank by context and fall back to whitespace-insensitive matches", () => {
  const text = "x the cat sat. y the cat sat. z";
  const ranked = findReattachCandidates(text, "the cat", { prefix: "y ", suffix: " sat" });
  assert.equal(ranked[0].start, text.indexOf("y the") + 2);
  const loose = findReattachCandidates("A  quick\nfox", "A quick fox");
  assert.deepEqual(loose.map((candidate) => [candidate.start, candidate.end, candidate.exact]), [[0, 12, false]]);
  assert.deepEqual(findReattachCandidates("abc", ""), []);
});

/* ---- Fuzz: never silently wrong ---------------------------------------------------- */

// An independent model of the sequence: every character ever inserted, with
// deleted ones kept as tombstones. Yjs places an insertion at index i
// immediately before the i-th visible character (after any tombstones that
// precede it), so the expected range of an anchor is exactly the visible
// characters between its first and last original character.
type Cell = { id: number; ch: string; alive: boolean };
type ModelAnchor = { record: AnchorRecord; first: number; last: number };

test("fuzz: 1,000 random operations leave every anchor correctly attached or explicitly detached", () => {
  const op = fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), text: fc.stringMatching(/^[a-z \n]{1,6}$/) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("delete" as const), at: fc.nat(), length: fc.integer({ min: 1, max: 8 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("anchor" as const), at: fc.nat(), length: fc.integer({ min: 1, max: 20 }) }) },
  );
  fc.assert(fc.property(fc.array(op, { minLength: 1000, maxLength: 1000 }), (ops) => {
    const { ytext } = docs("The quick brown fox jumps over the lazy dog.\n\nA second paragraph here.");
    let nextId = 0;
    const cells: Cell[] = [...ytext.toString()].map((ch) => ({ id: nextId++, ch, alive: true }));
    const anchors: ModelAnchor[] = [];
    const visible = () => cells.filter((cell) => cell.alive);
    const cellIndexOfVisible = (index: number) => {
      let seen = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i].alive && seen++ === index) return i;
      return cells.length;
    };
    for (const step of ops) {
      const length = ytext.length;
      if (step.kind === "insert") {
        const at = step.at % (length + 1);
        ytext.insert(at, step.text);
        cells.splice(cellIndexOfVisible(at), 0, ...[...step.text].map((ch) => ({ id: nextId++, ch, alive: true })));
      } else if (step.kind === "delete" && length > 0) {
        const at = step.at % length;
        const count = Math.min(step.length, length - at);
        const targets = visible().slice(at, at + count);
        ytext.delete(at, count);
        for (const cell of targets) cell.alive = false;
      } else if (step.kind === "anchor" && length > 0) {
        const at = step.at % length;
        const end = Math.min(length, at + step.length);
        const live = visible();
        anchors.push({ record: createAnchor(ytext, at, end, opts(`a${anchors.length}`)), first: live[at].id, last: live[end - 1].id });
      }
      assert.equal(ytext.toString(), visible().map((cell) => cell.ch).join(""));
      const text = ytext.toString();
      const indexOfId = new Map<number, number>();
      const aliveBefore: number[] = [];
      cells.forEach((cell, index) => {
        indexOfId.set(cell.id, index);
        aliveBefore.push(index === 0 ? 0 : aliveBefore[index - 1] + (cells[index - 1].alive ? 1 : 0));
      });
      for (const anchor of anchors) {
        const firstIndex = indexOfId.get(anchor.first)!;
        const lastIndex = indexOfId.get(anchor.last)!;
        const between = cells.slice(firstIndex, lastIndex + 1).filter((cell) => cell.alive);
        const before = aliveBefore[firstIndex];
        const resolved = resolveAnchor(ytext, anchor.record);
        if (!between.length) {
          assert.equal(resolved.state, "detached", "an anchor whose text is gone must be detached");
          continue;
        }
        assert.equal(resolved.state, "attached");
        assert.equal(resolved.start, before);
        assert.equal(text.slice(resolved.start, resolved.end), between.map((cell) => cell.ch).join(""), "attached text is the quote with interior edits only");
      }
    }
  }), { numRuns: 3, seed: 20261018 });
});

test("fuzz: two replicas with concurrent edits resolve every anchor identically", () => {
  const edit = fc.record({ who: fc.integer({ min: 0, max: 1 }), insert: fc.boolean(), at: fc.nat(), text: fc.stringMatching(/^[a-z ]{1,4}$/), length: fc.integer({ min: 1, max: 5 }), sync: fc.boolean() });
  fc.assert(fc.property(fc.array(edit, { minLength: 200, maxLength: 200 }), (edits) => {
    const a = docs("Shared text with several words to anchor on.");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.content));
    const texts = [a.ytext, b.getText("source")];
    const records = [createAnchor(a.ytext, 7, 11, opts("x")), createAnchor(a.ytext, 12, 30, opts("y")), createAnchor(a.ytext, 0, 44, opts("z"))];
    for (const step of edits) {
      const ytext = texts[step.who];
      if (step.insert) ytext.insert(step.at % (ytext.length + 1), step.text);
      else if (ytext.length) {
        const at = step.at % ytext.length;
        ytext.delete(at, Math.min(step.length, ytext.length - at));
      }
      if (step.sync) sync(a.content, b);
    }
    sync(a.content, b);
    assert.equal(texts[0].toString(), texts[1].toString());
    for (const record of records) {
      const left = resolveAnchor(texts[0], record);
      const right = resolveAnchor(texts[1], record);
      assert.deepEqual(left, right);
      if (left.state === "attached") assert.ok(left.end > left.start);
    }
  }), { numRuns: 20, seed: 7 });
});
