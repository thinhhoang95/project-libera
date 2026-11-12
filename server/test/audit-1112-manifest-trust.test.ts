import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as Y from "yjs";

import { ManifestKeys } from "../src/protocol.js";
import { manifestViolation, type ChangedTypes } from "../src/sync/validate.js";

function violationFor(entry: Record<string, unknown>): string | null {
  const doc = new Y.Doc();
  doc.getMap(ManifestKeys.files);
  let changed: ChangedTypes | undefined;
  doc.on("afterTransaction", (transaction: Y.Transaction) => { changed = transaction.changed; });
  doc.transact(() => doc.getMap(ManifestKeys.files).set("fil_abcdefgh12345678", entry));
  return manifestViolation(doc, changed as ChangedTypes);
}

const base = { path: "a.md", kind: "doc", docKind: "markdown", createdBy: "u", createdAt: 1, updatedAt: 1 };

describe("manifest entry identity (PERM-1)", () => {
  test("accepts ordinary document ids", () => {
    assert.equal(violationFor({ ...base, docId: "doc_abcdefghijklmnopqrstuv" }), null);
    assert.equal(violationFor({ ...base, docId: `pdf_${"A".repeat(40)}` }), null);
  });

  test("rejects traversal and malformed document ids", () => {
    for (const docId of ["../../../../Other/victim", "a/b/c/d/e/f/g/h", "..\\..\\x\\y\\z\\w", "doc id with spaces", "x".repeat(81), "short", "", 7, null]) {
      assert.match(violationFor({ ...base, docId }) ?? "", /document id/i, String(docId));
    }
  });

  test("blob entries need no document id", () => {
    assert.equal(violationFor({ path: "p.png", kind: "blob", blobHash: "0".repeat(64), createdBy: "u", createdAt: 1, updatedAt: 1 }), null);
  });

  test("rejects a path component over the byte limit", () => {
    assert.match(violationFor({ ...base, docId: "doc_abcdefghijklmnop", path: `${"é".repeat(130)}.md` }) ?? "", /too long/i);
  });
});
