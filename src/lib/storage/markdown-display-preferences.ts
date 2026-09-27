import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot } from "./paths";
import { normalizeMarkdownDisplayPreferences, type MarkdownDisplayPreferences } from "../markdown-display-preferences";

function preferencePath() {
  return path.join(getAdminRoot(), ".libera", "markdown-display.json");
}

export async function readMarkdownDisplayPreferences(): Promise<Partial<MarkdownDisplayPreferences>> {
  try {
    const input = JSON.parse(await readFile(preferencePath(), "utf8"));
    return input && typeof input === "object" ? normalizeMarkdownDisplayPreferences(input) : {};
  } catch { return {}; }
}

export async function writeMarkdownDisplayPreferences(input: MarkdownDisplayPreferences) {
  const target = preferencePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  const preferences = normalizeMarkdownDisplayPreferences(input);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(preferences) + "\n", { mode: 0o600 });
    await rename(temporary, target);
    return preferences;
  } finally { await rm(temporary, { force: true }); }
}
