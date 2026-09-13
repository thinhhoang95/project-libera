import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import {
  getRenderedMarkdownFontStack,
  getWysiwygEditorFontStack,
  normalizeMarkdownPreferences,
} from "../../src/lib/markdown-preferences";

test("WYSIWYG font preferences default safely and create a fallback stack", () => {
  assert.equal(
    normalizeMarkdownPreferences().wysiwygEditorFontFamily,
    "system-sans",
  );
  assert.equal(
    normalizeMarkdownPreferences({ wysiwygEditorFontFamily: "  Charter  " })
      .wysiwygEditorFontFamily,
    "Charter",
  );
  assert.equal(
    normalizeMarkdownPreferences({ wysiwygEditorFontFamily: "bad\nfont" })
      .wysiwygEditorFontFamily,
    "system-sans",
  );
  assert.equal(
    getWysiwygEditorFontStack('A "quoted" font'),
    '"A \\"quoted\\" font", system-ui, sans-serif',
  );
});

test("rendered Markdown font preferences are shared by preview and PDF renderers", () => {
  assert.equal(
    normalizeMarkdownPreferences().renderedMarkdownFontFamily,
    "system-sans",
  );
  assert.equal(
    normalizeMarkdownPreferences({ renderedMarkdownFontFamily: "  Charter  " })
      .renderedMarkdownFontFamily,
    "Charter",
  );
  assert.equal(
    normalizeMarkdownPreferences({ renderedMarkdownFontFamily: "bad\nfont" })
      .renderedMarkdownFontFamily,
    "system-sans",
  );
  assert.equal(
    getRenderedMarkdownFontStack("Charter"),
    '"Charter", system-ui, sans-serif',
  );
  const markup = renderToStaticMarkup(
    createElement(MarkdownRenderer, {
      content: "Rendered text",
      fontFamily: getRenderedMarkdownFontStack("Charter"),
    }),
  );
  assert.match(
    markup,
    /font-family:&quot;Charter&quot;, system-ui, sans-serif/,
  );
});
