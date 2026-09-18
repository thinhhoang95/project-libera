import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConfiguredQuickPrompts } from "../../src/lib/quick-prompts-config";
import { insertQuickPrompt, matchingQuickPrompts, normalizeQuickPrompts } from "../../src/lib/quick-prompts";

test("quick prompts normalize, deduplicate, and match identifiers", () => {
  const prompts = normalizeQuickPrompts([
    { identifier: "/summarize", prompt: "Summarize $1" },
    { identifier: "review", prompt: "Review this" },
    { identifier: "SUMMARIZE", prompt: "Duplicate" },
    { identifier: "bad identifier", prompt: "Ignored" },
    { identifier: "empty", prompt: "  " },
  ]);
  assert.deepEqual(prompts, [
    { identifier: "summarize", prompt: "Summarize $1" },
    { identifier: "review", prompt: "Review this" },
  ]);
  assert.deepEqual(matchingQuickPrompts(prompts, "mar").map((item) => item.identifier), ["summarize"]);
});

test("quick prompt insertion replaces the slash token and selects $1", () => {
  assert.deepEqual(insertQuickPrompt("Please /review later", 7, 14, "Review $1 against $2."), {
    value: "Please Review $1 against $2. later",
    selectionStart: 14,
    selectionEnd: 16,
  });
  assert.deepEqual(insertQuickPrompt("/hello", 0, 6, "Hello there"), {
    value: "Hello there",
    selectionStart: 11,
    selectionEnd: 11,
  });
});

test("configured quick prompts load from the Electron config", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "libera-quick-prompts-"));
  const configPath = path.join(directory, "config.json");
  const originalConfigPath = process.env.LIBERA_CONFIG_PATH;
  try {
    writeFileSync(configPath, JSON.stringify({ quickPrompts: [{ identifier: "explain", prompt: "Explain $1." }] }));
    process.env.LIBERA_CONFIG_PATH = configPath;
    assert.deepEqual(getConfiguredQuickPrompts(), [{ identifier: "explain", prompt: "Explain $1." }]);
  } finally {
    if (originalConfigPath === undefined) delete process.env.LIBERA_CONFIG_PATH;
    else process.env.LIBERA_CONFIG_PATH = originalConfigPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
