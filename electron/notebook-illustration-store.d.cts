import type { NotebookIllustrationPreferences } from "./notebook-illustrations.cjs";

export function illustrationsDirectory(adminRoot: string): string;
export function illustrationFilePath(adminRoot: string, setId: string, imageId: string, kind?: "image" | "source"): string;
export function illustrationExists(adminRoot: string): (setId: string, imageId: string) => boolean;
export function saveNotebookIllustrations(
  input: unknown,
  options: { adminRoot: string; previousAdminRoot?: string; checkImage?: (buffer: Buffer) => void },
): Promise<NotebookIllustrationPreferences>;
export function removeUnusedIllustrations(adminRoot: string, preferences: NotebookIllustrationPreferences): Promise<void>;
export function decodeJpegDataUrl(value: unknown): Buffer;
