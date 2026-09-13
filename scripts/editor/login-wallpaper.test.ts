import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { GET, POST } from "../../src/app/api/preferences/login-wallpaper/route";

test("wallpaper upload accepts Electron's host after NextURL normalization and rejects other origins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "libera-wallpaper-test-"));
  const previousRoot = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const image = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#abc" } }).png().toBuffer();
    for (const host of ["127.0.0.1:43127", "localhost:3000", "[::1]:43127"]) {
      const browserOrigin = `http://${host}`;
      const nextRequest = new NextRequest(`${browserOrigin}/api/preferences/login-wallpaper`);
      // Route adapters use NextURL, which rewrites loopback addresses.
      const normalizedUrl = nextRequest.nextUrl.toString();
      assert.equal(new URL(normalizedUrl).hostname, "localhost");
      const request = (origin: string) => new Request(normalizedUrl, {
        method: "POST",
        headers: { host, origin, "content-type": "image/png" },
        body: new Uint8Array(image),
      });
      assert.equal((await POST(request(browserOrigin))).status, 200, host);
      assert.equal((await POST(request("https://untrusted.example"))).status, 403);
      assert.equal((await POST(request("http://127.0.0.1:9999"))).status, 403);
      assert.equal((await POST(request("null"))).status, 403);
    }
    const saved = await GET();
    assert.equal(saved.status, 200);
    const metadata = await sharp(Buffer.from(await saved.arrayBuffer())).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 24);
    assert.equal(metadata.height, 16);
  } finally {
    if (previousRoot === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
