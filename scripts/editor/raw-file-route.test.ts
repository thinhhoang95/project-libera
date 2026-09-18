import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/api/files/raw/[...path]/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";

test("raw files with Unicode names load without corrupting their bytes or filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-raw-file-"));
  const previousRoot = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const notebook = "RegulationZero";
  const name = "General CV—GWU(F) - copie.pdf";
  const bytes = Buffer.from("%PDF-1.3\nPDF fixture\n%%EOF\n");
  const filePath = path.join(directory, "users", "admin", notebook, name);
  function request(authenticated = true) {
    return new NextRequest(`http://localhost/api/files/raw/${notebook}/${encodeURIComponent(name)}`, {
      headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {},
    });
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    const context = { params: Promise.resolve({ path: [notebook, name] }) };
    assert.equal((await GET(request(false), context)).status, 401);
    const response = await GET(request(), context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const disposition = response.headers.get("Content-Disposition")!;
    assert.ok(disposition.startsWith("inline;"));
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
  } finally {
    if (previousRoot === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
