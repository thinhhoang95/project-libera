import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { inkFileName, isInkAuthorKey, parseInkFileName, pdfPageChunk, pageNumberOfChunk } from "../../src/lib/ink/authors";
import {
  INK_XY_SCALE,
  InkCodecError,
  canWriteInkFile,
  decodeInkSamples,
  emptyInkAuthorFile,
  encodeInkSamples,
  normalizeInkAuthorFile,
  sampleBounds,
} from "../../src/lib/ink/codec";
import {
  IDENTITY_PHOTO_VIEW,
  composePhotoViews,
  originalToView,
  photoViewMatrix,
  photoViewSize,
  viewToOriginal,
  type PhotoInkView,
} from "../../src/lib/ink/frame";
import { hitTestSamples, pathLength, simplifySamples, splitSamplesByCircle, strokeOutline } from "../../src/lib/ink/geometry";
import { InkHistory } from "../../src/lib/ink/history";
import { applyInkOps, compactInkAuthorFile, mergeInkFiles } from "../../src/lib/ink/merge";
import { InkSpatialIndex } from "../../src/lib/ink/spatial-index";
import { inkToSvg } from "../../src/lib/ink/svg";
import { normalizeInkPresets } from "../../src/lib/ink/tools";
import { INK_VERSION, type InkAuthorFile, type InkSample, type InkStroke } from "../../src/lib/ink/types";

const FRAME = { unit: "pt" as const, width: 612, height: 792 };

const sampleArbitrary = fc.record({
  x: fc.double({ min: -2000, max: 2000, noNaN: true }),
  y: fc.double({ min: -2000, max: 2000, noNaN: true }),
  pressure: fc.double({ min: 0, max: 1, noNaN: true }),
});

let strokeCounter = 0;

function stroke(samples: InkSample[], overrides: Partial<InkStroke> = {}): InkStroke {
  strokeCounter += 1;
  return {
    id: `s${strokeCounter}`,
    brush: "pen",
    color: "#1f2328",
    opacity: 1,
    width: 2,
    lineStyle: "solid",
    points: encodeInkSamples(samples),
    bounds: sampleBounds(samples),
    createdAt: new Date(1_700_000_000_000 + strokeCounter).toISOString(),
    ...overrides,
  };
}

const line = (fromX: number, toX: number, y = 10, steps = 20): InkSample[] =>
  Array.from({ length: steps + 1 }, (_, index) => ({ x: fromX + ((toX - fromX) * index) / steps, y, pressure: 0.5 }));

const author = (key: string) => emptyInkAuthorFile({ key }, FRAME);

const visibleIds = (files: InkAuthorFile[]) => mergeInkFiles(files).strokes.map((item) => item.stroke.id).sort();

// ---- Codec --------------------------------------------------------------------

test("packed samples round-trip within their quantization", () => {
  fc.assert(fc.property(fc.array(sampleArbitrary, { minLength: 1, maxLength: 300 }), (samples) => {
    const decoded = decodeInkSamples(encodeInkSamples(samples));
    assert.equal(decoded.length, samples.length);
    decoded.forEach((sample, index) => {
      assert.ok(Math.abs(sample.x - samples[index].x) <= 0.5 / INK_XY_SCALE + 1e-9);
      assert.ok(Math.abs(sample.y - samples[index].y) <= 0.5 / INK_XY_SCALE + 1e-9);
      assert.ok(Math.abs(sample.pressure - samples[index].pressure) <= 0.5 / 255 + 1e-9);
      assert.equal(sample.tiltX, undefined);
      assert.equal(sample.t, undefined);
    });
  }));
});

test("tilt and time are kept when every sample has them, and time never runs backward", () => {
  const samples = [
    { x: 1, y: 2, pressure: 0.3, tiltX: -12.4, tiltY: 40.6, t: 0 },
    { x: 2, y: 3, pressure: 0.6, tiltX: -11, tiltY: 41, t: 8.2 },
    { x: 3, y: 5, pressure: 0.9, tiltX: 95, tiltY: -95, t: 7.9 },
  ];
  const decoded = decodeInkSamples(encodeInkSamples(samples));
  assert.deepEqual(decoded.map((sample) => [sample.tiltX, sample.tiltY]), [[-12, 41], [-11, 41], [90, -90]]);
  assert.deepEqual(decoded.map((sample) => sample.t), [0, 8, 8]);

  const partial = decodeInkSamples(encodeInkSamples([samples[0], { x: 4, y: 4, pressure: 0.5 }]));
  assert.equal(partial[0].tiltX, undefined);
});

