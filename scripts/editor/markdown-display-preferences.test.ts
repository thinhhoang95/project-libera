import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { PUT } from "../../src/app/api/preferences/markdown-display/route";
import { readMarkdownDisplayPreferences, writeMarkdownDisplayPreferences } from "../../src/lib/storage/markdown-display-preferences";
import { getAdminRoot } from "../../src/lib/storage/paths";
import { normalizeMarkdownDisplayPreferences } from "../../src/lib/markdown-display-preferences";

test("display preferences persist independently of browser origins and reject unauthenticated or invalid writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-display-"));
  const before = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = root;
  const request = (body: unknown, authenticated = true) => new NextRequest("http://localhost:51029/api/preferences/markdown-display", {
    method: "PUT", headers: { "Content-Type": "application/json", ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.deepEqual(await readMarkdownDisplayPreferences(), {});
    assert.equal((await PUT(request({ textWidth: 0, textScale: 135 }, false))).status, 401);
    assert.equal((await PUT(request({ textWidth: "wide", textScale: 135 }))).status, 400);
    assert.equal((await PUT(request({ textWidth: 0, textScale: 135 }))).status, 200);
    // Settings saved before the widths were split: LaTeX and plain text start from the Markdown width.
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 0, latexTextWidth: 0, codeTextWidth: 0, textScale: 135, latexTextScale: 135, codeTextScale: 100, outlineExpansionLevel: 6, latexSpellcheck: true });
    const target = path.join(getAdminRoot(), ".libera", "markdown-display.json");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { textWidth: 0, latexTextWidth: 0, codeTextWidth: 0, textScale: 135, latexTextScale: 135, codeTextScale: 100, outlineExpansionLevel: 6, latexSpellcheck: true });
    assert.deepEqual(await readdir(path.dirname(target)), ["markdown-display.json"], "Atomic saves leave no temporary files");
    assert.equal((await PUT(request({ textWidth: 75, textScale: 100, outlineExpansionLevel: "deep" }))).status, 400);
    assert.equal((await PUT(request({ textWidth: 75, latexTextWidth: "wide", textScale: 100 }))).status, 400);
    assert.equal((await PUT(request({ textWidth: 75, codeTextWidth: null, textScale: 100 }))).status, 400);
    assert.equal((await PUT(request({ textWidth: 75, codeTextScale: "big", textScale: 100 }))).status, 400);
    // Text files keep their own zoom, never taken from the Markdown and LaTeX one.
    assert.equal(normalizeMarkdownDisplayPreferences({ textScale: 150 }).codeTextScale, 100);
    assert.deepEqual(normalizeMarkdownDisplayPreferences({ textScale: 150, codeTextScale: 300 }).codeTextScale, 250);
    // Settings saved while Markdown and LaTeX shared one zoom: LaTeX starts from it, then each keeps its own.
    assert.equal(normalizeMarkdownDisplayPreferences({ textScale: 150 }).latexTextScale, 150);
    assert.equal((await PUT(request({ textWidth: 75, textScale: 100, latexTextScale: "big" }))).status, 400);
    assert.equal((await PUT(request({ textWidth: 75, textScale: 120, latexTextScale: 90 }))).status, 200);
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 75, latexTextWidth: 75, codeTextWidth: 75, textScale: 120, latexTextScale: 90, codeTextScale: 100, outlineExpansionLevel: 6, latexSpellcheck: true });
    // Each editor family keeps its own width.
    assert.equal((await PUT(request({ textWidth: 60, latexTextWidth: 40, codeTextWidth: 100, textScale: 100 }))).status, 200);
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 60, latexTextWidth: 40, codeTextWidth: 100, textScale: 100, latexTextScale: 100, codeTextScale: 100, outlineExpansionLevel: 6, latexSpellcheck: true });
    await writeMarkdownDisplayPreferences({ textWidth: 120, latexTextWidth: -5, codeTextWidth: 101, textScale: 20, latexTextScale: 20, codeTextScale: 20, outlineExpansionLevel: 0, latexSpellcheck: true });
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 100, latexTextWidth: 0, codeTextWidth: 100, textScale: 75, latexTextScale: 75, codeTextScale: 75, outlineExpansionLevel: 1, latexSpellcheck: true });
    await writeMarkdownDisplayPreferences({ textWidth: 75, latexTextWidth: 50, codeTextWidth: 90, textScale: 100, latexTextScale: 100, codeTextScale: 100, outlineExpansionLevel: 4, latexSpellcheck: true });
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 75, latexTextWidth: 50, codeTextWidth: 90, textScale: 100, latexTextScale: 100, codeTextScale: 100, outlineExpansionLevel: 4, latexSpellcheck: true });
    await writeFile(target, "broken JSON");
    assert.deepEqual(normalizeMarkdownDisplayPreferences(await readMarkdownDisplayPreferences()), { textWidth: 75, latexTextWidth: 75, codeTextWidth: 75, textScale: 100, latexTextScale: 100, codeTextScale: 100, outlineExpansionLevel: 6, latexSpellcheck: true });
  } finally {
    if (before === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});
