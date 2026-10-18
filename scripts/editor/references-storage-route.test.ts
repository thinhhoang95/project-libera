import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PATCH } from "../../src/app/api/references/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { referenceLibraryPath } from "../../src/lib/storage/paths";
import { pendingReferenceReattach } from "../../src/lib/storage/references";
import type { ReferenceLibrary } from "../../src/lib/references/types";

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });

function get(notebook: string | null, authenticated = true) {
  const query = notebook === null ? "" : `?notebook=${encodeURIComponent(notebook)}`;
  return GET(new NextRequest(`http://localhost/api/references${query}`, { headers: authenticated ? cookie() : {} }));
}

function patch(body: unknown, authenticated = true) {
  return PATCH(new NextRequest("http://localhost/api/references", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(authenticated ? cookie() : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("the references API reads, applies ops, reports conflicts and rejects invalid input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-route-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Notes");
    assert.equal((await get("Notes", false)).status, 401);
    assert.equal((await patch({ notebook: "Notes", revision: 0, ops: [] }, false)).status, 401);

    let response = await get("Notes");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { library: { version: 1, revision: 0, style: "apa", entries: {} } });
    assert.equal((await get("Missing")).status, 404);
    assert.equal((await get(null)).status, 400);
    assert.equal((await get("../Notes")).status, 400);

    response = await patch({ notebook: "Notes", revision: 0, ops: [{ op: "add", entry: { key: "smith", csl: { type: "book", title: "T" } } }] });
    assert.equal(response.status, 200);
    const { library } = await response.json() as { library: ReferenceLibrary };
    assert.equal(library.revision, 1);
    assert.equal(Object.values(library.entries)[0].key, "smith");

    response = await patch({ notebook: "Notes", revision: 0, ops: [{ op: "set-style", style: "ieee" }] });
    assert.equal(response.status, 409);
    const conflict = await response.json() as { error: string; library: ReferenceLibrary };
    assert.match(conflict.error, /changed/);
    assert.deepEqual(conflict.library, library);

    response = await patch({ notebook: "Notes", revision: 1, ops: [{ op: "set-style", style: "ieee" }, { op: "delete", id: "ref_unknown" }] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /no longer in the library/);

    for (const body of [
      "{ not json",
      [],
      { revision: 1, ops: [] },
      { notebook: "Notes", ops: [] },
      { notebook: "Notes", revision: -1, ops: [] },
      { notebook: "Notes", revision: 1.5, ops: [] },
      { notebook: "Notes", revision: 1, ops: {} },
      { notebook: "../x", revision: 1, ops: [] },
    ]) {
      response = await patch(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal((await patch({ notebook: "Missing", revision: 0, ops: [] })).status, 404);
    response = await patch({ notebook: "Notes", revision: 1, ops: [{ op: "attach", id: Object.keys(library.entries)[0], attachment: { kind: "pdf", path: "Notes/missing.pdf" } }] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /was not found/);

    await mkdir(path.dirname(referenceLibraryPath("Notes")), { recursive: true });
    await writeFile(referenceLibraryPath("Notes"), JSON.stringify({ version: 9, revision: 0, style: "apa", entries: {} }));
    assert.equal((await get("Notes")).status, 409);
  } finally {
    await pendingReferenceReattach();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
