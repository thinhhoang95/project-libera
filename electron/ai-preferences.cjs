const AI_FUNCTIONS = ["formatting", "rewrite", "chat", "latex"];
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function normalizeAiPreferences(input, defaultModel = "google/gemini-3.5-flash") {
  return Object.fromEntries(AI_FUNCTIONS.map((name) => {
    const value = input?.[name];
    const model = typeof value?.model === "string" ? value.model.trim() : "";
    return [name, {
      model: model || (name === "latex" ? "openai/gpt-5.6-luna" : defaultModel),
      reasoningEffort: REASONING_EFFORTS.includes(value?.reasoningEffort) ? value.reasoningEffort : name === "latex" ? "low" : "medium",
      ...(name === "chat" ? {
        customInstruction: typeof value?.customInstruction === "string" ? value.customInstruction : "",
      } : {}),
    }];
  }));
}

function aiPreferencesEnvironment(preferences, defaultModel) {
  return Object.fromEntries(Object.entries(normalizeAiPreferences(preferences, defaultModel)).flatMap(([name, value]) => [
    [`LIBERA_AI_${name.toUpperCase()}_MODEL`, value.model],
    [`LIBERA_AI_${name.toUpperCase()}_REASONING_EFFORT`, value.reasoningEffort],
  ]));
}
module.exports = { AI_FUNCTIONS, REASONING_EFFORTS, normalizeAiPreferences, aiPreferencesEnvironment };
