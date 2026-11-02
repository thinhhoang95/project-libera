import assert from "node:assert/strict";
import test from "node:test";
import { relativeTimeLabel } from "../../src/lib/relative-time";

test("relative time labels are compact and round down", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const ago = (ms: number) => relativeTimeLabel(now - ms, now);
  assert.equal(ago(10_000), "just now");
  assert.equal(ago(5 * 60_000), "5m ago");
  assert.equal(ago(12.9 * 3_600_000), "12h ago");
  assert.equal(ago(2 * 86_400_000), "2d ago");
  assert.equal(ago(95 * 86_400_000), "3mo ago");
  assert.equal(ago(800 * 86_400_000), "2y ago");
  assert.equal(relativeTimeLabel(now + 60_000, now), "just now");
  assert.equal(relativeTimeLabel("not a date", now), "");
});
