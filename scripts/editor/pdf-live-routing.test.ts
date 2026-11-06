import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { PATCH } from "../../src/app/api/pdf-annotations/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { copyFileIntoSharedDirectory } from "../../src/lib/collab/shared-writes";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { changePdfComments } from "../../src/lib/storage/pdf-comments";
import type { FileOpRequest } from "../../src/lib/collab/local-api";

const annotation = (id: string) => ({ id, type: "text", pageNumber: 1, text: id, fontSize: 10, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" });

test("PDF authority routing and copy", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-pdf-routing-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const previous = keys.map((key) => process.env[key]);
  const fetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_COLLAB_HOST_URL = "http://host.test";
  process.env.LIBERA_COLLAB_HOST_TOKEN = "test-token";
  try {
    await createNotebook("Shared");
    const source = filePathFromParts("Shared", ["source.pdf"]);
    await writeFile(source, "%PDF-1.4\n%%EOF\n");
    await writeFile(path.join(path.dirname(source), ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.test", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
    invalidateSharedNotebookCache();
    const sidecar = pdfAnnotationsPath("Shared", ["source.pdf"]);
    await mkdir(path.dirname(sidecar), { recursive: true });
    const original = JSON.stringify({ annotations: [annotation("stale-sidecar")] });
    await writeFile(sidecar, original);
    const request = () => new NextRequest("http://localhost/api/pdf-annotations", { method: "PATCH", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, "content-type": "application/json" }, body: JSON.stringify({ path: "Shared/source.pdf", annotations: [annotation("local-write")] }) });

    await t.test("F14: resolution failure cannot authorize sidecar annotations or comments", async () => {
      globalThis.fetch = async () => { throw new Error("host restarting"); };
      assert.equal((await PATCH(request())).status, 503);
      await assert.rejects(changePdfComments("Shared/source.pdf", { action: "comment", anchor: { segments: [{ pageNumber: 1, rects: [{ x: 0, y: 0, width: 0.2, height: 0.1 }] }], quote: "test" }, text: "isolated" }), /not running/);
      assert.equal(await readFile(sidecar, "utf8"), original);
      delete process.env.LIBERA_COLLAB_HOST_URL;
      assert.equal((await PATCH(request())).status, 503);
      assert.equal(await readFile(sidecar, "utf8"), original);
      process.env.LIBERA_COLLAB_HOST_URL = "http://host.test";
    });

    await t.test("F14: confirmed local still writes and confirmed live refuses", async () => {
      globalThis.fetch = async () => Response.json(null);
      assert.equal((await PATCH(request())).status, 200);
      assert.equal(JSON.parse(await readFile(sidecar, "utf8")).annotations[0].id, "local-write");
      globalThis.fetch = async () => Response.json({ docId: "pdf_live" });
      assert.equal((await PATCH(request())).status, 409);
    });

    await t.test("F12: copy sends current host marks with fresh ids as part of publishing the blob", async () => {
      await writeFile(sidecar, original);
      const seen: FileOpRequest[] = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/pdf-docs/resolve") return Response.json({ docId: "pdf_live", projectId: "prj_test", fileId: "fil_source", accountId: "acc_me", path: "Shared/source.pdf" });
        if (url.pathname === "/pdf-docs/pdf_live/snapshot") return Response.json({ marks: [annotation("fresh-from-host")], comments: [] });
        if (url.pathname === "/projects") return Response.json([{ projectId: "prj_test", notebook: "Shared", pdfLive: true }]);
        if (url.pathname.endsWith("/files")) {
          const operation = JSON.parse(String(init?.body)) as FileOpRequest;
          seen.push(operation);
          await writeFile(filePathFromParts("Shared", operation.path.split("/")), Buffer.from(operation.contentBase64!, "base64"));
          return Response.json({ paths: [`Shared/${operation.path}`] });
        }
        throw new Error(`Unexpected host call: ${url}`);
      };
      await copyFileIntoSharedDirectory("Shared/source.pdf", "Shared", "copy.pdf");
      assert.equal(seen.length, 1);
      const copied = seen[0].pdfSeed!.marks as Array<{ id: string; text: string }>;
      assert.equal(copied[0].text, "fresh-from-host");
      assert.notEqual(copied[0].id, "fresh-from-host");
      await assert.rejects(readFile(pdfAnnotationsPath("Shared", ["copy.pdf"])), { code: "ENOENT" }, "a delayed copied sidecar cannot race document initialization");
    });
  } finally {
    globalThis.fetch = fetch;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    invalidateSharedNotebookCache();
    await rm(directory, { recursive: true, force: true });
  }
});
