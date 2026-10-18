import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReferenceSuggestionIndex, citationInsertion, foldSearchText, mayTriggerCitation, noteRecentCitation,
  recentCitationKeys, resetRecentCitations,
} from "../../src/lib/references/reference-suggestions";
import type { CslItem, ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";

let created = 0;
function entry(key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  created += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, created)).toISOString();
  return {
    id: `ref_${key}`, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: at, updatedAt: at, fieldUpdatedAt: {}, ...extra,
  };
}

function library(entries: ReferenceEntry[], revision = 1): ReferenceLibrary {
  return { version: 1, revision, style: "apa", entries: Object.fromEntries(entries.map((value) => [value.id, value])) };
}

const smith = entry("smith2020sparse", { title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal of Machine Learning" });
const lee = entry("lee2019graphs", { title: "Graphs and smithing", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] } }, { tags: ["networks"], notes: "Cites Smith extensively." });
const muller = entry("muller2021", { title: "Über Aufmerksamkeit", author: [{ family: "Müller", given: "Jörg" }], issued: { "date-parts": [[2021]] } }, { aliases: ["mueller2021old"] });
const blacksmith = entry("doe2018", { title: "The blacksmith problem", author: [{ family: "Doe", given: "John" }], issued: { "date-parts": [[2018]] } }, { status: "needs-review" });
const sparse2 = entry("kim2020dense", { title: "Dense attention", author: [{ family: "Kim" }, { family: "Smith" }], issued: { "date-parts": [[2020]] } });
const LIBRARY = library([smith, lee, muller, blacksmith, sparse2]);

const keys = (query: string, options = {}) => buildReferenceSuggestionIndex(LIBRARY).search(query, options).map((result) => result.key);

test("ranking: key prefix, then author prefix, then title word prefix, then substring", () => {
  // "smith": key prefix (smith2020sparse), author Smith (kim2020dense), title word "smithing" (lee), substring "blacksmith" (doe).
  assert.deepEqual(keys("smith"), ["smith2020sparse", "kim2020dense", "lee2019graphs", "doe2018"]);
  const [first, second, third, fourth] = buildReferenceSuggestionIndex(LIBRARY).search("smith");
  assert.equal(first.matchedField, "key");
  assert.deepEqual(first.highlights, [[0, 5]]);
  assert.equal(second.matchedField, "author");
  assert.equal(third.matchedField, "title");
  assert.deepEqual([fourth.matchedField, fourth.matchedText, fourth.highlights], ["title", "The blacksmith problem", [[9, 14]]]);
});

test("matching ignores case and accents, and keeps highlight offsets in the original text", () => {
  assert.deepEqual(keys("MULLER"), ["muller2021"]);
  assert.deepEqual(keys("über"), ["muller2021"]);
  const [result] = buildReferenceSuggestionIndex(LIBRARY).search("muller aufmerk");
  assert.equal(result.key, "muller2021");
  const author = buildReferenceSuggestionIndex(LIBRARY).search("müll")[0];
  assert.equal(author.key, "muller2021");
  assert.deepEqual(foldSearchText("Müller").folded, "muller");
  // Aliases match and insert the current key.
  const alias = buildReferenceSuggestionIndex(LIBRARY).search("mueller")[0];
  assert.deepEqual([alias.key, alias.matchedField, alias.matchedText], ["muller2021", "key", "mueller2021old"]);
});

test("every word of a multi-word query must match some field", () => {
  assert.deepEqual(keys("smith 2020"), ["smith2020sparse", "kim2020dense"]);
  assert.deepEqual(keys("sparse attention"), ["smith2020sparse"]);
  assert.deepEqual(keys("attention 2020"), ["kim2020dense", "smith2020sparse"]);
  assert.deepEqual(keys("smith 1999"), []);
  // Container titles, tags and notes are searched too.
  assert.deepEqual(keys("machine learning"), ["smith2020sparse"]);
  assert.deepEqual(keys("networks"), ["lee2019graphs"]);
  assert.deepEqual(keys("extensively"), ["lee2019graphs"]);
});

