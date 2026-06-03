import { readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_NOTEBOOK_COLOR,
  DEFAULT_NOTEBOOK_EMOJI,
} from "@/lib/storage/constants";
import { notebookMetadataPath } from "@/lib/storage/paths";
import type { LiberaNotebookMetadata } from "@/lib/types";

function normalizeNotebookColor(color: string | undefined) {
  const trimmed = color?.trim();

  if (!trimmed) {
    return DEFAULT_NOTEBOOK_COLOR;
  }

  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : DEFAULT_NOTEBOOK_COLOR;
}

function normalizeNotebookEmoji(emoji: string | undefined) {
  const trimmed = emoji?.trim();

  if (!trimmed) {
    return DEFAULT_NOTEBOOK_EMOJI;
  }

  return Array.from(trimmed).slice(0, 2).join("");
}

function normalizeNotebookGroupId(groupId: string | null | undefined) {
  const trimmed = groupId?.trim();
  return trimmed || null;
}

export function normalizeNotebookMetadata(
  input: Partial<LiberaNotebookMetadata> | undefined,
  fallbackCreatedAt: string,
): LiberaNotebookMetadata {
  return {
    createdAt:
      typeof input?.createdAt === "string" && input.createdAt.trim()
        ? input.createdAt
        : fallbackCreatedAt,
    color: normalizeNotebookColor(input?.color),
    emoji: normalizeNotebookEmoji(input?.emoji),
    groupId: normalizeNotebookGroupId(input?.groupId),
  };
}

export async function readNotebookMetadata(
  notebook: string,
  fallbackCreatedAt: string,
): Promise<LiberaNotebookMetadata> {
  try {
    const metadata = JSON.parse(
      await readFile(notebookMetadataPath(notebook), "utf8"),
    ) as Partial<LiberaNotebookMetadata>;

    return normalizeNotebookMetadata(metadata, fallbackCreatedAt);
  } catch {
    return normalizeNotebookMetadata(undefined, fallbackCreatedAt);
  }
}

export async function writeNotebookMetadata(
  notebook: string,
  metadata: LiberaNotebookMetadata,
) {
  await writeFile(
    notebookMetadataPath(notebook),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}
