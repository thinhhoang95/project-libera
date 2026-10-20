import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelDownloader, defaultModelDirectory } from "../../src/lib/models/downloader";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function serve(files: Record<string, Buffer>) {
  const ranges: string[] = [];
  const server: Server = createServer((request, response) => {
    const body = files[request.url ?? ""];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const range = /bytes=(\d+)-/.exec(request.headers.range ?? "");
    if (range) {
      ranges.push(`${request.url}:${range[1]}`);
      response.writeHead(206, { "Content-Length": body.length - Number(range[1]) }).end(body.subarray(Number(range[1])));
    } else {
      response.writeHead(200, { "Content-Length": body.length }).end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ranges, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function finished(downloader: ModelDownloader, directory: string) {
  while (downloader.progress(directory)?.running) await new Promise((resolve) => setTimeout(resolve, 5));
  return downloader.progress(directory)!;
}

test("a model download checks sizes and checksums, resumes, and keeps broken files out", async () => {
  const weights = Buffer.from("weights ".repeat(1000));
  const config = Buffer.from("{}");
  const server = await serve({ "/onnx/model.onnx": weights, "/config.json": config });
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-model-"));
  try {
    const files = [
      { url: `${server.url}/config.json`, target: "config.json", size: config.length, sha256: null },
      { url: `${server.url}/onnx/model.onnx`, target: "onnx/model.onnx", size: weights.length, sha256: sha256(weights) },
    ];

    // A half-finished file resumes from where it stopped.
    await writeFile(path.join(directory, "config.json"), config);
    await mkdir(path.join(directory, "onnx"), { recursive: true });
    await writeFile(path.join(directory, "onnx", "model.onnx.part"), weights.subarray(0, 100));
    const downloader = new ModelDownloader();
    downloader.start(directory, files);
    const done = await finished(downloader, directory);
    assert.equal(done.error, "");
    assert.equal(done.downloadedBytes, done.totalBytes);
    assert.deepEqual(server.ranges, ["/onnx/model.onnx:100"]);
    assert.deepEqual(await readFile(path.join(directory, "onnx", "model.onnx")), weights);

    // A wrong checksum is reported and leaves no file behind.
    const other = new ModelDownloader();
    other.start(directory, [{ ...files[1], target: "onnx/bad.onnx", sha256: "0".repeat(64) }]);
    const failed = await finished(other, directory);
    assert.match(failed.error, /did not match its checksum/);
    await assert.rejects(readFile(path.join(directory, "onnx", "bad.onnx")));
    await assert.rejects(readFile(path.join(directory, "onnx", "bad.onnx.part")));

    // Files listed once the download starts.
    const listed = new ModelDownloader();
    listed.start(path.join(directory, "listed"), async () => [files[0]], 999);
    assert.equal(listed.progress(path.join(directory, "listed"))?.totalBytes, 999);
    assert.equal((await finished(listed, path.join(directory, "listed"))).totalBytes, config.length);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("models download into Libera's application data unless Preferences names a folder", () => {
  const saved = process.env.LIBERA_CONFIG_PATH;
  try {
    process.env.LIBERA_CONFIG_PATH = path.join(os.tmpdir(), "Libera", "config.json");
    if (process.platform !== "win32") {
      assert.equal(defaultModelDirectory("readAloud"), path.join(os.tmpdir(), "Libera", "models", "kokoro-int8-multi-lang-v1_0"));
    }
    delete process.env.LIBERA_CONFIG_PATH;
    assert.match(defaultModelDirectory("search"), /[\\/]\.libera[\\/]models[\\/]embeddinggemma-2-ONNX$/);
  } finally {
    if (saved === undefined) delete process.env.LIBERA_CONFIG_PATH;
    else process.env.LIBERA_CONFIG_PATH = saved;
  }
});
