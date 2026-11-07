export type LocalLlmPresetId = "ollama" | "lmstudio" | "llamaserver" | "custom";

export type LocalLlmEndpoint = {
  /** Used as `local/<alias>` wherever a model slug goes. */
  alias: string;
  preset: LocalLlmPresetId;
  /** The server's OpenAI-compatible address, such as http://localhost:11434/v1. */
  baseUrl: string;
  /** Optional; most local servers need none. */
  apiKey: string;
  /** The model name as the server knows it. */
  model: string;
};

export type LocalLlmFailureKind = "unreachable" | "timeout" | "auth" | "no-tools" | "context" | "loading" | "model" | "server" | "url";
export type LocalLlmFailure = { kind: LocalLlmFailureKind; retryable: boolean; message: string };
export type LocalLlmResult = { ok: boolean; models?: string[]; kind?: LocalLlmFailureKind; message?: string };

export const LOCAL_ALIAS: RegExp;
export const LOCAL_LLM_PRESETS: Readonly<Record<LocalLlmPresetId, Readonly<{ label: string; subject?: string; baseUrl: string; start: string; load: (model: string) => string; context: string }>>>;
export const LOCAL_MODEL_PREFIX: "local/";
export const MAX_LOCAL_LLMS: number;
export function describeLocalLlmFailure(endpoint: LocalLlmEndpoint, failure?: { status?: number; detail?: string; error?: unknown }): LocalLlmFailure;
export function isLocalModel(model: unknown): model is `local/${string}`;
export function listLocalLlmModels(input: Partial<LocalLlmEndpoint>, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<LocalLlmResult>;
export function localAlias(model: unknown): string;
export function localErrorDetail(payload: unknown): string;
export function localLlmHeaders(endpoint: Pick<LocalLlmEndpoint, "apiKey">): Record<string, string>;
export function normalizeLocalBaseUrl(input: unknown): string;
export function normalizeLocalLlms(input: unknown): LocalLlmEndpoint[];
export function readLocalError(response: Response): Promise<string>;
export function testLocalLlm(input: Partial<LocalLlmEndpoint>, options?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }): Promise<LocalLlmResult>;
