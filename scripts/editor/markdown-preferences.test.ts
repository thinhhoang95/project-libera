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

test("heading accent preferences default to blue with bold lead-ins on", () => {
  assert.equal(normalizeMarkdownPreferences().headingColor, "blue");
  assert.equal(normalizeMarkdownPreferences({ headingColor: "teal" }).headingColor, "teal");
  assert.equal(normalizeMarkdownPreferences({ headingColor: "none" }).headingColor, "none");
  assert.equal(normalizeMarkdownPreferences({ headingColor: "spectrum" }).headingColor, "spectrum");
  assert.equal(normalizeMarkdownPreferences({ headingColor: "#ff0000" }).headingColor, "blue");
  assert.equal(normalizeMarkdownPreferences().boldLeadIns, true);
  assert.equal(normalizeMarkdownPreferences({ boldLeadIns: "0" }).boldLeadIns, false);
  assert.equal(normalizeMarkdownPreferences({ boldLeadIns: false }).boldLeadIns, false);
});

test("rendered Markdown marks bold lead-ins of paragraphs and list items only", () => {
  const markup = renderToStaticMarkup(
    createElement(MarkdownRenderer, {
      content: [
        "**Term:** explained here.",
        "",
        "Plain then **bold** later.",
        "",
        "- **Bullet** lead-in",
        "* plain **bold**",
        "",
        "1. **Numbered** lead-in",
        "",
        "- [ ] **Task** lead-in",
      ].join("\n"),
    }),
  );
  const leadIns = [...markup.matchAll(/<strong[^>]*class="libera-lead-in"[^>]*>([^<]*)<\/strong>/g)].map((match) => match[1]);
  assert.deepEqual(leadIns, ["Term:", "Bullet", "Numbered", "Task"]);
  assert.equal(markup.match(/<strong/g)?.length, 6, "the two mid-sentence bolds stay plain");
});
