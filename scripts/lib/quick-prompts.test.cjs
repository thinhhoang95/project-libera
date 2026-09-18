const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeQuickPrompts, validateQuickPrompts } = require("../../electron/quick-prompts.cjs");

test("Electron quick prompt preferences normalize and validate stored values", () => {
  assert.deepEqual(normalizeQuickPrompts([
    { identifier: "/summary", prompt: "Summarize $1" },
    { identifier: "SUMMARY", prompt: "Duplicate" },
    { identifier: "invalid value", prompt: "Ignored" },
  ]), [{ identifier: "summary", prompt: "Summarize $1" }]);
  assert.deepEqual(validateQuickPrompts([{ identifier: "/rewrite", prompt: "Rewrite $1 in the style of $2." }]), [
    { identifier: "rewrite", prompt: "Rewrite $1 in the style of $2." },
  ]);
  assert.throws(() => validateQuickPrompts([{ identifier: "same", prompt: "One" }, { identifier: "SAME", prompt: "Two" }]), /already in use/);
  assert.throws(() => validateQuickPrompts([{ identifier: "bad id", prompt: "Text" }]), /letters, numbers/);
  assert.throws(() => validateQuickPrompts([{ identifier: "empty", prompt: " " }]), /needs prompt text/);
});
