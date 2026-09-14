// Run after starting Electron dev and opening a Markdown document. Unlike the
// source tests, this executes Webpack's real browser-resolved dependency graph.
// For source preview, pass .next/dev/static/chunks/_app-pages-browser_src_lib_markdown-preview_worker_ts.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const bundle = path.resolve(process.argv[2] || ".next/dev/static/chunks/_app-pages-browser_src_lib_markdown-headings_worker_ts.js");
const preview = bundle.includes("markdown-preview");
const replies = [];
const scope = {
  console, URL, setTimeout, clearTimeout,
  location: "http://localhost/_next/static/chunks/heading-worker.js",
  importScripts() { throw new Error("Unexpected external worker dependency"); },
  postMessage(data) { replies.push(JSON.parse(JSON.stringify(data))); },
};
scope.self = scope;
// Deliberately no window/document: Node source imports select a different
// conditional export and missed the DOM-only entity decoder in browser builds.
vm.runInNewContext(fs.readFileSync(bundle, "utf8"), scope, { filename: bundle, timeout: 10000 });
assert.equal(typeof scope.onmessage, "function", "The bundled worker must initialize without a DOM");
const markdown = "# First &amp; title\n\n> ## Nested\n\nSetext\n------\n\n```md\n# Hidden\n```\n\n$$\nx^2\n$$\n\n## Last";
scope.onmessage({ data: { id: 42, markdown } });
if (preview) {
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 42);
  assert.equal(replies[0].error, undefined);
  assert.ok(Array.isArray(replies[0].children));
  assert.ok(JSON.stringify(replies[0].children).includes('"katex"'), "The worker must render math without a DOM");
  scope.onmessage({ data: { id: 43, markdown } });
  assert.ok(replies[1].children.every((node, index) => node === index), "Unchanged blocks should be reused without transferring their trees");
  console.log("PASS: generated preview worker parses Markdown and renders KaTeX without a DOM.");
} else {
  assert.deepEqual(replies, [{ id: 42, offsets: [0, markdown.indexOf("## Nested"), markdown.indexOf("Setext"), markdown.indexOf("## Last")] }]);
  console.log("PASS: generated browser worker initializes without a DOM and returns the expected heading positions.");
}