test("handwriting packs into a few bytes a sample", () => {
  const samples: InkSample[] = Array.from({ length: 2000 }, (_, index) => ({
    x: 72 + index * 0.4 + Math.sin(index / 3) * 4,
    y: 100 + Math.cos(index / 5) * 6,
    pressure: 0.4 + Math.sin(index / 20) * 0.2,
    tiltX: 20 + Math.round(Math.sin(index / 50) * 3),
    tiltY: -10,
    t: index * 4,
  }));
  const bytes = (encodeInkSamples(samples).length * 3) / 4;
  assert.ok(bytes / samples.length < 8, `${bytes / samples.length} bytes a sample`);
});

test("corrupt packed points fail with an ink codec error only", () => {
  fc.assert(fc.property(fc.string({ maxLength: 80 }), (text) => {
    try {
      decodeInkSamples(text);
    } catch (error) {
      assert.ok(error instanceof InkCodecError, String(error));
    }
  }));
  const good = encodeInkSamples(line(0, 10));
  assert.throws(() => decodeInkSamples(`${good.slice(0, -6)}`), InkCodecError);
  assert.throws(() => decodeInkSamples(`${good}AAAA`), InkCodecError);
  assert.throws(() => encodeInkSamples([{ x: Number.NaN, y: 0, pressure: 0.5 }]), InkCodecError);
});

test("normalizing keeps unknown fields and brushes, and drops strokes it cannot draw", () => {
  const good = stroke(line(0, 50), { brush: "watercolor" as InkStroke["brush"] });
  const file = normalizeInkAuthorFile({
    format: "libera-ink",
    version: 1,
    author: { key: "abc123", name: 7, device: "laptop" },
    frame: FRAME,
    strokes: [
      { ...good, wetness: 0.4 },
      { ...good },
      { ...good, id: "bad color", color: "red" },
      { ...good, id: "nopoints", points: "!!!" },
      { ...good, id: "nowidth", width: 0 },
      null,
    ],
    erased: ["x1", "x1", 5, "has space"],
    revision: 3.7,
    future: { kept: true },
  });
  assert.ok(file);
  assert.deepEqual(file.strokes.map((item) => item.id), [good.id]);
  assert.equal((file.strokes[0] as InkStroke & { wetness?: number }).wetness, 0.4);
  assert.equal(file.strokes[0].brush, "watercolor");
  assert.deepEqual(file.author, { key: "abc123", device: "laptop" });
  assert.deepEqual(file.erased, ["x1"]);
  assert.equal(file.revision, 3);
  assert.deepEqual((file as InkAuthorFile & { future?: unknown }).future, { kept: true });

  assert.equal(normalizeInkAuthorFile({ format: "other", version: 1 }), null);
  assert.equal(normalizeInkAuthorFile({ ...file, frame: { unit: "em", width: 1, height: 1 } }), null);
  assert.equal(canWriteInkFile(file), true);
  assert.equal(canWriteInkFile({ version: INK_VERSION + 1 }), false);
});

// ---- Authors and file names -----------------------------------------------------

test("ink file names carry the chunk and author", () => {
  assert.equal(pdfPageChunk(7), "page-0007");
  assert.equal(pageNumberOfChunk("page-0123"), 123);
  assert.equal(inkFileName("page-0007", "k3f9q2"), "page-0007.k3f9q2.ink");
  assert.deepEqual(parseInkFileName("block-7f3c2a.k3f9q2.ink"), { chunk: "block-7f3c2a", author: "k3f9q2" });
  assert.equal(parseInkFileName("page-0007.k3f9q2.json"), null);
  assert.equal(parseInkFileName("notes.k3f9q2.ink"), null);
  assert.equal(isInkAuthorKey("Name@example.com"), false);
  assert.throws(() => inkFileName("../x", "k3f9q2"));
});

// ---- Merging authors ---------------------------------------------------------------

test("merging is independent of file order and of duplicate copies", () => {
  const a = applyInkOps(author("aaaaaa"), { add: [stroke(line(0, 10)), stroke(line(0, 20))] });
  const b = applyInkOps(author("bbbbbb"), { add: [stroke(line(5, 10)), stroke(line(5, 30))] });
  const c = applyInkOps(author("cccccc"), { erase: [b.strokes[0].id] }, [a, b]);
  const expected = visibleIds([a, b, c]);
  assert.equal(expected.length, 3);
  assert.deepEqual(visibleIds([c, b, a]), expected);
  assert.deepEqual(visibleIds([b, c, a, b]), expected);
});

