import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LATEX_OPTIONS } from "../../src/lib/latex-options";
import { readLatexOptions, writeLatexOptions } from "../../src/lib/latex-options-storage";

test("LaTeX settings survive disk reloads and recover from invalid stored data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-settings-test-"));
  const previous = process.env.LIBERA_CONFIG_PATH;
  process.env.LIBERA_CONFIG_PATH = path.join(directory, "config.json");
  try {
    assert.deepEqual(await readLatexOptions(), DEFAULT_LATEX_OPTIONS);
    const selected = { ...DEFAULT_LATEX_OPTIONS, author: "Thinh Hoang", date: "2026-09-09", paperSize: "a5" as const, fontSize: 11 as const, imageWidth: 0.6,
      margins: { left: 0.8, right: 0.9, top: 1.1, bottom: 1.2 },
      header: "Header", footer: "Footer", showAppName: true, customInstructions: "Add a table of contents.\nUse blue headings." };
    await writeLatexOptions(selected);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "latex-options.json"), "utf8")), selected);
    assert.deepEqual(await readLatexOptions(), selected);
    await writeFile(path.join(directory, "latex-options.json"), "broken json");
    assert.deepEqual(await readLatexOptions(), DEFAULT_LATEX_OPTIONS);
    await writeLatexOptions(selected);
    assert.deepEqual(await readLatexOptions(), selected);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_CONFIG_PATH;
    else process.env.LIBERA_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
