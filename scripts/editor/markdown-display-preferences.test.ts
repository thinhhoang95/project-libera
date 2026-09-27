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
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 0, textScale: 135, outlineExpansionLevel: 6 });
    const target = path.join(getAdminRoot(), ".libera", "markdown-display.json");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { textWidth: 0, textScale: 135, outlineExpansionLevel: 6 });
    assert.deepEqual(await readdir(path.dirname(target)), ["markdown-display.json"], "Atomic saves leave no temporary files");
    assert.equal((await PUT(request({ textWidth: 75, textScale: 100, outlineExpansionLevel: "deep" }))).status, 400);
    await writeMarkdownDisplayPreferences({ textWidth: 120, textScale: 20, outlineExpansionLevel: 0 });
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 100, textScale: 75, outlineExpansionLevel: 1 });
    await writeMarkdownDisplayPreferences({ textWidth: 75, textScale: 100, outlineExpansionLevel: 4 });
    assert.deepEqual(await readMarkdownDisplayPreferences(), { textWidth: 75, textScale: 100, outlineExpansionLevel: 4 });
    await writeFile(target, "broken JSON");
    assert.deepEqual(normalizeMarkdownDisplayPreferences(await readMarkdownDisplayPreferences()), { textWidth: 75, textScale: 100, outlineExpansionLevel: 6 });
  } finally {
    if (before === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});
