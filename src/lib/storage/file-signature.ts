import { stat } from "node:fs/promises";

/** Raw file identity, independent of annotation dates and millisecond rounding. */
export async function readFileSignature(filePath: string) {
  const stats = await stat(filePath, { bigint: true });
  if (!stats.isFile()) throw new Error("Path is not a file.");
  return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.dev}:${stats.ino}:${filePath}`;
}
