import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobProgressText, jobSummaryText } from "../../src/components/libera/references/references-panel";
import { ReferenceRow } from "../../src/components/libera/references/reference-row";
import type { ReferenceJobStatus } from "../../src/lib/references/jobs-types";
import type { ReferenceEntry, ReferenceLibrary, RetractionStatus } from "../../src/lib/references/types";

const NOW = "2026-10-18T00:00:00.000Z";

function entry(id: string, retraction?: RetractionStatus): ReferenceEntry {
  return {
    id, key: id, aliases: [], csl: { type: "article-journal", title: `Work ${id}`, author: [{ family: "Smith" }], issued: { "date-parts": [[2020]] } },
    identifiers: { doi: `10.1/${id}` }, provenance: {}, status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {},
    ...(retraction ? { retraction } : {}),
  };
}

function job(overrides: Partial<ReferenceJobStatus>): ReferenceJobStatus {
  return {
    id: "job1", notebook: "Notes", kind: "check-retractions", state: "running", total: 0, done: 0, failed: 0,
    createdEntryIds: [], updatedEntryIds: [], errors: [], webSearch: false, createdAt: NOW, ...overrides,
  };
}

test("retraction checks describe themselves as checks, not file reads", () => {
  assert.equal(jobProgressText(job({ state: "queued" })), "Waiting to check for retractions…");
  assert.equal(jobProgressText(job({})), "Checking for retractions…");
  assert.equal(jobProgressText(job({ total: 40, done: 2 })), "Checking 3 of 40 references for retractions…");
  assert.match(jobProgressText(job({ kind: "resolve-pdfs", total: 12, done: 2 })), /^Reading 3 of 12 PDFs…/);
});

test("a finished retraction check counts flagged and corrected works", () => {
  const retracted = entry("a", { state: "retracted", checkedAt: NOW });
  const corrected = entry("b", { state: "corrected", checkedAt: NOW });
  const library: ReferenceLibrary = { version: 1, revision: 3, style: "apa", entries: { a: retracted, b: corrected } };
  assert.equal(jobSummaryText(job({ state: "done", updatedEntryIds: ["a", "b"] }), library), "Retraction check: 1 retracted or flagged · 1 corrected");
  assert.equal(jobSummaryText(job({ state: "done" }), library), "Retraction check: No new notices");
  assert.equal(jobSummaryText(job({ state: "cancelled", failed: 2 }), library), "Stopped: No new notices · 2 not checked");
});

test("rows show a compact retraction badge only for flagged works", () => {
  const props = { words: [], selected: false, citedByActive: false, citingCount: 0, duplicate: false, canCite: true, onOpen() {}, onCite() {}, onOpenAttachment() {}, onMenu() {} };
  const flagged = renderToStaticMarkup(createElement(ReferenceRow, { ...props, entry: entry("a", { state: "retracted", checkedAt: NOW }) }));
  assert.match(flagged, /libera-retraction-badge/);
  assert.match(flagged, /Retracted/);
  const clean = renderToStaticMarkup(createElement(ReferenceRow, { ...props, entry: entry("b", { state: "none", checkedAt: NOW }) }));
  assert.doesNotMatch(clean, /libera-retraction-badge/);
});
