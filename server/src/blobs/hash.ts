// Blob keys are sha256 hex digests. They become file paths and object keys,
// so nothing else may reach a driver.

export function isBlobHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function assertBlobHash(hash: string): void {
  if (!isBlobHash(hash)) throw new Error(`Invalid blob hash: ${hash}`);
}
