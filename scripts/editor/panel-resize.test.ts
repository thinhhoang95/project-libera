import assert from "node:assert/strict";
import test from "node:test";
import { chatWidthFromPointer, clampSidebarWidth, sidebarWidthFromPointer } from "../../src/components/libera/panel-resize";

const layout = { left: 100, right: 1300, width: 1200 };

test("the sidebar follows the pointer inside the layout and keeps room for the workspace and chat", () => {
  assert.equal(sidebarWidthFromPointer(100 + 400, layout, 0), 400);
  assert.equal(sidebarWidthFromPointer(0, layout, 0), 240, "never narrower than the minimum");
  assert.equal(sidebarWidthFromPointer(1250, layout, 0), 560, "never wider than the maximum");
  // 1200 wide with a 360 chat panel leaves 840; minus the 480 workspace is 360.
  assert.equal(sidebarWidthFromPointer(1250, layout, 360), 360);
  assert.equal(sidebarWidthFromPointer(100 + 300.4, layout, 0), 300, "whole pixels");
  assert.equal(sidebarWidthFromPointer(700, null, 0), 560, "an unmeasured layout only applies the fixed limits");
  assert.equal(clampSidebarWidth(1000), 560);
});

test("the chat panel's width is the distance from the pointer to the layout's right edge", () => {
  assert.equal(chatWidthFromPointer(1300 - 400, layout, 320, 360), 400);
  assert.equal(chatWidthFromPointer(1290, layout, 320, 360), 280, "never narrower than the minimum");
  assert.equal(chatWidthFromPointer(200, layout, 320, 360), 560, "never wider than the maximum");
  // 1200 - 900 sidebar - 320 minimum workspace leaves nothing: the minimum wins.
  assert.equal(chatWidthFromPointer(200, layout, 900, 360), 280);
  // 1200 - 600 - 320 = 280 available, below what the pointer asks for.
  assert.equal(chatWidthFromPointer(300, layout, 600, 360), 280);
  assert.equal(chatWidthFromPointer(1000, null, 320, 360), 360, "an unmeasured layout keeps the current width");
});
