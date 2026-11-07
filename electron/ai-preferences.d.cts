import type { LocalLlmEndpoint } from "./local-llms.cjs";

export type DefinitionsPreferences = {
  /** A Model Pool model; empty uses the AI panel's. */
  model: string;
  /** Empty uses the AI panel's. */
  reasoningEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  customInstruction: string;
};

/** What the server reads from the config file on each request; the other settings are left out here. */
export type NormalizedAiPreferences = {
  definitions: DefinitionsPreferences;
  modelPool: string[];
  localLlms: LocalLlmEndpoint[];
} & Record<string, unknown>;

export const POOL_FUNCTIONS: readonly string[];
export function normalizeAiPreferences(input: unknown, defaultModel?: string): NormalizedAiPreferences;
export function normalizeModelPool(input: unknown, required?: string[]): string[];
