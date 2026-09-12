import assert from "node:assert/strict";
import test from "node:test";
import {
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
