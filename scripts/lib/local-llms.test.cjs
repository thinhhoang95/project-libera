const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { describeLocalLlmFailure, listLocalLlmModels, normalizeLocalBaseUrl, normalizeLocalLlms, testLocalLlm } = require("../../electron/local-llms.cjs");
const { normalizeAiPreferences } = require("../../electron/ai-preferences.cjs");

const ollama = { alias: "myllm", preset: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3.2" };

test("endpoints keep valid entries, and a base URL always ends at the API root", () => {
  assert.equal(normalizeLocalBaseUrl("http://localhost:1234"), "http://localhost:1234/v1");
  assert.equal(normalizeLocalBaseUrl(" http://localhost:1234/v1/ "), "http://localhost:1234/v1");
  assert.equal(normalizeLocalBaseUrl("https://box.lan/llm/api"), "https://box.lan/llm/api");
  assert.equal(normalizeLocalBaseUrl("ftp://localhost"), "");
  assert.equal(normalizeLocalBaseUrl("not a url"), "");
  assert.deepEqual(normalizeLocalLlms([
    { alias: " myllm ", preset: "lmstudio", baseUrl: "http://localhost:1234", model: " qwen ", apiKey: " secret " },
    { alias: "MYLLM", baseUrl: "http://localhost:1/v1", model: "repeat" },
    { alias: "bad alias", baseUrl: "http://localhost:1/v1", model: "x" },
    { alias: "nourl", baseUrl: "", model: "x" },
    { alias: "unknown", preset: "weird", baseUrl: "http://localhost:2/v1", model: "y" },
    "not an entry",
  ]), [
    { alias: "myllm", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", apiKey: "secret", model: "qwen" },
    { alias: "unknown", preset: "custom", baseUrl: "http://localhost:2/v1", apiKey: "", model: "y" },
  ]);
});

test("failures say what went wrong and what to do about it", () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
  const down = describeLocalLlmFailure(ollama, { error: refused });
  assert.equal(down.kind, "unreachable");
  assert.match(down.message, /Could not reach Ollama at http:\/\/localhost:11434\/v1/);
  assert.match(down.message, /ollama serve/);
  // Node reports localhost's IPv4 and IPv6 attempts together.
  const both = Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]) });
  assert.equal(describeLocalLlmFailure(ollama, { error: both }).kind, "unreachable");
  const lmStudio = { ...ollama, preset: "lmstudio" };
  assert.match(describeLocalLlmFailure(lmStudio, { error: refused }).message, /Developer tab/);

  const missing = describeLocalLlmFailure(ollama, { status: 404, detail: "model \"llama3.2\" not found, try pulling it first" });
  assert.equal(missing.kind, "model");
  assert.match(missing.message, /ollama pull llama3\.2/);
  assert.equal(describeLocalLlmFailure(lmStudio, { status: 400, detail: "No models loaded. Please load a model in the developer page." }).kind, "model");

  for (const [endpoint, detail] of [
    [ollama, "the input length exceeds the context length"],
    [lmStudio, "The number of tokens to keep from the initial prompt is greater than the context length"],
    [{ ...ollama, preset: "llamaserver" }, "the request exceeds the available context size"],
    [{ ...ollama, preset: "custom" }, "This model's maximum context length is 8192 tokens"],
  ]) {
    const failure = describeLocalLlmFailure(endpoint, { status: 400, detail });
    assert.equal(failure.kind, "context", detail);
    assert.match(failure.message, /too long for llama3\.2's context window/);
  }

  assert.equal(describeLocalLlmFailure(ollama, { status: 401 }).kind, "auth");
  assert.equal(describeLocalLlmFailure(ollama, { status: 400, detail: "registry.ollama.ai/library/gemma does not support tools" }).kind, "no-tools");
  const loading = describeLocalLlmFailure({ ...ollama, preset: "llamaserver" }, { status: 503, detail: "Loading model" });
  assert.deepEqual([loading.kind, loading.retryable], ["loading", true]);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(describeLocalLlmFailure(ollama, { error: timeout }).kind, "timeout");
  assert.match(describeLocalLlmFailure(ollama, { status: 500, detail: "out of memory" }).message, /out of memory/);
});

