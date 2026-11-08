const { normalizeLocalLlms } = require("./local-llms.cjs");

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
/** The functions that choose their model from the Model Pool; the rest name their own. */
const POOL_FUNCTIONS = ["formatting", "rewrite", "write", "chat", "review"];
const MAX_MODEL_POOL = 50;

function isModelSlug(value) {
  return !!value && value.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(value);
}

function customInstruction(input) {
  return typeof input?.customInstruction === "string" ? input.customInstruction : "";
}

/**
 * Preferences → AI → Model Pool: the models AI Formatting, AI Rewrite, Write
 * with AI, AI Chat and the Agent, Agentic Review and Generate Definitions
 * choose from. `required` are the models those functions are set to: they
 * always stay in the pool, and are never the ones cut at the limit.
 */
function normalizeModelPool(input, required = []) {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\r?\n/)
      : [];
  const listed = Array.from(new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(isModelSlug)));
  const kept = new Set(required.filter(isModelSlug));
  const room = Math.max(0, MAX_MODEL_POOL - kept.size);
  let extra = 0;
  const pool = listed.filter((model) => kept.has(model) || extra++ < room);
  return [...pool, ...[...kept].filter((model) => !pool.includes(model))];
}

/**
 * Preferences → AI → Generate Definitions: what the Agent starts with when
 * the Definitions tab asks it for cards. Empty means "same as the AI panel".
 */
function normalizeDefinitionsPreferences(input) {
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  return {
    model: isModelSlug(model) ? model : "",
    reasoningEffort: REASONING_EFFORTS.includes(input?.reasoningEffort) ? input.reasoningEffort : "",
    customInstruction: customInstruction(input),
  };
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
  const openAlexApiKey = typeof input?.openAlexApiKey === "string" ? input.openAlexApiKey.trim() : "";
  return {
    model: model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model) ? model : "",
    promptCaching: typeof input?.promptCaching === "boolean" ? input.promptCaching : false,
    reasoningEffort: REASONING_EFFORTS.includes(input?.reasoningEffort) ? input.reasoningEffort : "low",
    lookupOnline: typeof input?.lookupOnline === "boolean" ? input.lookupOnline : true,
    useAi: typeof input?.useAi === "boolean" ? input.useAi : true,
    webSearch: typeof input?.webSearch === "boolean" ? input.webSearch : false,
    contactEmail: contactEmail.length <= 254 && REFERENCE_EMAIL.test(contactEmail) ? contactEmail : "",
    openAlexApiKey: openAlexApiKey.length <= 200 && /^[!-~]+$/.test(openAlexApiKey) ? openAlexApiKey : "",
    autoCreateForPdfs: typeof input?.autoCreateForPdfs === "boolean" ? input.autoCreateForPdfs : false,
    customInstruction: customInstruction(input),
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
    customInstruction: customInstruction(input),
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
    customInstruction: customInstruction(input),
  };
}

/** Every function Preferences → AI lists, each with its own OpenRouter routing. */
const ROUTING_FUNCTIONS = ["formatting", "imageToMarkdown", "pdfToMarkdown", "rewrite", "write", "chat", "review", "latex", "recordingRecap", "references", "whereWasI"];
const ROUTING_SORTS = ["default", "price", "throughput", "latency"];
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;

function positiveNumber(value, max) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 && number <= max ? number : undefined;
}

/**
 * Preferences → AI → Routing for one function: OpenRouter's `provider`
 * object (see src/lib/openrouter-routing.ts, which reads it on each request).
 * Unset, a function routes to the cheapest provider, as before routing was
 * configurable. Empty optional limits are left out.
 */
