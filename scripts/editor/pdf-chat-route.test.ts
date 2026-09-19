import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/api/document-chat/pdf/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { filePathFromParts, pdfTextCachePath } from "../../src/lib/storage/paths";

// A small valid PDF exercises the same extraction code used for real documents.
function pdfFixture() {
  const stream = "BT /F1 12 Tf 20 100 Td (Complete PDF text) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test("PDF chat context authenticates and extracts page-labelled text with size and path checks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-pdf-chat-"));
  const previousRoot = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const file = filePathFromParts("Notes", ["paper.pdf"]);
  const cachePath = pdfTextCachePath("Notes", ["paper.pdf"]);
  function request(filePath = "Notes/paper.pdf", authenticated = true) {
    return new NextRequest(`http://localhost/api/document-chat/pdf?path=${encodeURIComponent(filePath)}`, { headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {} });
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, pdfFixture());
    assert.equal((await GET(request(undefined, false))).status, 401);
    assert.equal((await GET(request("Notes/../../outside.pdf"))).status, 400);
    assert.equal((await GET(request("Notes/paper.md"))).status, 400);
    assert.equal((await GET(request("Notes/missing.pdf"))).status, 404);
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "## Page 1\n\nComplete PDF text" });
    const stats = await stat(file);
    async function cachedPages(pages: { pageNumber: number; text: string }[]) {
      await writeFile(cachePath, JSON.stringify({ version: 1, path: "Notes/paper.pdf", pdfUpdatedAt: stats.mtime.toISOString(), pdfSize: stats.size, generatedAt: new Date().toISOString(), pages }));
    }
    await cachedPages([{ pageNumber: 1, text: "First page" }, { pageNumber: 2, text: "Second page" }]);
    assert.deepEqual(await (await GET(request())).json(), { text: "## Page 1\n\nFirst page\n\n## Page 2\n\nSecond page" });
    await cachedPages([{ pageNumber: 1, text: "" }]);
    const empty = await GET(request());
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /no extractable text/);
    await cachedPages([{ pageNumber: 1, text: "x".repeat(500_001) }]);
    assert.equal((await GET(request())).status, 413);
  } finally {
    if (previousRoot === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
