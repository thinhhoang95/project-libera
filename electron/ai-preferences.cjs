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

function normalizeAiPreferences(input, defaultModel = "google/gemini-3.5-flash") {
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
  return Object.fromEntries(Object.entries(normalizeAiPreferences(preferences, defaultModel)).flatMap(([name, value]) => [
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_MODEL`, value.model],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_PROMPT_CACHING`, String(value.promptCaching)],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_REASONING_EFFORT`, value.reasoningEffort],
    ...(name === "chat" ? [[`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_ALTERNATIVE_MODELS`, JSON.stringify(value.alternativeModels)]] : []),
  ]));
}
module.exports = { AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, REASONING_EFFORTS, normalizeAlternativeModels, normalizeAiPreferences, aiPreferencesEnvironment };
