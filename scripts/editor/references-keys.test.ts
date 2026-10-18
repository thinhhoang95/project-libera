import assert from "node:assert/strict";
import test from "node:test";
import { asciiKeyPart, baseCitationKey, generateCitationKey, isValidCitationKey, takenCitationKeys } from "../../src/lib/references/keys";

test("generates family name + year + first significant title word", () => {
  assert.equal(baseCitationKey({
    type: "article-journal",
    title: "The Sparse Attention Mechanism for Long Documents",
    author: [{ family: "Smith", given: "Jane" }, { family: "Lee", given: "Ann" }],
    issued: { "date-parts": [[2020, 5]] },
  }), "smith2020sparse");
});

test("folds diacritics and special letters, and skips stopwords in several languages", () => {
  assert.equal(asciiKeyPart("Müller-Lüdenscheidt"), "mullerludenscheidt");
  assert.equal(asciiKeyPart("Łukasiewicz"), "lukasiewicz");
  assert.equal(asciiKeyPart("Ørsted Straße"), "orstedstrasse");
  assert.equal(baseCitationKey({
    type: "book", title: "Les Misérables", author: [{ family: "Hugo", given: "Victor" }], issued: { "date-parts": [[1862]] },
  }), "hugo1862miserables");
  assert.equal(baseCitationKey({
    type: "book", title: "Über die Natur", author: [{ family: "Gödel" }], issued: { "date-parts": [[1931]] },
  }), "godel1931uber");
});

test("falls back to editors, literal names, raw dates and a placeholder", () => {
  assert.equal(baseCitationKey({ type: "book", title: "Handbook of Things", editor: [{ family: "Ng" }], issued: { raw: "circa 1999" } }), "ng1999handbook");
  assert.equal(baseCitationKey({ type: "report", title: "Annual Report", author: [{ literal: "World Health Organization" }], issued: { "date-parts": [[2021]] } }), "world2021annual");
  assert.equal(baseCitationKey({ type: "webpage", title: "On the origin" }), "origin");
  assert.equal(baseCitationKey({ type: "document" }), "ref");
});

test("resolves collisions case-insensitively with a, b, … suffixes, including aliases", () => {
  const csl = { type: "article-journal" as const, title: "Sparse", author: [{ family: "Smith" }], issued: { "date-parts": [[2020]] as Array<[number]> } };
  assert.equal(generateCitationKey(csl, []), "smith2020sparse");
  assert.equal(generateCitationKey(csl, ["Smith2020Sparse"]), "smith2020sparsea");
  const taken = takenCitationKeys([{ key: "smith2020sparse", aliases: ["smith2020sparsea"] }]);
  assert.equal(generateCitationKey(csl, taken), "smith2020sparseb");
  const many = ["smith2020sparse", ...Array.from({ length: 26 }, (_, index) => `smith2020sparse${String.fromCharCode(97 + index)}`)];
  assert.equal(generateCitationKey(csl, many), "smith2020sparseaa");
});

test("validates keys with Pandoc's grammar", () => {
  for (const key of ["smith2020", "_x", "doe:2020", "a.b", "日本2020", "x/y-z"]) assert.equal(isValidCitationKey(key), true, key);
  for (const key of ["", "-x", "smith.", "a..b", "with space", "a,b", "[x]"]) assert.equal(isValidCitationKey(key), false, key);
});