test("any sequence of adds and erases by several authors shows exactly what was not erased", () => {
  const keys = ["aaaaaa", "bbbbbb", "cccccc"];
  const opArbitrary = fc.oneof(
    fc.record({ kind: fc.constant("add" as const), by: fc.nat(2) }),
    fc.record({ kind: fc.constant("erase" as const), by: fc.nat(2), pick: fc.nat() }),
  );

  fc.assert(fc.property(fc.array(opArbitrary, { maxLength: 40 }), (ops) => {
    const files = new Map(keys.map((key) => [key, author(key)]));
    const added: string[] = [];
    const erased = new Set<string>();

    for (const op of ops) {
      const key = keys[op.by];
      const others = [...files.values()].filter((file) => file.author.key !== key);
      if (op.kind === "add") {
        const next = stroke(line(0, 10));
        added.push(next.id);
        files.set(key, applyInkOps(files.get(key)!, { add: [next] }, others));
      } else if (added.length) {
        const id = added[op.pick % added.length];
        erased.add(id);
        files.set(key, applyInkOps(files.get(key)!, { erase: [id] }, others));
      }
    }

    assert.deepEqual(visibleIds([...files.values()]), added.filter((id) => !erased.has(id)).sort());
  }));
});

test("tombstones go once the erased stroke is gone from every file", () => {
  const drawn = stroke(line(0, 40));
  let alice = author("aaaaaa");
  let bob = applyInkOps(author("bbbbbb"), { add: [drawn] });

  alice = applyInkOps(alice, { erase: [drawn.id] }, [bob]);
  assert.deepEqual(alice.erased, [drawn.id]);
  assert.deepEqual(visibleIds([alice, bob]), []);

  // Bob's next write drops the stroke Alice erased…
  bob = compactInkAuthorFile(bob, [alice]);
  assert.deepEqual(bob.strokes, []);
  // …and then Alice's tombstone is no longer needed.
  alice = compactInkAuthorFile(alice, [bob]);
  assert.deepEqual(alice.erased, []);

  // Erasing your own stroke leaves no tombstone at all.
  const own = stroke(line(0, 5));
  let carol = applyInkOps(author("cccccc"), { add: [own] });
  carol = applyInkOps(carol, { erase: [own.id] }, [alice, bob]);
  assert.deepEqual([carol.strokes, carol.erased], [[], []]);
});

test("undoing an erase of someone else's stroke brings it back even after its author dropped it", () => {
  const drawn = stroke(line(0, 40));
  let bob = applyInkOps(author("bbbbbb"), { add: [drawn] });
  let alice = author("aaaaaa");
  const history = new InkHistory("aaaaaa");

  alice = applyInkOps(alice, { erase: [drawn.id] }, [bob]);
  history.record({ added: [], removed: [{ stroke: drawn, author: "bbbbbb" }] });
  bob = compactInkAuthorFile(bob, [alice]);

  alice = applyInkOps(alice, history.undo()!, [bob]);
  assert.deepEqual(visibleIds([alice, bob]), [drawn.id]);
  assert.deepEqual(alice.erased, []);

  alice = applyInkOps(alice, history.redo()!, [bob]);
  assert.deepEqual(visibleIds([alice, bob]), []);
});

test("history groups one eraser drag into one step and undoes own strokes directly", () => {
  const first = stroke(line(0, 10));
  const second = stroke(line(0, 20));
  let file = applyInkOps(author("aaaaaa"), { add: [first, second] });
  const history = new InkHistory("aaaaaa");
  file = applyInkOps(file, { erase: [first.id] });
  history.record({ added: [], removed: [{ stroke: first, author: "aaaaaa" }], gesture: "erase:1" });
  file = applyInkOps(file, { erase: [second.id] });
  history.record({ added: [], removed: [{ stroke: second, author: "aaaaaa" }], gesture: "erase:1" });

  const undo = history.undo()!;
  assert.deepEqual(undo.add?.map((item) => item.id), [first.id, second.id]);
  assert.deepEqual(undo.unerase, []);
  file = applyInkOps(file, undo);
  assert.equal(file.strokes.length, 2);
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null);
});

test("applying operations that change nothing returns the same file", () => {
  const file = applyInkOps(author("aaaaaa"), { add: [stroke(line(0, 10))] });
  assert.equal(applyInkOps(file, {}), file);
  assert.equal(applyInkOps(file, { add: [file.strokes[0]] }), file);
  assert.equal(file.revision, 1);
});