function normalizeRoutingPreferences(input) {
  const limits = {
    maxPromptPrice: positiveNumber(input?.maxPromptPrice, 10_000),
    maxCompletionPrice: positiveNumber(input?.maxCompletionPrice, 10_000),
    minThroughput: positiveNumber(input?.minThroughput, 100_000),
    maxLatency: positiveNumber(input?.maxLatency, 600),
  };
  return {
    sort: ROUTING_SORTS.includes(input?.sort) ? input.sort : "price",
    ...Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)),
    allowFallbacks: typeof input?.allowFallbacks === "boolean" ? input.allowFallbacks : true,
    dataCollection: input?.dataCollection === "deny" ? "deny" : "allow",
    zdr: input?.zdr === true,
    ignore: Array.isArray(input?.ignore)
      ? Array.from(new Set(input.ignore.filter((slug) => typeof slug === "string").map((slug) => slug.trim().toLowerCase()).filter((slug) => PROVIDER_SLUG.test(slug)))).slice(0, 50)
      : [],
  };
}

function normalizeAiRouting(input) {
  return Object.fromEntries(ROUTING_FUNCTIONS.map((name) => [name, normalizeRoutingPreferences(input?.[name])]));
}

function normalizeAiPreferences(input, defaultModel = DEFAULT_AI_MODEL) {
  const functions = normalizeAiFunctionPreferences(input, defaultModel);
  const definitions = normalizeDefinitionsPreferences(input?.definitions);
  return {
    ...functions,
    references: normalizeReferencePreferences(input?.references),
    whereWasI: normalizeWhereWasIPreferences(input?.whereWasI),
    pdfToMarkdown: normalizePdfToMarkdownPreferences(input?.pdfToMarkdown),
    definitions,
    // AI Chat's alternative models became the pool; configs from before it still hold them there.
    modelPool: normalizeModelPool(input?.modelPool ?? input?.chat?.alternativeModels, [...POOL_FUNCTIONS.map((name) => functions[name].model), definitions.model]),
    localLlms: normalizeLocalLlms(input?.localLlms),
    routing: normalizeAiRouting(input?.routing),
  };
}

/**
 * The AI settings the server takes from its environment when it starts.
 * Everything else, custom system prompts included, is read from the config
 * file on each request, so changing it needs no restart.
 */
function aiPreferencesNeedingRestart(preferences) {
  const live = new Set(["whereWasI", "pdfToMarkdown", "routing", "definitions", "modelPool", "localLlms"]);
  return Object.fromEntries(Object.entries(preferences)
    .filter(([name]) => !live.has(name))
    .map(([name, value]) => [name, { ...value, customInstruction: undefined }]));
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
      customInstruction: customInstruction(value),
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
    LIBERA_REFERENCES_OPENALEX_API_KEY: references.openAlexApiKey,
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
    LIBERA_AI_DEFINITIONS_MODEL: normalized.definitions.model,
    LIBERA_AI_DEFINITIONS_REASONING_EFFORT: normalized.definitions.reasoningEffort,
    LIBERA_AI_MODEL_POOL: JSON.stringify(normalized.modelPool),
    LIBERA_AI_ROUTING: JSON.stringify(normalized.routing),
  };
}

function aiFunctionEnvironment(normalized) {
  return Object.fromEntries(AI_FUNCTIONS.map((name) => [name, normalized[name]]).flatMap(([name, value]) => [
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_MODEL`, value.model],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_PROMPT_CACHING`, String(value.promptCaching)],
    [`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_REASONING_EFFORT`, value.reasoningEffort],
  ]));
}
module.exports = { DEFAULT_AI_MODEL, AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, AI_FUNCTION_PARENTS, POOL_FUNCTIONS, REASONING_EFFORTS, ROUTING_FUNCTIONS, DEFAULT_WHERE_WAS_I_MODEL, DEFAULT_PDF_TO_MARKDOWN_MODEL, normalizeModelPool, normalizeAiPreferences, normalizeDefinitionsPreferences, normalizeReferencePreferences, normalizeWhereWasIPreferences, normalizePdfToMarkdownPreferences, normalizeRoutingPreferences, aiPreferencesEnvironment, aiPreferencesNeedingRestart };
