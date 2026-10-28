import { readFileSync } from "node:fs";
import type { AiReasoningEffort } from "@/lib/ai-preferences";
import { createOpenRouterCompletion, getOpenRouterApiKey } from "@/lib/openrouter";
import { getOpenRouterRouting } from "@/lib/openrouter-routing";
import { parseRecapBullets, type RecapSession } from "@/lib/where-was-i";

// Preferences → AI → Where Was I. Read from the desktop config file on each
// request, like References, so a change applies without a restart; the
// environment Electron passes to the server is the fallback.

export const DEFAULT_WHERE_WAS_I_MODEL = "deepseek/deepseek-v4.1-flash";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export type WhereWasISettings = {
  /** The whole feature: off means no card on the notebook home and no sessions recorded. */
  enabled: boolean;
  /** The AI bullets. */
  summarize: boolean;
  model: string;
  reasoningEffort: AiReasoningEffort;
};

export function getWhereWasISettings(): WhereWasISettings {
  let stored: { enabled?: unknown; summarize?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined;
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      stored = (JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: { whereWasI?: typeof stored } }).aiFunctions?.whereWasI;
    } catch { /* Fall back to the environment. */ }
  }
  const enabled = typeof stored?.enabled === "boolean" ? stored.enabled : process.env.LIBERA_WHERE_WAS_I_ENABLED !== "false";
  const summarize = typeof stored?.summarize === "boolean" ? stored.summarize : process.env.LIBERA_WHERE_WAS_I_SUMMARIZE !== "false";
  const model = (typeof stored?.model === "string" ? stored.model : process.env.LIBERA_AI_WHERE_WAS_I_MODEL)?.trim() || DEFAULT_WHERE_WAS_I_MODEL;
  const effort = typeof stored?.reasoningEffort === "string" ? stored.reasoningEffort : process.env.LIBERA_AI_WHERE_WAS_I_REASONING_EFFORT;
  return { enabled, summarize, model, reasoningEffort: effort && EFFORTS.has(effort) ? effort as AiReasoningEffort : "low" };
}

export function whereWasISummariesAvailable() {
  const settings = getWhereWasISettings();
  return settings.enabled && settings.summarize && !!getOpenRouterApiKey();
}

const SYSTEM_PROMPT = [
  "You write a short \"where you left off\" recap of a person's last working session in one notebook of a note-taking app.",
  "You get the files they opened, which ones they edited, and small excerpts of what changed (lines starting with - were removed, + were added).",
  "Write 2 to 4 bullet points, each starting with \"- \" on its own line, and nothing else.",
  "Each bullet is one plain sentence of at most 18 words, in the past tense, addressed to the person as \"you\" (\"You drafted…\", \"You reviewed…\").",
  "Lead with the most substantial work. Name files by their file name. Say what the edits were about, not how many characters changed.",
  "Group files that were only viewed into a single bullet when they matter, or leave them out.",
  "\"New\" files were created during the session: say the person started or created them (\"You started chapter-4.md…\"), not that they edited them.",
  "\"Added\" files appeared in the notebook during the session without being opened (uploads, saved recordings, files synced or copied in): mention them briefly as added, grouped when there are several.",
  "Edits marked as made by collaborators were not made by the person: describe them as collaborators' changes.",
  "Never invent content that is not in the excerpts. Do not use Markdown formatting besides the bullet dash.",
].join("\n");

function describeSession(notebook: string, session: RecapSession) {
  const lines = [`Notebook: ${notebook}`, `Session: ${session.startedAt} to ${session.endedAt}`, ""];
  for (const file of session.files) {
    const author = file.by === "others" ? " (edited by collaborators)" : file.by === "mixed" ? " (edited by you and collaborators)" : "";
    const size = file.edited && (file.added || file.removed) ? ` (+${file.added ?? 0}/-${file.removed ?? 0} characters)` : "";
    const action = file.unopened ? "Added" : file.created ? (file.edited ? "New, written" : "New") : file.edited ? "Edited" : "Viewed";
    lines.push(`${action}: ${file.path}${size}${author}`);
    for (const crop of file.crops ?? []) {
      if (crop.removed) lines.push(...crop.removed.split("\n").map((line) => `  - ${line}`));
      if (crop.added) lines.push(...crop.added.split("\n").map((line) => `  + ${line}`));
    }
  }
  return lines.join("\n");
}

export async function summarizeRecapSession(notebook: string, session: RecapSession, signal?: AbortSignal) {
  const settings = getWhereWasISettings();
  const { content } = await createOpenRouterCompletion([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: describeSession(notebook, session) },
  ], {
    model: settings.model,
    reasoning: { effort: settings.reasoningEffort },
    provider: getOpenRouterRouting("whereWasI"),
    // Room for reasoning tokens; the answer itself is a few lines.
    maxTokens: 1200,
    signal,
  });
  const bullets = parseRecapBullets(content);
  if (!bullets.length) throw new Error("The model returned no recap.");
  return { bullets, model: settings.model };
}
