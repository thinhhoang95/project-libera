import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_EDITOR_THEMES, resolveEditorThemes } from "../../electron/editor-themes.cjs";
import { isPdfPaperColor, pdfPaperColor } from "../../src/lib/pdf-paper-color";

const theme = (id: string) => resolveEditorThemes({ visual: id }).visual;

test("PDF pages take a light theme's paper and stay white without a theme", () => {
  assert.equal(pdfPaperColor(null, false), "");
  assert.equal(pdfPaperColor(theme("sepia"), false), BUILT_IN_EDITOR_THEMES.find((each) => each.id === "sepia")!.light.background);
  // The app's own white page needs no fill of its own.
  assert.equal(pdfPaperColor(theme("blue"), false), "");
});

test("a page too dark for black ink falls back to the light paper, then white", () => {
  const sepia = theme("sepia")!;
  assert.equal(pdfPaperColor(sepia, true), sepia.light.background);
  assert.equal(pdfPaperColor(theme("blue"), true), "");
  const dark = { ...sepia, light: { ...sepia.light, background: "#202020" }, dark: { ...sepia.dark, background: "#101010" } };
  assert.equal(pdfPaperColor(dark, false), "");
  assert.equal(pdfPaperColor(dark, true), "");
});

test("a sampled fill matching the paper is recognized, other fills are not", () => {
  assert.equal(isPdfPaperColor("#f4ecd8", "#f4ecd8"), true);
  assert.equal(isPdfPaperColor("#f5ebd9", "#f4ecd8"), true);
  assert.equal(isPdfPaperColor("#ffffff", "#f4ecd8"), false);
  assert.equal(isPdfPaperColor("#f4ecd8", ""), false);
});
