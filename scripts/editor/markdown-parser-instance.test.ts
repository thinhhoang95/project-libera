import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { marked } from "marked";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "Event", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}

const note = [
  "Intro y>>>marked text<<< outro",
  "",
  "r> a red box",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "- [ ] open task",
  "- [x] done task",
  "",
  "1. first",
  "2. second",
].join("\n");

// Captured from the code before each editor got its own Marked instance.
const EXPECTED = "Intro y>>>marked text<<< outro\n\nr> a red box\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n\n- [ ] open task\n- [x] done task\n\n1. first\n2. second";

function roundTrip(content: string) {
  const editor = new Editor({ extensions: createMarkdownExtensions("Notebook/note.md"), content, contentType: "markdown" });
  const markdown = editor.getMarkdown();
  editor.destroy();
  return markdown;
}

function tokenizerCounts() {
  const extensions = (marked.defaults.extensions ?? {}) as { block?: unknown[]; inline?: unknown[]; startBlock?: unknown[]; startInline?: unknown[] };
  return [extensions.block?.length ?? 0, extensions.inline?.length ?? 0, extensions.startBlock?.length ?? 0, extensions.startInline?.length ?? 0];
}

test("editors do not register tokenizers on the global marked instance", () => {
  const before = tokenizerCounts();
  for (let i = 0; i < 4; i++) roundTrip(note);
  assert.deepEqual(tokenizerCounts(), before);
});

test("the Libera serialize and escape overrides survive configure", () => {
  assert.equal(roundTrip("\\fset and \\theorem{x}"), "\\fset and \\theorem{x}");
});

test("a note round-trips to the same Markdown", () => {
  const first = roundTrip(note);
  for (let i = 0; i < 3; i++) assert.equal(roundTrip(note), first);
  assert.equal(first, EXPECTED);
});
