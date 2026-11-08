import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_MARKDOWN_PASTE_OPTIONS, parseMarkdownPasteOptions, type MarkdownPasteOptions } from "./markdown-paste/options";
import { joinPath, resolvePath, workingDirectory } from "../runtime-path";

/* The settings of Paste Markdown as LaTeX, per user, next to the LaTeX export options. */

function preferencesPath() {
  const directory = process.env.LIBERA_CONFIG_PATH
    ? path.dirname(process.env.LIBERA_CONFIG_PATH)
    : resolvePath(process.env.LIBERA_DATA_DIR || joinPath(workingDirectory(), "data", "libera"), ".libera");
  return path.join(directory, "latex-markdown-paste.json");
}

export async function readMarkdownPasteOptions(): Promise<MarkdownPasteOptions> {
  let content: string;
  try { content = await readFile(preferencesPath(), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_MARKDOWN_PASTE_OPTIONS;
    throw error;
  }
  // Invalid or outdated settings must not stop a paste.
  try { return parseMarkdownPasteOptions(JSON.parse(content)); } catch { return DEFAULT_MARKDOWN_PASTE_OPTIONS; }
}

export async function writeMarkdownPasteOptions(input: unknown) {
  const options = parseMarkdownPasteOptions(input);
  const target = preferencesPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(options, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return options;
}
