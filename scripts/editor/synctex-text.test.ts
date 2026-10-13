import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { locateTextHint, textHintAt } from "../../src/lib/latex/synctex-text";

const paragraph = [
  "\\section{Results}",
  "We show that the model converges. In particular, the model is \\emph{stable} under noise, and the model generalises.",
  "",
  "Next paragraph mentions the model again.",
].join("\n");

test("textHintAt takes the word under the caret and its surroundings", () => {
  const text = "the model is stable under noise";
  assert.deepEqual(textHintAt(text, text.indexOf("stable") + 2), { word: "stable", before: "the model is ", after: " under noise" });
  assert.equal(textHintAt(text, text.indexOf("model") + 5)?.word, "model");
  assert.equal(textHintAt("   ", 1), null);
});

test("locateTextHint finds the clicked occurrence within a long source line", () => {
  const hint = { word: "model", before: "In particular, the ", after: " is stable under noise, and" };
  const found = locateTextHint(paragraph, 2, hint);
  assert.ok(found);
  assert.equal(paragraph.slice(found.from, found.to), "model");
  assert.equal(found.from, paragraph.indexOf("the model is") + 4);

  const last = locateTextHint(paragraph, 2, { word: "model", before: "under noise, and the ", after: " generalises." });
  assert.equal(last?.from, paragraph.indexOf("model generalises"));
});

test("locateTextHint reads through commands and ligatures, and ignores command names", () => {
  const stable = locateTextHint(paragraph, 2, { word: "stable", before: "the model is ", after: " under" });
  assert.equal(stable?.from, paragraph.indexOf("stable"));
  assert.equal(locateTextHint("A \\section{x} with section text", 1, { word: "section", before: "with ", after: " text" })?.from, "A \\section{x} with ".length);
  // PDF text carries ligature glyphs that the source spells out.
  assert.equal(locateTextHint("we define the field", 1, { word: "ﬁeld", before: "deﬁne the ", after: "" })?.from, "we define the ".length);
  assert.equal(locateTextHint(paragraph, 2, { word: "absent", before: "", after: "" }), null);
});
