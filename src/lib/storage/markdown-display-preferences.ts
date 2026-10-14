import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot } from "./paths";
import { normalizeMarkdownDisplayPreferences, type MarkdownDisplayPreferences } from "../markdown-display-preferences";
import { writeJsonState } from "./json-state";

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
  const preferences = normalizeMarkdownDisplayPreferences(input);
  await writeJsonState(preferencePath(), preferences);
  return preferences;
}
