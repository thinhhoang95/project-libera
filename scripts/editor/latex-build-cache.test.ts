import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exists = (file: string) => access(file).then(() => true, () => false);

test("build cache lists generated files and clears only the chosen ones inside the work folder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-latex-cache-test-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const { ADMIN_USER } = await import("../../src/lib/storage/constants");
  const { clearLatexBuildCache, latexBuildPaths, listLatexBuildCache } = await import("../../src/lib/latex/build");
  const rootPath = "Book/paper/main.tex";
  await mkdir(path.join(directory, "users", ADMIN_USER, "Book", "paper"), { recursive: true });
  await writeFile(path.join(directory, "users", ADMIN_USER, "Book", "paper", "main.tex"), "\\documentclass{article}");
  const paths = latexBuildPaths(rootPath);
  try {
    await mkdir(path.join(paths.workDirectory, "chapters"), { recursive: true });
    await mkdir(path.join(paths.outDirectory, "snapshot1"), { recursive: true });
    for (const file of ["main.aux", "main.bbl", "main.fdb_latexmk", "main.pdf", "chapters/one.aux"]) await writeFile(path.join(paths.workDirectory, file), "x");
    await writeFile(path.join(paths.outDirectory, "snapshot1", "main.pdf"), "pdf");
    await writeFile(path.join(paths.buildDirectory, "state.json"), "{}");

    const listed = await listLatexBuildCache(rootPath);
    assert.deepEqual(listed.map((file) => file.path), ["chapters/one.aux", "main.aux", "main.bbl", "main.fdb_latexmk", "main.pdf"]);

    const result = await clearLatexBuildCache(rootPath, ["main.aux", "main.bbl", "chapters/one.aux", "../overrides.json", "../out/snapshot1/main.pdf", "missing.log"]);
    assert.equal(result.removed, 3);
    assert.deepEqual(result.files.map((file) => file.path), ["main.fdb_latexmk", "main.pdf"]);
    assert.equal(await exists(path.join(paths.outDirectory, "snapshot1", "main.pdf")), true, "snapshots stay for the viewer");
    assert.equal(await exists(path.join(paths.buildDirectory, "state.json")), false, "the next compile is forced");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(paths.buildDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
