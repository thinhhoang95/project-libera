// S3-compatible blob driver (AWS S3, MinIO, R2) over fetch with path-style
// URLs: <endpoint>/<bucket>/<key>. Path style works with MinIO out of the box
// and with AWS for buckets whose names are not DNS-safe.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { assertBlobHash } from "./hash.js";
import type { BlobStore } from "./index.js";
import { EMPTY_SHA256, signRequest } from "./sigv4.js";

export interface S3Options {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createS3BlobStore(options: S3Options): BlobStore {
  const base = options.endpoint.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  function urlFor(hash: string): URL {
    assertBlobHash(hash);
    return new URL(`${base}/${encodeURIComponent(options.bucket)}/${hash.slice(0, 2)}/${hash}`);
  }

  async function send(method: string, hash: string, body?: Uint8Array, extra: Record<string, string> = {}) {
    const url = urlFor(hash);
    const payloadHash = body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256;
    const { headers } = signRequest({
      method,
      url,
      headers: { ...extra, "x-amz-content-sha256": payloadHash },
      payloadHash,
      region: options.region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      date: now(),
    });
    // fetch derives Host from the URL itself (the same value that was signed).
    delete headers.host;
    // Bodies are request buffers, never SharedArrayBuffer views, which is all
    // BodyInit's narrower type rules out.
    return doFetch(url, { method, headers, body: body as Uint8Array<ArrayBuffer> | undefined });
  }

  async function failure(response: Response, action: string): Promise<Error> {
    const text = await response.text().catch(() => "");
    return new Error(`S3 ${action} failed with ${response.status}: ${text.slice(0, 300)}`);
  }

  return {
    async put(hash, data, mime) {
      const response = await send("PUT", hash, data, { "content-type": mime });
      if (!response.ok) throw await failure(response, "PUT");
      await response.body?.cancel();
    },
    async get(hash) {
      const response = await send("GET", hash);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body) throw await failure(response, "GET");
      return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    },
    async has(hash) {
      const response = await send("HEAD", hash);
      await response.body?.cancel();
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`S3 HEAD failed with ${response.status}`);
      return true;
    },
  };
}
