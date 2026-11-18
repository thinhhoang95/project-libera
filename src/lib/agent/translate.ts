// What the user reads while an agent runs (activity lines, result lines, limit and error notices) is written in the
// interface language. What the model reads (the system prompt, tool descriptions, tool output and tool errors) is
// always English and never goes through here.
import type { AppLocale } from "@/lib/i18n/locales";
import { createServerT, englishServerT, type ServerT } from "@/lib/i18n/server-translator";

/** Translates a message under `agentServer` in messages/<locale>.json: `t("tools.read.describe", { path })`. */
export type AgentT = ServerT;

/** English, for runs without a request locale (tests, scripts). */
export const englishAgentT: AgentT = englishServerT("agentServer");

/** The translator for a locale, over English so a missing translation shows English. Server-side only. */
export function createAgentT(locale: AppLocale): Promise<AgentT> {
  return createServerT(locale, "agentServer");
}
