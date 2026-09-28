import assert from "node:assert/strict";
import test from "node:test";
import { FILE_SUGGESTION_LIMIT, findFileSuggestions, indexFileSuggestions } from "../../src/lib/file-suggestions";
import type { LiberaFileNode } from "../../src/lib/types";

const files: LiberaFileNode[] = Array.from({ length: 3000 }, (_, i) => ({
  kind: "file", fileType: i < 20 ? "markdown" : "pdf", name: `File ${i}.${i < 20 ? "md" : "pdf"}`,
  path: `Notebook/File ${i}.${i < 20 ? "md" : "pdf"}`, notebook: "Notebook", createdAt: "", updatedAt: "", size: 0,
}));

test("large mixed libraries have bounded suggestions without losing searchable files", () => {
  const index = indexFileSuggestions(files);
  const all = findFileSuggestions(index, "");
  assert.equal(all.files.length, FILE_SUGGESTION_LIMIT);
  assert.equal(all.hasMore, true);
  assert.deepEqual(findFileSuggestions(index, "FILE 2999"), { files: [files[2999]], hasMore: false });
  assert.deepEqual(findFileSuggestions(index, "missing"), { files: [], hasMore: false });
  assert.equal(findFileSuggestions(index, "Notebook").files.length, FILE_SUGGESTION_LIMIT);
});

test("filename prefixes rank before path matches even when the result limit is reached", () => {
  const special = { ...files[2999], name: "Notebook.pdf", path: "Z/Notebook.pdf" };
  const result = findFileSuggestions(indexFileSuggestions([...files, special]), "notebook");
  assert.equal(result.files[0], special);
  assert.equal(result.files.length, FILE_SUGGESTION_LIMIT);
});