test("Test connection lists the models, then runs a one-token request", async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, authorization: request.headers.authorization, body });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/models") return response.end(JSON.stringify({ data: [{ id: "qwen" }, { id: "llama3.2" }] }));
      if (JSON.parse(body).model === "missing") { response.statusCode = 404; return response.end(JSON.stringify({ error: { message: "model \"missing\" not found" } })); }
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  assert.deepEqual(await listLocalLlmModels({ baseUrl, preset: "ollama" }), { ok: true, models: ["llama3.2", "qwen"] });
  const passed = await testLocalLlm({ baseUrl, preset: "ollama", model: "qwen", apiKey: "secret" });
  assert.equal(passed.ok, true);
  assert.match(passed.message, /Connected to Ollama: qwen answered/);
  assert.equal(seen.at(-1).authorization, "Bearer secret");
  assert.equal(JSON.parse(seen.at(-1).body).max_tokens, 1);

  const noModel = await testLocalLlm({ baseUrl, preset: "ollama" });
  assert.equal(noModel.ok, true);
  assert.match(noModel.message, /2 models available/);

  const failed = await testLocalLlm({ baseUrl, preset: "ollama", model: "missing" });
  assert.deepEqual([failed.ok, failed.kind, failed.models], [false, "model", ["llama3.2", "qwen"]]);
  assert.match(failed.message, /ollama pull missing/);

  assert.deepEqual(await testLocalLlm({ baseUrl: "nonsense" }), { ok: false, kind: "url", message: "Enter a base URL such as http://localhost:11434/v1." });
});

test("a server that is not running fails Test connection with a clear message", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const result = await testLocalLlm({ baseUrl: `http://127.0.0.1:${port}/v1`, preset: "lmstudio", model: "qwen" });
  assert.deepEqual([result.ok, result.kind], [false, "unreachable"]);
  assert.match(result.message, /Is the server running\?/);
});

async function preferencesPage(aiFunctions, liberaSetup = {}) {
  const page = { saved: undefined };
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: "http://localhost/?mode=configuration", runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ aiFunctions, quickPrompts: [], hasApiKey: true, hasPasswordHash: true, dataDir: "/tmp/notebooks" }),
        save: async (input) => { page.saved = JSON.parse(JSON.stringify(input)); },
        ...liberaSetup,
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { document } = dom.window;
  page.dom = dom;
  page.document = document;
  page.fire = (element, name) => element.dispatchEvent(new dom.window.Event(name, { bubbles: true }));
  page.submit = async () => {
    document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  page.poolModels = () => Array.from(document.querySelectorAll(".model-pool-id"), (element) => element.textContent);
  return page;
}

