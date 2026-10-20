const AI_FUNCTIONS = ["formatting", "rewrite", "chat", "imageToMarkdown", "latex"];
const AI_FUNCTION_ENV_NAMES = {
  formatting: "FORMATTING",
  rewrite: "REWRITE",
  chat: "CHAT",
  imageToMarkdown: "IMAGE_TO_MARKDOWN",
  latex: "LATEX",
};
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MAX_ALTERNATIVE_MODELS = 50;

function normalizeAlternativeModels(input, defaultModel = "") {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\r?\n/)
      : [];
  const normalizedDefault = typeof defaultModel === "string" ? defaultModel.trim() : "";

  return Array.from(new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value && value !== normalizedDefault && value.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(value))))
    .slice(0, MAX_ALTERNATIVE_MODELS);
}

const REFERENCE_EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/**
 * Preferences → AI → References. An empty model means "use the AI
 * Formatting model". Lookups and AI default on; web search, the contact
 * email and automatic entries for new PDFs default off or empty.
 */
function normalizeReferencePreferences(input) {
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  const contactEmail = typeof input?.contactEmail === "string" ? input.contactEmail.trim() : "";
  return {
    model: model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model) ? model : "",
    promptCaching: typeof input?.promptCaching === "boolean" ? input.promptCaching : false,
    reasoningEffort: REASONING_EFFORTS.includes(input?.reasoningEffort) ? input.reasoningEffort : "low",
    lookupOnline: typeof input?.lookupOnline === "boolean" ? input.lookupOnline : true,
    useAi: typeof input?.useAi === "boolean" ? input.useAi : true,
    webSearch: typeof input?.webSearch === "boolean" ? input.webSearch : false,
    contactEmail: contactEmail.length <= 254 && REFERENCE_EMAIL.test(contactEmail) ? contactEmail : "",
    autoCreateForPdfs: typeof input?.autoCreateForPdfs === "boolean" ? input.autoCreateForPdfs : false,
  };
}

const DEFAULT_WHERE_WAS_I_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * Preferences → AI → Where Was I: the session recap on each notebook's home.
 * `enabled` turns the whole feature off (no card, nothing recorded);
 * `summarize` only the AI bullets. It has its own cheap model rather than the
 * fallback model, and is on by default.
 */
function normalizeWhereWasIPreferences(input) {
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
    summarize: typeof input?.summarize === "boolean" ? input.summarize : true,
    model: model && model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model) ? model : DEFAULT_WHERE_WAS_I_MODEL,
    reasoningEffort: REASONING_EFFORTS.includes(input?.reasoningEffort) ? input.reasoningEffort : "low",
  };
}

function normalizeAiPreferences(input, defaultModel = "google/gemini-3.5-flash") {
  return {
    ...normalizeAiFunctionPreferences(input, defaultModel),
    references: normalizeReferencePreferences(input?.references),
    whereWasI: normalizeWhereWasIPreferences(input?.whereWasI),
  };
}

function normalizeAiFunctionPreferences(input, defaultModel) {
  return Object.fromEntries(AI_FUNCTIONS.map((name) => {
    const value = input?.[name];
    const model = typeof value?.model === "string" ? value.model.trim() : "";
    return [name, {
      model: model || (name === "latex" ? "openai/gpt-5.6-luna" : defaultModel),
      promptCaching: typeof value?.promptCaching === "boolean" ? value.promptCaching : name === "chat",
      reasoningEffort: REASONING_EFFORTS.includes(value?.reasoningEffort) ? value.reasoningEffort : name === "latex" ? "low" : "medium",
      ...(["rewrite", "chat"].includes(name) ? {
        customInstruction: typeof value?.customInstruction === "string" ? value.customInstruction : "",
      } : {}),
      ...(name === "chat" ? {
        alternativeModels: normalizeAlternativeModels(value?.alternativeModels, model || defaultModel),
      } : {}),
    }];
  }));
}

function aiPreferencesEnvironment(preferences, defaultModel) {
  const normalized = normalizeAiPreferences(preferences, defaultModel);
  const references = normalized.references;
  return {
    ...aiFunctionEnvironment(normalized),
    // An empty model lets the server fall back to the AI Formatting model.
    LIBERA_AI_REFERENCES_MODEL: references.model,
    LIBERA_AI_REFERENCES_PROMPT_CACHING: String(references.promptCaching),
    LIBERA_AI_REFERENCES_REASONING_EFFORT: references.reasoningEffort,
    LIBERA_REFERENCES_LOOKUP_ONLINE: String(references.lookupOnline),
    LIBERA_REFERENCES_USE_AI: String(references.useAi),
    LIBERA_REFERENCES_WEB_SEARCH: String(references.webSearch),
    LIBERA_REFERENCES_CONTACT_EMAIL: references.contactEmail,
    LIBERA_REFERENCES_AUTO_CREATE_PDFS: String(references.autoCreateForPdfs),
    LIBERA_WHERE_WAS_I_ENABLED: String(normalized.whereWasI.enabled),
    LIBERA_WHERE_WAS_I_SUMMARIZE: String(normalized.whereWasI.summarize),
    LIBERA_AI_WHERE_WAS_I_MODEL: normalized.whereWasI.model,
    LIBERA_AI_WHERE_WAS_I_REASONING_EFFORT: normalized.whereWasI.reasoningEffort,
  };
}

function aiFunctionEnvironment(normalized) {
  return Object.fromEntries(AI_FUNCTIONS.map((name) => [name, normalized[name]]).flatMap(([name, value]) => [
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_MODEL`, value.model],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_PROMPT_CACHING`, String(value.promptCaching)],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_REASONING_EFFORT`, value.reasoningEffort],
    ...(name === "chat" ? [[`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_ALTERNATIVE_MODELS`, JSON.stringify(value.alternativeModels)]] : []),
  ]));
}
module.exports = { AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, REASONING_EFFORTS, DEFAULT_WHERE_WAS_I_MODEL, normalizeAlternativeModels, normalizeAiPreferences, normalizeReferencePreferences, normalizeWhereWasIPreferences, aiPreferencesEnvironment };
