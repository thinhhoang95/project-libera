/**
 * Preferences → Local LLMs: OpenAI-compatible servers on this computer or
 * network, each under an alias. `local/<alias>` then works wherever a model
 * slug does. The main process uses this to list models and test a connection;
 * the server (src/lib/local-llm.ts) uses it to read the endpoints and to turn
 * a failure into a message that says what to do.
 */
const { englishTranslator } = require("./english-messages.cjs");

/** The `electron.localLlms` messages in English: what the server shows, and what any caller gets without a translator. */
const englishWording = englishTranslator("electron.localLlms");

const LOCAL_MODEL_PREFIX = "local/";
const MAX_LOCAL_LLMS = 20;
const LOCAL_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LOCAL_LLM_LIST_TIMEOUT_MS = 8_000;
// The first request can load the model into memory, which takes a while.
const LOCAL_LLM_TEST_TIMEOUT_MS = 90_000;

const LOCAL_LLM_PRESETS = Object.freeze({
  ollama: Object.freeze({
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
  }),
  lmstudio: Object.freeze({
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
  }),
  llamaserver: Object.freeze({
    label: "llama-server",
    baseUrl: "http://localhost:8080/v1",
  }),
  custom: Object.freeze({
    label: "the server",
    subject: "The server",
    baseUrl: "",
  }),
});

function isLocalModel(model) {
  return typeof model === "string" && model.startsWith(LOCAL_MODEL_PREFIX);
}

function localAlias(model) {
  return isLocalModel(model) ? model.slice(LOCAL_MODEL_PREFIX.length) : "";
}

