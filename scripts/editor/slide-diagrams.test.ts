import assert from "node:assert/strict";
import { test } from "node:test";
import { SLIDE_THEME_TOKENS, slideSeriesPalette } from "../../src/lib/slide-charts";
import { buildSlideDiagramConfig, mixHex, slideDiagramErrorMessage } from "../../src/lib/slide-diagrams";

test("mixHex lays one color over another", () => {
  assert.equal(mixHex("#ffffff", "#000000", 0), "#000000");
  assert.equal(mixHex("#ffffff", "#000000", 1), "#ffffff");
  assert.equal(mixHex("#ff0000", "#0000ff", 0.5), "#800080");
});

test("diagrams use strict security and the slide theme's colors", () => {
  const light = buildSlideDiagramConfig(SLIDE_THEME_TOKENS.light, "Inter");

  assert.equal(light.securityLevel, "strict");
  assert.equal(light.startOnLoad, false);
  assert.equal(light.theme, "base");
  assert.equal(light.themeVariables.fontFamily, "Inter");
  assert.equal(light.themeVariables.darkMode, false);
  assert.equal(light.themeVariables.background, SLIDE_THEME_TOKENS.light.surface);
  assert.equal(light.themeVariables.primaryTextColor, SLIDE_THEME_TOKENS.light.foreground);
  assert.equal(light.themeVariables.primaryBorderColor, slideSeriesPalette(false)[0]);
  // Pie slices follow the chart palette's fixed order.
  assert.equal(light.themeVariables.pie1, "#2a78d6");
  assert.equal(light.themeVariables.pie2, "#eb6834");

  const night = buildSlideDiagramConfig(SLIDE_THEME_TOKENS.night, "Inter");
  assert.equal(night.themeVariables.darkMode, true);
  assert.equal(night.themeVariables.pie1, slideSeriesPalette(true)[0]);
  assert.equal(night.themeVariables.textColor, SLIDE_THEME_TOKENS.night.foreground);
});

test("text follows the surrounding font size, sequence diagrams included", () => {
  const config = buildSlideDiagramConfig(SLIDE_THEME_TOKENS.light, "Inter", "21px");
  assert.equal(config.themeVariables.fontSize, "21px");
  assert.equal(config.fontSize, 21);
  assert.equal(buildSlideDiagramConfig(SLIDE_THEME_TOKENS.light, "Inter").fontSize, 16);
});

test("node fills are tints between the surface and the series color", () => {
  const { themeVariables } = buildSlideDiagramConfig(SLIDE_THEME_TOKENS.light, "Inter");
  assert.equal(themeVariables.primaryColor, mixHex("#2a78d6", "#ffffff", 0.16));
});

test("parse errors are shortened to where and what", () => {
  const error = new Error("Parse error on line 2:\n...A --> \n-----------^\nExpecting 'NODE_STRING', got 'EOF'");
  assert.equal(slideDiagramErrorMessage(error), "Diagram error: Parse error on line 2. Expecting 'NODE_STRING', got 'EOF'");
  assert.equal(slideDiagramErrorMessage(new Error("No diagram type detected")), "Diagram error: No diagram type detected");
  assert.equal(slideDiagramErrorMessage(""), "Diagram error.");
});
