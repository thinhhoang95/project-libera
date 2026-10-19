// Content-addressed blob storage. Blobs are immutable and keyed by their
// sha256, so a store never overwrites and the same bytes shared by several
// projects are kept once. Which projects may read a blob is recorded in the
// `blobs` table, not here.

import type { Readable } from "node:stream";

import type { Config } from "../config.js";
import type { ServerContext } from "../context.js";
import { createDiskBlobStore } from "./disk.js";
import { createS3BlobStore } from "./s3.js";

export { assertBlobHash, isBlobHash } from "./hash.js";

export interface BlobStore {
  /** Stores the bytes under `hash` (already verified by the caller). A no-op when present. */
  put(hash: string, data: Uint8Array, mime: string): Promise<void>;
  /** A stream of the bytes, or null when the store does not have them. */
  get(hash: string): Promise<Readable | null>;
  has(hash: string): Promise<boolean>;
}

export function createBlobStore(config: Config): BlobStore {
  if (config.BLOB_DRIVER === "s3") {
    const { BLOB_S3_ENDPOINT, BLOB_S3_BUCKET, BLOB_S3_ACCESS_KEY, BLOB_S3_SECRET_KEY, BLOB_S3_REGION } = config;
    if (!BLOB_S3_ENDPOINT || !BLOB_S3_BUCKET || !BLOB_S3_ACCESS_KEY || !BLOB_S3_SECRET_KEY) {
      throw new Error("BLOB_DRIVER=s3 needs BLOB_S3_ENDPOINT, BLOB_S3_BUCKET, BLOB_S3_ACCESS_KEY and BLOB_S3_SECRET_KEY.");
    }
    return createS3BlobStore({
      endpoint: BLOB_S3_ENDPOINT,
      bucket: BLOB_S3_BUCKET,
      region: BLOB_S3_REGION,
      accessKeyId: BLOB_S3_ACCESS_KEY,
      secretAccessKey: BLOB_S3_SECRET_KEY,
    });
  }
  return createDiskBlobStore(config.BLOB_DIR);
}

// Like the mailer, the store hangs off the context without a field on it.
const stores = new WeakMap<object, BlobStore>();

export function getBlobStore(context: ServerContext): BlobStore {
  let store = stores.get(context);
  if (!store) {
    store = createBlobStore(context.config);
    stores.set(context, store);
  }
  return store;
}

export function setBlobStore(context: ServerContext, store: BlobStore): void {
  stores.set(context, store);
}