/** `http://host:1234` and `http://host:1234/v1/` both mean `http://host:1234/v1`. */
function normalizeLocalBaseUrl(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname || "/v1"}`;
  } catch {
    return "";
  }
}

/** Entries without a usable alias or base URL are dropped; the first of a repeated alias wins. */
function normalizeLocalLlms(input) {
  const seen = new Set();
  const endpoints = [];
  for (const entry of Array.isArray(input) ? input : []) {
    const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
    const baseUrl = normalizeLocalBaseUrl(entry?.baseUrl);
    if (!LOCAL_ALIAS.test(alias) || !baseUrl || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
    endpoints.push({
      alias,
      preset: Object.hasOwn(LOCAL_LLM_PRESETS, entry.preset) ? entry.preset : "custom",
      baseUrl,
      apiKey: apiKey.length <= 4_096 ? apiKey : "",
      model: model.length <= 400 && !/[\u0000-\u001f\u007f]/.test(model) ? model : "",
    });
    if (endpoints.length >= MAX_LOCAL_LLMS) break;
  }
  return endpoints;
}

function localLlmHeaders(endpoint) {
  return {
    "Content-Type": "application/json",
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

function presetKeyOf(endpoint) {
  return Object.hasOwn(LOCAL_LLM_PRESETS, endpoint?.preset) ? endpoint.preset : "custom";
}

/** The server as a name inside a sentence: "Ollama", or "the server" for a custom address. */
function presetLabel(endpoint, translate) {
  return presetKeyOf(endpoint) === "custom" ? translate("customLabel") : LOCAL_LLM_PRESETS[endpoint.preset].label;
}

/** The server as the subject of a sentence: "Ollama", or "The server". */
function presetSubject(endpoint, translate) {
  return presetKeyOf(endpoint) === "custom" ? translate("customSubject") : LOCAL_LLM_PRESETS[endpoint.preset].label;
}

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** Node's fetch hides the real reason in `cause`, which can itself hold several attempts (IPv4 and IPv6). */
function errorCodes(error) {
  const codes = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (typeof value.code === "string") codes.add(value.code);
    if (value.name === "TimeoutError") codes.add("ETIMEDOUT");
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const item of value.errors) visit(item, depth + 1);
  };
  visit(error, 0);
  return codes;
}

const CONTEXT_EXCEEDED = /context[_ -]?(length|size|window)|exceeds? (the )?(available |maximum )?context|maximum context|too many tokens|n_ctx|prompt is too long|input is too long/i;
const MODEL_MISSING = /no models? (is |are )?loaded|model.{0,80}(not found|not loaded|does ?n[o']t exist|not available|isn'?t loaded)|(unknown|invalid) model|try pulling|failed to load model/i;
const NO_TOOLS = /does not support tools|tools? (is |are )?not supported|not support(ed)? tool/i;

/**
 * A plain-language account of a failed request to a local server. Give it the
 * HTTP status and the server's own message, or the thrown `error` when no
 * response came back. `retryable` is true only for what can pass on its own. `translate` words the message in the
 * interface language (the `electron.localLlms` messages); it defaults to English, which the server shows.
 */
function describeLocalLlmFailure(endpoint, { status, detail = "", error } = {}, translate = englishWording) {
  const subject = presetSubject(endpoint, translate);
  const name = `local/${endpoint.alias}`;
  const model = endpoint.model || name;
  const text = String(detail);
  const advice = (kind, values) => translate(`${presetKeyOf(endpoint)}${kind}`, values);
  const label = presetLabel(endpoint, translate);
  if (status === undefined) {
    const codes = errorCodes(error);
    if ([...codes].some((code) => TIMEOUT_CODES.has(code))) {
      return { kind: "timeout", retryable: false, message: translate("timeout", { subject, url: endpoint.baseUrl, model }) };
    }
    if (!codes.size || [...codes].some((code) => UNREACHABLE_CODES.has(code))) {
      return { kind: "unreachable", retryable: false, message: translate("unreachable", { server: label, url: endpoint.baseUrl, name, start: advice("Start") }) };
    }
    return { kind: "server", retryable: false, message: translate("requestFailed", { server: label, url: endpoint.baseUrl, error: error instanceof Error ? error.message : String(error) }) };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, message: translate("rejectedKey", { subject, name }) };
  }
  if (NO_TOOLS.test(text)) {
    return { kind: "no-tools", retryable: false, message: translate("noTools", { model }) };
  }
  if (CONTEXT_EXCEEDED.test(text)) {
    return { kind: "context", retryable: false, message: translate("contextExceeded", { model, advice: advice("Context") }) };
  }
  if (status === 503 || /loading model/i.test(text)) {
    return { kind: "loading", retryable: true, message: translate("stillLoading", { subject, model }) };
  }
  if (MODEL_MISSING.test(text) || status === 404) {
    return { kind: "model", retryable: false, message: translate("modelMissing", { subject, model, advice: advice("Load", { model }) }) };
  }
  return { kind: "server", retryable: status === 429 || status >= 500, message: text ? translate("serverErrorDetail", { subject, name, detail: text.slice(0, 300) }) : translate("serverErrorStatus", { subject, name, status }) };
}

/** The message in an error reply, in the shapes OpenAI-compatible servers use. */
function localErrorDetail(payload) {
  const error = payload?.error;
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof payload?.message === "string") return payload.message;
  return "";
}

async function readLocalError(response) {
  const text = await response.text().catch(() => "");
  try { return localErrorDetail(JSON.parse(text)) || text; }
  catch { return text; }
}

function localModelIds(payload) {
  const entries = [
    ...(Array.isArray(payload?.data) ? payload.data : []),
    ...(Array.isArray(payload?.models) ? payload.models : []),
  ];
  const ids = entries.map((entry) => typeof entry === "string" ? entry : entry?.id ?? entry?.model ?? entry?.name);
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))).sort((a, b) => a.localeCompare(b));
}

/** The endpoint as typed in Preferences, before it is saved. */
function draftEndpoint(input) {
  return {
    alias: typeof input?.alias === "string" && input.alias.trim() ? input.alias.trim() : "new",
    preset: Object.hasOwn(LOCAL_LLM_PRESETS, input?.preset) ? input.preset : "custom",
    baseUrl: normalizeLocalBaseUrl(input?.baseUrl),
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : "",
  };
}

async function listLocalLlmModels(input, { fetchImpl = globalThis.fetch, timeoutMs = LOCAL_LLM_LIST_TIMEOUT_MS, translate = englishWording } = {}) {
  const endpoint = draftEndpoint(input);
  if (!endpoint.baseUrl) return { ok: false, kind: "url", message: translate("enterBaseUrl") };
  let response;
  try {
    response = await fetchImpl(`${endpoint.baseUrl}/models`, { headers: localLlmHeaders(endpoint), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, ...describeLocalLlmFailure(endpoint, { error }) };
  }
  if (!response.ok) return { ok: false, ...describeLocalLlmFailure(endpoint, { status: response.status, detail: await readLocalError(response) }) };
  const payload = await response.json().catch(() => null);
  if (!payload) return { ok: false, kind: "server", message: translate("notJson", { url: endpoint.baseUrl }) };
  return { ok: true, models: localModelIds(payload) };
}

/** Lists the models, then asks the chosen model for one token, so a pass means a real request works. */
async function testLocalLlm(input, { fetchImpl = globalThis.fetch, timeoutMs = LOCAL_LLM_TEST_TIMEOUT_MS, now = Date.now, translate = englishWording } = {}) {
  const endpoint = draftEndpoint(input);
  const listed = await listLocalLlmModels(endpoint, { fetchImpl, translate });
  if (!listed.ok) return listed;
  if (!endpoint.model) return { ok: true, models: listed.models, message: translate("connectedChooseModel", { server: presetLabel(endpoint, translate), count: listed.models.length }) };
  const started = now();
  let response;
  try {
    response = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: localLlmHeaders(endpoint),
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, temperature: 0 }),
    });
  } catch (error) {
    return { ok: false, models: listed.models, ...describeLocalLlmFailure(endpoint, { error }, translate) };
  }
  if (!response.ok) return { ok: false, models: listed.models, ...describeLocalLlmFailure(endpoint, { status: response.status, detail: await readLocalError(response) }, translate) };
  const seconds = ((now() - started) / 1000).toFixed(1);
  return { ok: true, models: listed.models, message: translate("connectedAnswered", { server: presetLabel(endpoint, translate), model: endpoint.model, seconds, count: listed.models.length }) };
}

module.exports = {
  LOCAL_ALIAS,
  LOCAL_LLM_PRESETS,
  LOCAL_MODEL_PREFIX,
  MAX_LOCAL_LLMS,
  describeLocalLlmFailure,
  isLocalModel,
  listLocalLlmModels,
  localAlias,
  localErrorDetail,
  localLlmHeaders,
  normalizeLocalBaseUrl,
  normalizeLocalLlms,
  readLocalError,
  testLocalLlm,
};
