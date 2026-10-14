import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The worker helpers are plain ES modules without types.
import { completeBlocks, loopCutoff } from "../../electron/document-ocr-loop.mjs";

// Token ids: 1-9 are text, 100+ are <loc_N> tags.
const locations = new Set(Array.from({ length: 500 }, (_, index) => 100 + index));

test("finds a block repeated at new positions, ignoring its location tags", () => {
  const intro = [1, 2, 3, 4, 5, 6, 7, 8];
  const generated = [...intro];
  // "<text><loc_a><loc_b><loc_c><loc_d>Sustan Athey</text>" over and over, each lower on the page.
  for (let row = 0; row < 40; row += 1) generated.push(9, 100 + row, 140 + row, 200 + row, 240 + row, 2, 3, 4, 9);
  const keep = loopCutoff(generated, locations);

  assert.notEqual(keep, null);
  const kept = generated.slice(0, keep).filter((token) => !locations.has(token));
  // The intro and some copies of the block survive; the repeated tail is cut.
  assert.deepEqual(kept.slice(0, intro.length), intro);
  assert.ok(kept.length < generated.filter((token) => !locations.has(token)).length - 100);
});

test("leaves ordinary output alone", () => {
  const generated = Array.from({ length: 600 }, (_, index) => (index * 7919) % 97);
  assert.equal(loopCutoff(generated, locations), null);
  assert.equal(loopCutoff([1, 2, 3], locations), null);
});

test("drops the unfinished block left by a loop", () => {
  assert.equal(
    completeBlocks("<doctag><text><loc_1>Real text.</text>\n<text><loc_2>Invented text that st"),
    "<doctag><text><loc_1>Real text.</text>",
  );
  assert.equal(completeBlocks("<doctag><text><loc_1>Never closed"), "<doctag>");
});
