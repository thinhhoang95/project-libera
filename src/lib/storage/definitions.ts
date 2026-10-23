import { readFile, rm, stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { readFileContentHash } from "@/lib/storage/file-signature";
import { getFileType } from "@/lib/storage/file-types";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { definitionsPath, filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { DEFINITIONS_FILE_TYPES, parseDefinitionsFile, type DefinitionsFile, type DefinitionsPayload } from "@/lib/definitions";

// A document's definitions and notation cards live in a side-car beside the
// notebook's others (like a PDF's annotations): `.libera/definitions/by-path/…`.
// They are a cache the AI Agent writes, so the user can delete them or have
// them written again at any time; moves, copies and deletions of the
// document take them along (files.ts). In a shared notebook `.libera` stays on
// this computer, so each member keeps their own cards.

export function supportsDefinitions(relativePath: string) {
  const fileType = getFileType(relativePath);
  return DEFINITIONS_FILE_TYPES.some((type) => type === fileType);
}

function locate(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  if (!supportsDefinitions(relativePath)) throw new StorageError("Definitions can be generated for Markdown, LaTeX and PDF documents.");
  return { document: filePathFromParts(notebook, pathParts), sidecar: definitionsPath(notebook, pathParts) };
}

async function readSidecar(file: string) {
  try {
    return parseDefinitionsFile(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The document's identity on disk, or null when it is missing. */
export async function readDefinitionsSource(relativePath: string): Promise<DefinitionsFile["source"]> {
  const { document } = locate(relativePath);
  const stats = await stat(document).catch(() => null);
  if (!stats?.isFile()) return null;
  return { size: stats.size, contentHash: await readFileContentHash(document) };
}

/** The cards, and whether the document changed since they were written. */
export async function readDefinitions(relativePath: string): Promise<DefinitionsPayload> {
  const { sidecar } = locate(relativePath);
  const definitions = await readSidecar(sidecar);
  if (!definitions) return { path: relativePath, definitions: null, stale: false };
  const current = await readDefinitionsSource(relativePath);
  const stale = Boolean(definitions.source && current && (current.size !== definitions.source.size || current.contentHash !== definitions.source.contentHash));
  return { path: relativePath, definitions, stale };
}

export async function writeDefinitions(relativePath: string, definitions: DefinitionsFile) {
  const { sidecar } = locate(relativePath);
  await writeJsonAtomically(sidecar, definitions);
}

export async function deleteDefinitions(relativePath: string) {
  const { sidecar } = locate(relativePath);
  await rm(sidecar, { force: true });
}
