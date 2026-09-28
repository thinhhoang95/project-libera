import { readFileSync } from "node:fs";
import { normalizeQuickPrompts, type QuickPrompt } from "@/lib/quick-prompts";

export function getConfiguredQuickPrompts(): QuickPrompt[] {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { quickPrompts?: unknown };
      return normalizeQuickPrompts(config.quickPrompts);
    } catch {
      return [];
    }
  }

  try {
    return normalizeQuickPrompts(JSON.parse(process.env.LIBERA_QUICK_PROMPTS ?? "[]"));
  } catch {
    return [];
  }
}
