import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentBody } from "../../src/components/libera/markdown-review-ui";

test("comment bodies render Markdown and KaTeX math", () => {
  const html = renderToStaticMarkup(createElement(CommentBody, { text: "**Check** the bound $x^2 \\le 1$:\n\n$$\n\\int_0^1 f\n$$\n\n- item" }));
  assert.match(html, /\\le 1/);
  assert.match(html, /<strong[^>]*>Check<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.match(html, /<li/);
  assert.match(html, /review-comment-body/);
});

test("collapsed previews are clamped", () => {
  assert.match(renderToStaticMarkup(createElement(CommentBody, { text: "Hi", preview: true })), /review-comment-preview/);
});
