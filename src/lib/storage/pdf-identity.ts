import { readFileContentHash, readFileSignature } from "@/lib/storage/file-signature";

// A PDF's portable identity — its size and SHA-256 — recorded in its
// side-cars, so a side-car whose PDF was renamed or moved outside Libera can
// find it again (pdf-sidecars.ts). Hashes are remembered by file signature:
// annotations are saved often, and rehashing a large PDF on every stroke is
// wasteful. A stale hash after a same-size, same-time rewrite only weakens
// that search, never the checks that guard writes (file-signature.ts).

export type PdfIdentity = { size: number; contentHash: string };

const MAX_REMEMBERED = 256;
const identities = new Map<string, Promise<PdfIdentity>>();

export async function cachedPdfIdentity(absolutePath: string): Promise<PdfIdentity> {
  const signature = await readFileSignature(absolutePath);
  const known = identities.get(signature);
  if (known) return known;
  const task = readFileContentHash(absolutePath).then((contentHash) => ({ size: Number(signature.split(":")[0]), contentHash }));
  identities.set(signature, task);
  task.catch(() => { if (identities.get(signature) === task) identities.delete(signature); });
  while (identities.size > MAX_REMEMBERED) identities.delete(identities.keys().next().value!);
  return task;
}

export function parsePdfIdentity(value: unknown): PdfIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { size, contentHash } = value as { size?: unknown; contentHash?: unknown };
  return typeof size === "number" && Number.isFinite(size) && typeof contentHash === "string" && /^[0-9a-f]{64}$/.test(contentHash)
    ? { size, contentHash }
    : null;
}
