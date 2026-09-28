export type QuickPrompt = { identifier: string; prompt: string };

export const MAX_QUICK_PROMPTS = 50;
export const MAX_QUICK_PROMPT_IDENTIFIER_LENGTH = 64;
export const MAX_QUICK_PROMPT_LENGTH = 20_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function normalizeQuickPrompts(input: unknown): QuickPrompt[] {
  if (!Array.isArray(input)) return [];
  const identifiers = new Set<string>();
  const prompts: QuickPrompt[] = [];
  for (const value of input.slice(0, MAX_QUICK_PROMPTS)) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as { identifier?: unknown; prompt?: unknown };
    const identifier = typeof candidate.identifier === "string" ? candidate.identifier.trim().replace(/^\/+/, "") : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";
    const key = identifier.toLocaleLowerCase();
    if (!identifier || identifier.length > MAX_QUICK_PROMPT_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(identifier) || !prompt.trim() || prompt.length > MAX_QUICK_PROMPT_LENGTH || identifiers.has(key)) continue;
    identifiers.add(key);
    prompts.push({ identifier, prompt });
  }
  return prompts;
}

export function matchingQuickPrompts(prompts: QuickPrompt[], query: string) {
  const normalizedQuery = query.toLocaleLowerCase();
  return prompts
    .filter((quickPrompt) => quickPrompt.identifier.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) =>
      Number(!left.identifier.toLocaleLowerCase().startsWith(normalizedQuery)) - Number(!right.identifier.toLocaleLowerCase().startsWith(normalizedQuery))
      || left.identifier.localeCompare(right.identifier),
    );
}

export function insertQuickPrompt(value: string, start: number, end: number, prompt: string) {
  const nextValue = value.slice(0, start) + prompt + value.slice(end);
  const firstVariable = prompt.search(/\$1(?!\d)/);
  const selectionStart = start + (firstVariable < 0 ? prompt.length : firstVariable);
  return {
    value: nextValue,
    selectionStart,
    selectionEnd: selectionStart + (firstVariable < 0 ? 0 : 2),
  };
}
