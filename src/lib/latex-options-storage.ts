import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_LATEX_OPTIONS, parseLatexOptions, type LatexOptions } from "./latex-options";

function preferencesPath() {
  const directory = process.env.LIBERA_CONFIG_PATH
    ? path.dirname(process.env.LIBERA_CONFIG_PATH)
    : path.resolve(process.env.LIBERA_DATA_DIR || path.join(process.cwd(), "data", "libera"), ".libera");
  return path.join(directory, "latex-options.json");
}

export async function readLatexOptions() {
  let content: string;
  try { content = await readFile(preferencesPath(), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_LATEX_OPTIONS;
    throw error;
  }
  // Invalid or outdated preferences must not prevent opening the exporter.
  try { return parseLatexOptions(JSON.parse(content)); } catch { return DEFAULT_LATEX_OPTIONS; }
}

export async function writeLatexOptions(input: LatexOptions) {
  const options = parseLatexOptions(input);
  const target = preferencesPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(options, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return options;
}
