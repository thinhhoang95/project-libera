import assert from "node:assert/strict";
import test from "node:test";
import { fillFieldProvenance, identifierSupplier, recordToInput, type SourceRecord } from "../../src/lib/references/resolve/record";
import { resolveInput } from "../../src/lib/references/resolve/pipeline";
import type { ReferenceEntryInput } from "../../src/lib/references/types";
import { testOptions } from "./references-resolve-helpers";

// Every candidate the resolution server returns says where each of its CSL
// fields came from, including identifiers copied into the item from another
// source (a PMID from OpenAlex), so the confirmation card no longer needs a
// client-side exception for sourceless identifiers.

const RECORDED_INPUTS = [
  "https://doi.org/10.1016/J.NEUNET.2014.09.003",
  "10.1016/j.neunet.2018.06.008",
  "arXiv:1404.7828v4",
  "doi:10.5061/dryad.8515",
  "PMC3531190",
  "PMID: 23193287",
  "ISBN 0-13-110362-8",
  "978-0-00-000000-2",
  "Schmidhuber J. Deep learning in neural networks: an overview. 2015",
  "@article{x, title={Deep learning in neural networks: An overview}, author={Schmidhuber, J{\\\"u}rgen}, year={2015}, doi={10.1016/j.neunet.2014.09.003}, pmid={25462637}}",
];

function fieldsWithoutProvenance(candidate: ReferenceEntryInput) {
  return Object.keys(candidate.csl).filter((field) => !candidate.provenance?.[field]);
}

test("every candidate from the recorded fixtures has provenance for every field", async () => {
  let checked = 0;
  for (const input of RECORDED_INPUTS) {
    const { candidates } = await resolveInput(input, testOptions());
    assert.ok(candidates.length, `${input} gives a candidate`);
    for (const candidate of candidates) {
      assert.deepEqual(fieldsWithoutProvenance(candidate), [], `${input}: every field has a source`);
      checked += 1;
    }
  }
  assert.ok(checked >= RECORDED_INPUTS.length);
});

test("a PMID that OpenAlex supplied is credited to OpenAlex", async () => {
  const { candidates: [candidate] } = await resolveInput("10.1016/j.neunet.2014.09.003", testOptions());
  assert.equal(candidate.csl.PMID, "25462637");
  assert.equal(candidate.provenance?.PMID?.source, "openalex");
  assert.equal(candidate.provenance?.DOI?.source, "crossref");
});

test("a record's identifiers missing from its CSL item take the record's provenance", () => {
  const record: SourceRecord = {
    source: "openalex", confidence: 0.85, url: "https://api.openalex.org/works/W1", retrievedAt: "2026-10-18T00:00:00.000Z",
    csl: { type: "article-journal", title: "T" }, identifiers: { pmid: "123", pmcid: "PMC9" },
  };
  const input = recordToInput(record);
  assert.equal(input.csl.PMID, "123");
  assert.deepEqual(input.provenance?.PMID, { source: "openalex", confidence: 0.85, url: "https://api.openalex.org/works/W1", retrievedAt: record.retrievedAt });
  assert.equal(input.provenance?.PMCID?.source, "openalex");
});

test("identifierSupplier credits the first input holding the identifier; fillFieldProvenance keeps existing sources", () => {
  const at = "2026-10-18T00:00:00.000Z";
  const primary: ReferenceEntryInput = { csl: { type: "book", title: "T" }, provenance: { title: { source: "crossref", confidence: 0.95, retrievedAt: at }, type: { source: "crossref", confidence: 0.95, retrievedAt: at } } };
  const other: ReferenceEntryInput = { csl: { type: "book" }, identifiers: { isbn: ["9780131103627"] }, provenance: { type: { source: "isbn", confidence: 0.9, retrievedAt: at } } };
  const supplier = identifierSupplier([primary, other]);
  assert.equal(supplier("ISBN")?.source, "isbn");
  assert.equal(supplier("title"), undefined, "only identifier fields");
  const filled = fillFieldProvenance({ ...primary, csl: { ...primary.csl, ISBN: "9780131103627" } }, supplier);
  assert.equal(filled.provenance?.ISBN?.source, "isbn");
  assert.equal(filled.provenance?.title?.source, "crossref");
});