test("entries cited in the document come first, then those cited recently", () => {
  resetRecentCitations();
  // A boost moves an entry up by more than a tier step, not past a key or author prefix match.
  assert.deepEqual(keys("smith", { citedKeys: ["doe2018"] }), ["smith2020sparse", "kim2020dense", "doe2018", "lee2019graphs"]);
  // Between equal matches: cited first, then recent.
  assert.deepEqual(keys("attention 2020"), ["kim2020dense", "smith2020sparse"]);
  assert.deepEqual(keys("attention 2020", { recentKeys: ["smith2020sparse"] }), ["smith2020sparse", "kim2020dense"]);
  assert.deepEqual(keys("attention 2020", { citedKeys: ["smith2020sparse"], recentKeys: ["kim2020dense"] }), ["smith2020sparse", "kim2020dense"]);
  // Aliases count as cited.
  assert.equal(keys("2021", { citedKeys: ["mueller2021old"] })[0], "muller2021");
  noteRecentCitation("lee2019graphs");
  noteRecentCitation("doe2018");
  noteRecentCitation("lee2019graphs");
  assert.deepEqual(recentCitationKeys(), ["lee2019graphs", "doe2018"]);
  resetRecentCitations();
});

test("an empty query lists cited entries first, then recently added ones", () => {
  assert.deepEqual(keys("", { citedKeys: ["lee2019graphs", "smith2020sparse"] }), ["lee2019graphs", "smith2020sparse", "kim2020dense", "doe2018", "muller2021"]);
  assert.deepEqual(keys("", { limit: 2 }), ["kim2020dense", "doe2018"]);
  const [first] = buildReferenceSuggestionIndex(LIBRARY).search("");
  assert.equal(first.matchedField, null);
});

test("the index is cached by library revision", () => {
  const index = buildReferenceSuggestionIndex(LIBRARY);
  assert.equal(buildReferenceSuggestionIndex(LIBRARY), index);
  assert.notEqual(buildReferenceSuggestionIndex({ ...LIBRARY, revision: 2 }), index);
  assert.notEqual(buildReferenceSuggestionIndex(library([smith])), index);
});

test("searching 5,000 entries takes under 5 ms per query", () => {
  const words = ["sparse", "attention", "graph", "neural", "network", "learning", "dense", "model", "theory", "analysis"];
  const families = ["Smith", "Lee", "Müller", "García", "Kim", "Nguyen", "Ivanov", "Rossi", "Tanaka", "Okafor"];
  const entries = Array.from({ length: 5000 }, (_, index) => entry(`${families[index % 10].toLowerCase()}${1990 + (index % 35)}${words[index % 7]}${index}`, {
    title: `${words[index % 10]} ${words[(index * 3) % 10]} ${words[(index * 7) % 10]} study ${index}`,
    author: [{ family: families[index % 10] }, { family: families[(index + 3) % 10] }],
    issued: { "date-parts": [[1990 + (index % 35)]] },
    "container-title": `Journal ${index % 50}`,
  }, { tags: [words[index % 10]], notes: index % 5 === 0 ? `Note about ${words[index % 10]}` : undefined }));
  const big = library(entries, 7);
  const index = buildReferenceSuggestionIndex(big);
  const queries = ["smi", "garcia 2001", "sparse attention", "net", "2015", "ivanov graph", "study 49", "zzz", "o", ""];
  for (const query of queries) index.search(query); // warm up
  const runs = 5;
  const started = performance.now();
  for (let run = 0; run < runs; run += 1) for (const query of queries) index.search(query, { citedKeys: [entries[3].key], recentKeys: [entries[9].key] });
  const perQuery = (performance.now() - started) / (runs * queries.length);
  assert.ok(perQuery < 5, `${perQuery.toFixed(2)} ms per query`);
});

test("the cheap trigger check needs @ followed only by key characters", () => {
  assert.equal(mayTriggerCitation("See @"), true);
  assert.equal(mayTriggerCitation("See @smith20"), true);
  assert.equal(mayTriggerCitation("See [@doe:2020.a/b"), true);
  assert.equal(mayTriggerCitation("me@exam"), true); // the shared trigger rejects emails
  assert.equal(mayTriggerCitation("See @smith "), false);
  assert.equal(mayTriggerCitation("plain text"), false);
  assert.equal(mayTriggerCitation("@黄2021"), true);
  assert.equal(mayTriggerCitation(`@${"a".repeat(300)}`), false);
});

test("insertion text: [@key] outside a citation, @key inside, Tab at the locator", () => {
  assert.deepEqual(citationInsertion("a", false, false), { text: "[@a]", caret: 4 });
  assert.deepEqual(citationInsertion("a", false, true), { text: "[@a, ]", caret: 5 });
  assert.deepEqual(citationInsertion("a", true, false), { text: "@a", caret: 2 });
  assert.deepEqual(citationInsertion("a", true, true), { text: "@a, ", caret: 4 });
});
