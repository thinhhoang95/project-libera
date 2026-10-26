const DEFAULT_AI_MODEL = "openai/gpt-6-luna";
const AI_FUNCTIONS = ["formatting", "rewrite", "write", "chat", "review", "recordingRecap", "imageToMarkdown", "latex"];
const AI_FUNCTION_ENV_NAMES = {
  formatting: "FORMATTING",
  rewrite: "REWRITE",
  write: "WRITE",
  chat: "CHAT",
  review: "REVIEW",
  recordingRecap: "RECORDING_RECAP",
  imageToMarkdown: "IMAGE_TO_MARKDOWN",
  latex: "LATEX",
};
/**
 * Functions split off one they used to share. Until set, each keeps that
 * function's settings, so existing configs behave as before. AI Chat and the
 * AI Agent stay one function: they share a model pool.
 */
const AI_FUNCTION_PARENTS = { write: "rewrite", review: "chat", recordingRecap: "formatting" };
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

const DEFAULT_PDF_TO_MARKDOWN_MODEL = "openai/gpt-6-luna";
const PDF_TO_MARKDOWN_ENGINES = ["local", "openrouter"];

/**
 * Preferences → AI → Convert PDF to Markdown. `local` reads pages with the
 * granite-docling model on this computer; `openrouter` sends each page as a
 * one-page PDF to the model below, several pages at once, then tidies the
 * joined Markdown (heading levels) with the same model when `cleanup` is on.
 */
function normalizePdfToMarkdownPreferences(input) {
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  const concurrency = Number(input?.concurrency);
  return {
    engine: PDF_TO_MARKDOWN_ENGINES.includes(input?.engine) ? input.engine : "local",
    model: model && model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model) ? model : DEFAULT_PDF_TO_MARKDOWN_MODEL,
    reasoningEffort: REASONING_EFFORTS.includes(input?.reasoningEffort) ? input.reasoningEffort : "low",
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16 ? concurrency : 6,
    cleanup: typeof input?.cleanup === "boolean" ? input.cleanup : true,
  };
}

function normalizeAiPreferences(input, defaultModel = DEFAULT_AI_MODEL) {
  return {
    ...normalizeAiFunctionPreferences(input, defaultModel),
    references: normalizeReferencePreferences(input?.references),
    whereWasI: normalizeWhereWasIPreferences(input?.whereWasI),
    pdfToMarkdown: normalizePdfToMarkdownPreferences(input?.pdfToMarkdown),
  };
}

function normalizeAiFunctionPreferences(input, defaultModel) {
  const normalized = {};
  // Parents come before the functions split off them in AI_FUNCTIONS.
  for (const name of AI_FUNCTIONS) {
    const value = input?.[name];
    const model = typeof value?.model === "string" ? value.model.trim() : "";
    const parent = normalized[AI_FUNCTION_PARENTS[name]];
    // The recording recap is a small, quick task: low effort, no caching.
    const inherited = name === "recordingRecap" ? { promptCaching: false, reasoningEffort: "low" } : parent;
    normalized[name] = {
      model: model || parent?.model || (name === "latex" ? "openai/gpt-5.6-luna" : defaultModel),
      promptCaching: typeof value?.promptCaching === "boolean" ? value.promptCaching : inherited ? inherited.promptCaching : ["chat", "rewrite"].includes(name),
      reasoningEffort: REASONING_EFFORTS.includes(value?.reasoningEffort) ? value.reasoningEffort : inherited ? inherited.reasoningEffort : name === "latex" ? "low" : "medium",
      ...(["rewrite", "chat"].includes(name) ? {
        customInstruction: typeof value?.customInstruction === "string" ? value.customInstruction : "",
      } : {}),
      ...(name === "chat" ? {
        alternativeModels: normalizeAlternativeModels(value?.alternativeModels, model || defaultModel),
      } : {}),
    };
  }
  return normalized;
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
    LIBERA_PDF_TO_MARKDOWN_ENGINE: normalized.pdfToMarkdown.engine,
    LIBERA_AI_PDF_TO_MARKDOWN_MODEL: normalized.pdfToMarkdown.model,
    LIBERA_AI_PDF_TO_MARKDOWN_REASONING_EFFORT: normalized.pdfToMarkdown.reasoningEffort,
    LIBERA_PDF_TO_MARKDOWN_CONCURRENCY: String(normalized.pdfToMarkdown.concurrency),
    LIBERA_PDF_TO_MARKDOWN_CLEANUP: String(normalized.pdfToMarkdown.cleanup),
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
module.exports = { DEFAULT_AI_MODEL, AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, AI_FUNCTION_PARENTS, REASONING_EFFORTS, DEFAULT_WHERE_WAS_I_MODEL, DEFAULT_PDF_TO_MARKDOWN_MODEL, normalizeAlternativeModels, normalizeAiPreferences, normalizeReferencePreferences, normalizeWhereWasIPreferences, normalizePdfToMarkdownPreferences, aiPreferencesEnvironment };
