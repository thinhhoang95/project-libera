import { readFileSync } from "node:fs";
import { resolveNotebookIllustrations, type NotebookIllustrationLibrary } from "../../electron/notebook-illustrations.cjs";
import { illustrationExists } from "../../electron/notebook-illustration-store.cjs";
import { getAdminRoot } from "@/lib/storage/paths";

// Read on each page load rather than at server start: Preferences applies
// illustration sets without a restart.
export function getConfiguredNotebookIllustrations(): NotebookIllustrationLibrary {
  let preference: unknown = null;
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      preference = (JSON.parse(readFileSync(configPath, "utf8")) as { notebookIllustrations?: unknown }).notebookIllustrations;
    } catch {}
  }
  return resolveNotebookIllustrations(preference, { exists: illustrationExists(getAdminRoot()) });
}
