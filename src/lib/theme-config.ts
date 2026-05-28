import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThemePreference } from "@/lib/theme";
import { themePreferenceOrUndefined } from "@/lib/theme";

type ElectronConfig = {
  themePreference?: unknown;
  [key: string]: unknown;
};

function getConfigPath() {
  return process.env.LIBERA_CONFIG_PATH;
}

function isFileNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readConfig(configPath: string): Promise<ElectronConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as ElectronConfig;
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }

    return {};
  }
}

export function getConfiguredThemePreference() {
  return themePreferenceOrUndefined(process.env.LIBERA_THEME);
}

export async function writeConfiguredThemePreference(theme: ThemePreference) {
  const configPath = getConfigPath();

  if (!configPath) {
    process.env.LIBERA_THEME = theme;
    return theme;
  }

  const config = await readConfig(configPath);

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, themePreference: theme }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  process.env.LIBERA_THEME = theme;

  return theme;
}