test("Preferences sets up an endpoint and puts its alias in the Model Pool", async () => {
  const tested = [];
  const page = await preferencesPage(normalizeAiPreferences({ chat: { model: "base/model" } }, "base/model"), {
    testLocalLlm: async (endpoint) => { tested.push(endpoint); return { ok: true, models: ["qwen"], message: "Connected to LM Studio." }; },
  });
  const { document, fire } = page;
  try {
    // The Local LLMs item sits right under AI in the sidebar.
    const navigation = Array.from(document.querySelectorAll("[data-section-button]"), (button) => button.dataset.sectionButton);
    assert.equal(navigation[navigation.indexOf("ai") + 1], "local-llms");
    document.querySelector('[data-section-button="local-llms"]').click();
    assert.equal(document.querySelector('[data-section="local-llms"]').classList.contains("hidden"), false);
    assert.equal(document.querySelector("#local-llm-empty").classList.contains("hidden"), false);

    document.querySelector("#add-local-llm").click();
    const card = document.querySelector(".local-llm-card");
    assert.equal(document.querySelector("#local-llm-empty").classList.contains("hidden"), true);
    // Ollama is the default; a preset fills in its address.
    assert.equal(card.querySelector(".local-llm-url").value, "http://localhost:11434/v1");
    assert.equal(card.querySelector('[data-preset="ollama"]').getAttribute("aria-checked"), "true");
    card.querySelector('[data-preset="lmstudio"]').click();
    assert.equal(card.querySelector(".local-llm-url").value, "http://localhost:1234/v1");
    card.querySelector('[data-preset="llamaserver"]').click();
    assert.equal(card.querySelector(".local-llm-url").value, "http://localhost:8080/v1");
    card.querySelector('[data-preset="lmstudio"]').click();

    // A model name is required before saving.
    await page.submit();
    assert.equal(page.saved, undefined);
    assert.match(document.querySelector("#error-box, .error, [role=alert]")?.textContent ?? document.body.textContent, /needs a model name/);

    card.querySelector(".local-llm-model").value = "qwen";
    card.querySelector(".local-llm-test").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(JSON.parse(JSON.stringify(tested[0])), { alias: "myllm", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", apiKey: "", model: "qwen" });
    assert.equal(card.querySelector(".local-llm-state").textContent, "Connected");
    assert.equal(card.querySelector(".local-llm-result").textContent, "Connected to LM Studio.");

    card.querySelector(".local-llm-pool").click();
    assert.ok(page.poolModels().includes("local/myllm"));
    assert.equal(card.querySelector(".local-llm-pool").disabled, true);
    assert.equal(document.querySelector("#ai-rewrite-model").querySelector('option[value="local/myllm"]').value, "local/myllm");

    // Choosing it switches off what does not apply to a local model.
    document.querySelector("#ai-rewrite-model").value = "local/myllm";
    fire(document.querySelector("#ai-rewrite-model"), "change");
    assert.equal(document.querySelector("#ai-rewrite-effort").disabled, true);
    assert.equal(document.querySelector("#ai-rewrite-caching").disabled, true);
    const routing = document.querySelector('[data-ai-function="rewrite"] .routing-button');
    assert.equal(routing.disabled, true);
    assert.equal(routing.textContent, "Local");

    // A rename follows the alias to where it is chosen; deleting it is refused while it is in use.
    card.querySelector(".local-llm-alias").value = "qwen-box";
    fire(card.querySelector(".local-llm-alias"), "change");
    assert.equal(document.querySelector("#ai-rewrite-model").value, "local/qwen-box");
    assert.ok(page.poolModels().includes("local/qwen-box"));
    assert.equal(page.poolModels().includes("local/myllm"), false);
    card.querySelector(".local-llm-delete").click();
    assert.ok(document.querySelector(".local-llm-card"));
    assert.match(card.querySelector(".local-llm-result").textContent, /in use by AI Rewrite/);

    await page.submit();
    assert.deepEqual(page.saved.aiFunctions.localLlms, [{ alias: "qwen-box", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", apiKey: "", model: "qwen" }]);
    assert.equal(page.saved.aiFunctions.rewrite.model, "local/qwen-box");

    document.querySelector("#ai-rewrite-model").value = "base/model";
    fire(document.querySelector("#ai-rewrite-model"), "change");
    assert.equal(document.querySelector("#ai-rewrite-caching").disabled, false);
    card.querySelector(".local-llm-delete").click();
    assert.equal(document.querySelector(".local-llm-card"), null);
    assert.equal(page.poolModels().includes("local/qwen-box"), false);
  } finally { page.dom.window.close(); }
});

test("saved endpoints come back, and a pool alias with no endpoint is flagged", async () => {
  const page = await preferencesPage(normalizeAiPreferences({ modelPool: ["local/gone"], localLlms: [{ alias: "kept", preset: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.2", apiKey: "secret" }] }, "base/model"));
  const { document } = page;
  try {
    const card = document.querySelector(".local-llm-card");
    assert.equal(card.querySelector(".local-llm-alias").value, "kept");
    assert.equal(card.querySelector(".local-llm-key").value, "secret");
    assert.equal(card.querySelector(".local-llm-key").type, "password");
    const gone = Array.from(document.querySelectorAll(".model-pool-row")).find((row) => row.querySelector(".model-pool-id").textContent === "local/gone");
    assert.match(gone.querySelector(".model-pool-meta").textContent, /Not set up yet/);
    assert.equal(gone.querySelector(".model-pool-badge").textContent, "Local");
  } finally { page.dom.window.close(); }
});
