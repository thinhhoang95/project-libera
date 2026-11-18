const i18n = require("./i18n.cjs");

/** A message of the quick prompt checks, in the interface language (namespace electron.quickPrompts). */
function qm(key, values) {
  return i18n.t(`electron.quickPrompts.${key}`, values);
}

const MAX_QUICK_PROMPTS = 50;
const MAX_QUICK_PROMPT_IDENTIFIER_LENGTH = 64;
const MAX_QUICK_PROMPT_LENGTH = 20_000;
const QUICK_PROMPT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function normalizedIdentifier(value) {
  return typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";
}

function normalizeQuickPrompts(input) {
  if (!Array.isArray(input)) return [];
  const identifiers = new Set();
  const prompts = [];
  for (const value of input.slice(0, MAX_QUICK_PROMPTS)) {
    const identifier = normalizedIdentifier(value?.identifier);
    const prompt = typeof value?.prompt === "string" ? value.prompt : "";
    const key = identifier.toLocaleLowerCase();
    if (!identifier || identifier.length > MAX_QUICK_PROMPT_IDENTIFIER_LENGTH || !QUICK_PROMPT_IDENTIFIER_PATTERN.test(identifier) || !prompt.trim() || prompt.length > MAX_QUICK_PROMPT_LENGTH || identifiers.has(key)) continue;
    identifiers.add(key);
    prompts.push({ identifier, prompt });
  }
  return prompts;
}

function validateQuickPrompts(input) {
  if (!Array.isArray(input)) throw new Error(qm("notList"));
  if (input.length > MAX_QUICK_PROMPTS) throw new Error(qm("tooMany", { max: MAX_QUICK_PROMPTS }));
  const identifiers = new Set();
  return input.map((value, index) => {
    const identifier = normalizedIdentifier(value?.identifier);
    const prompt = typeof value?.prompt === "string" ? value.prompt : "";
    const number = index + 1;
    if (!identifier) throw new Error(qm("needsIdentifier", { number }));
    if (identifier.length > MAX_QUICK_PROMPT_IDENTIFIER_LENGTH || !QUICK_PROMPT_IDENTIFIER_PATTERN.test(identifier)) {
      throw new Error(qm("badIdentifier", { number }));
    }
    const key = identifier.toLocaleLowerCase();
    if (identifiers.has(key)) throw new Error(qm("identifierInUse", { identifier }));
    if (!prompt.trim()) throw new Error(qm("needsPrompt", { number }));
    if (prompt.length > MAX_QUICK_PROMPT_LENGTH) throw new Error(qm("promptTooLong", { number, max: MAX_QUICK_PROMPT_LENGTH }));
    identifiers.add(key);
    return { identifier, prompt };
  });
}

module.exports = {
  MAX_QUICK_PROMPTS,
  MAX_QUICK_PROMPT_IDENTIFIER_LENGTH,
  MAX_QUICK_PROMPT_LENGTH,
  QUICK_PROMPT_IDENTIFIER_PATTERN,
  normalizeQuickPrompts,
  validateQuickPrompts,
};