// ---- Geometry -------------------------------------------------------------------------

test("outlines exist for taps, short strokes and pressure strokes", () => {
  assert.ok(strokeOutline([{ x: 5, y: 5, pressure: 0.5 }], "pen", 2).length > 0);
  assert.ok(strokeOutline(line(0, 1, 0, 1), "marker", 2).length > 0);
  const pressured = line(0, 100).map((sample, index) => ({ ...sample, pressure: index / 20 }));
  const outline = strokeOutline(pressured, "pen", 2);
  assert.ok(outline.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test("the partial eraser leaves only samples outside its circle", () => {
  fc.assert(fc.property(
    fc.array(sampleArbitrary, { minLength: 2, maxLength: 60 }),
    fc.record({ x: fc.double({ min: -2000, max: 2000, noNaN: true }), y: fc.double({ min: -2000, max: 2000, noNaN: true }) }),
    fc.double({ min: 1, max: 600, noNaN: true }),
    (samples, center, radius) => {
      const pieces = splitSamplesByCircle(samples, center, radius);
      if (pieces === null) return;
      for (const piece of pieces) {
        assert.ok(piece.length >= 2);
        for (const sample of piece) assert.ok(Math.hypot(sample.x - center.x, sample.y - center.y) >= radius - 1e-6);
      }
    },
  ));

  assert.equal(splitSamplesByCircle(line(0, 100), { x: 50, y: 500 }, 5), null);
  assert.deepEqual(splitSamplesByCircle(line(0, 100), { x: 50, y: 10 }, 500), []);
  const halves = splitSamplesByCircle(line(0, 100), { x: 50, y: 10 }, 10)!;
  assert.equal(halves.length, 2);
  assert.ok(Math.abs(halves[0].at(-1)!.x - 40) < 1e-9);
  assert.ok(Math.abs(halves[1][0].x - 60) < 1e-9);
});

test("simplified strokes stay within their tolerance of every original sample", () => {
  fc.assert(fc.property(fc.array(sampleArbitrary, { minLength: 3, maxLength: 120 }), fc.double({ min: 0.05, max: 20, noNaN: true }), (samples, tolerance) => {
    const simplified = simplifySamples(samples, tolerance, 2);
    assert.deepEqual(simplified[0], samples[0]);
    assert.deepEqual(simplified.at(-1), samples.at(-1));
    // Each original sample lies between two kept ones (in order) and close to their segment.
    let segment = 0;
    for (const sample of samples) {
      while (segment < simplified.length - 2 && samples.indexOf(simplified[segment + 1]) < samples.indexOf(sample)) segment += 1;
      assert.ok(hitTestSamples([simplified[segment], simplified[segment + 1]], 0, sample, tolerance + 1e-6));
    }
  }));

  const dense = line(0, 100, 10, 400);
  assert.ok(simplifySamples(dense, 0.1).length < 5);
  assert.ok(Math.abs(pathLength(simplifySamples(dense, 0.1)) - 100) < 1e-6);
});

test("hit testing counts the stroke's reach and the eraser radius", () => {
  const samples = line(0, 100);
  assert.equal(hitTestSamples(samples, 1, { x: 50, y: 14 }, 2), false);
  assert.equal(hitTestSamples(samples, 1, { x: 50, y: 12.9 }, 2), true);
  assert.equal(hitTestSamples([{ x: 0, y: 0 }], 1, { x: 2.5, y: 0 }, 2), true);
});

test("the spatial index finds the same strokes as checking every one", () => {
  const rect = fc.record({ x: fc.integer({ min: -500, max: 1500 }), y: fc.integer({ min: -500, max: 1500 }), width: fc.integer({ min: 0, max: 400 }), height: fc.integer({ min: 0, max: 400 }) });
  fc.assert(fc.property(fc.array(rect, { maxLength: 80 }), rect, fc.array(fc.nat(), { maxLength: 10 }), (rects, query, removals) => {
    const index = new InkSpatialIndex(100);
    rects.forEach((item, at) => index.insert(`r${at}`, item));
    const removed = new Set(removals.map((at) => `r${at % Math.max(1, rects.length)}`));
    for (const id of removed) index.remove(id);
    const expected = rects
      .map((item, at) => ({ item, id: `r${at}` }))
      .filter(({ item, id }) => !removed.has(id) && item.x <= query.x + query.width && query.x <= item.x + item.width && item.y <= query.y + query.height && query.y <= item.y + item.height)
      .map(({ id }) => id)
      .sort();
    assert.deepEqual([...index.query(query)].sort(), expected);
  }));
});

// ---- Photo views --------------------------------------------------------------------------

const viewArbitrary: fc.Arbitrary<PhotoInkView> = fc.record({
  rotate: fc.constantFrom(0 as const, 90 as const, 180 as const, 270 as const),
  flipH: fc.boolean(),
  flipV: fc.boolean(),
  crop: fc.option(
    fc.record({ x: fc.double({ min: 0, max: 0.4, noNaN: true }), y: fc.double({ min: 0, max: 0.4, noNaN: true }), width: fc.double({ min: 0.3, max: 0.6, noNaN: true }), height: fc.double({ min: 0.3, max: 0.6, noNaN: true }) }),
    { nil: null },
  ),
});

const original = { width: 4000, height: 3000 };

test("a photo view maps points to the current file and back", () => {
  fc.assert(fc.property(viewArbitrary, fc.double({ min: 0, max: 4000, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }), (view, x, y) => {
    const back = viewToOriginal(originalToView({ x, y }, original, view), original, view);
    assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.y - y) < 1e-6);
    const [a, b, c, d, e, f] = photoViewMatrix(original, view);
    const mapped = originalToView({ x, y }, original, view);
    assert.ok(Math.abs(a * x + c * y + e - mapped.x) < 1e-6 && Math.abs(b * x + d * y + f - mapped.y) < 1e-6);
  }));
});

test("composing views matches baking one edit after another", () => {
  fc.assert(fc.property(viewArbitrary, viewArbitrary, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (view, edit, u, v) => {
    const composed = composePhotoViews(view, edit);
    const middle = photoViewSize(original, view);
    // A point inside the twice-edited file, traced back both ways.
    const finalSize = photoViewSize(middle, edit);
    const point = { x: u * finalSize.width, y: v * finalSize.height };
    const stepwise = viewToOriginal(viewToOriginal(point, middle, edit), original, view);
    const direct = viewToOriginal(point, original, composed);
    // Each bake rounds its crop to whole pixels.
    assert.ok(Math.hypot(stepwise.x - direct.x, stepwise.y - direct.y) < 3, JSON.stringify({ stepwise, direct }));
    const size = photoViewSize(original, composed);
    assert.ok(Math.abs(size.width - finalSize.width) <= 2 && Math.abs(size.height - finalSize.height) <= 2);
  }));

  assert.deepEqual(composePhotoViews(IDENTITY_PHOTO_VIEW, IDENTITY_PHOTO_VIEW), IDENTITY_PHOTO_VIEW);
  const turnedTwice = composePhotoViews({ ...IDENTITY_PHOTO_VIEW, rotate: 90 }, { ...IDENTITY_PHOTO_VIEW, rotate: 270 });
  assert.deepEqual(turnedTwice, IDENTITY_PHOTO_VIEW);
});

// ---- Output ----------------------------------------------------------------------------------

test("SVG output puts highlighters under pens and escapes the title", () => {
  const svg = inkToSvg([
    stroke(line(0, 50), { brush: "highlighter", color: "#ffe45c", opacity: 0.35, width: 12 }),
    stroke(line(0, 50), { lineStyle: "dashed" }),
    stroke(line(0, 50)),
  ], FRAME, "Notes <draft>");
  assert.match(svg, /^<svg[^>]+viewBox="0 0 612 792"/);
  assert.ok(svg.indexOf("mix-blend-mode:multiply") < svg.indexOf("stroke-dasharray"));
  assert.match(svg, /fill-opacity="0.35"/);
  assert.match(svg, /<title>Notes &#60;draft&#62;<\/title>/);
});

test("saved pens are validated and capped", () => {
  const presets = normalizeInkPresets([
    { brush: "pen", color: "#000000", width: 500, lineStyle: "wavy" },
    { brush: "crayon", color: "#000000", width: 1 },
    ...Array.from({ length: 10 }, () => ({ brush: "marker", color: "#d92d20", width: 2, lineStyle: "dotted", opacity: 0 })),
  ]);
  assert.equal(presets.length, 8);
  assert.deepEqual(presets[0], { brush: "pen", color: "#000000", width: 40, lineStyle: "solid", opacity: 1 });
  assert.equal(presets[1].opacity, 0.05);
});
