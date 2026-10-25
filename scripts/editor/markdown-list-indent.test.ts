import assert from "node:assert/strict";
import { test } from "node:test";
import { shiftMarkdownListItems } from "../../src/lib/markdown-list-indent";

function shift(marked: string, direction: "indent" | "outdent") {
  const start = marked.indexOf("|");
  const value = marked.replace("|", "");
  const result = shiftMarkdownListItems(value, start, start, direction);
  return result && `${result.nextValue.slice(0, result.nextStart)}|${result.nextValue.slice(result.nextStart)}`;
}

test("indents a bullet under its previous sibling and keeps the caret in the text", () => {
  assert.equal(shift("- one\n- t|wo\n- three", "indent"), "- one\n  - t|wo\n- three");
});

test("nests under a numbered item's text and starts the sublist at 1", () => {
  assert.equal(shift("1. one\n2. t|wo\n3. three", "indent"), "1. one\n   1. t|wo\n3. three");
});

test("continues an existing sublist's numbering", () => {
  assert.equal(shift("1. one\n   1. a\n2. |b", "indent"), "1. one\n   1. a\n   2. |b");
});

test("an item with no previous sibling cannot be indented", () => {
  assert.equal(shift("- |one\n- two", "indent"), null);
  assert.equal(shift("Some |text", "indent"), null);
});

test("nested lines move with the item", () => {
  assert.equal(shift("- one\n- t|wo\n  - child\n- three", "indent"), "- one\n  - t|wo\n    - child\n- three");
});

test("outdents to the parent's level and renumbers after the parent", () => {
  assert.equal(shift("1. one\n   1. |a", "outdent"), "1. one\n2. |a");
  assert.equal(shift("- one\n  - |a\n    - b", "outdent"), "- one\n- |a\n  - b");
  assert.equal(shift("- |top", "outdent"), null);
});

test("shifts every selected item together", () => {
  const value = "- one\n- two\n- three";
  const result = shiftMarkdownListItems(value, value.indexOf("two"), value.length, "indent");
  assert.equal(result?.nextValue, "- one\n  - two\n  - three");
});
