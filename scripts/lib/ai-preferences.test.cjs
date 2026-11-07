const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, POOL_FUNCTIONS, ROUTING_FUNCTIONS, normalizeModelPool, normalizeAiPreferences, normalizeRoutingPreferences, aiPreferencesEnvironment, aiPreferencesNeedingRestart } = require('../../electron/ai-preferences.cjs');

test('AI preferences migrate legacy models and survive a config file round trip', () => {
  const legacy = normalizeAiPreferences(undefined, 'existing/model');
  assert.equal(legacy.formatting.model, 'existing/model');
  assert.equal(legacy.rewrite.model, 'existing/model');
  assert.deepEqual(legacy.rewrite, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.equal(legacy.chat.model, 'existing/model');
  assert.deepEqual(legacy.imageToMarkdown, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false, customInstruction: '' });
  assert.deepEqual(legacy.chat, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.deepEqual(legacy.write, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.deepEqual(legacy.review, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.deepEqual(legacy.recordingRecap, { model: 'existing/model', reasoningEffort: 'low', promptCaching: false, customInstruction: '' });
  // Split-off functions keep the settings of the one they shared until set.
  const split = normalizeAiPreferences({ rewrite: { model: 'own/rewrite', reasoningEffort: 'high', promptCaching: true }, chat: { model: 'own/chat', reasoningEffort: 'xhigh' }, formatting: { model: 'own/formatting', reasoningEffort: 'max' } }, 'existing/model');
  assert.deepEqual(split.write, { model: 'own/rewrite', reasoningEffort: 'high', promptCaching: true, customInstruction: '' });
  assert.deepEqual(split.review, { model: 'own/chat', reasoningEffort: 'xhigh', promptCaching: true, customInstruction: '' });
  assert.deepEqual(split.recordingRecap, { model: 'own/formatting', reasoningEffort: 'low', promptCaching: false, customInstruction: '' });
  assert.equal(normalizeAiPreferences({ rewrite: { model: 'own/rewrite' }, write: { model: 'own/write' } }).write.model, 'own/write');
  assert.equal(normalizeAiPreferences(undefined).formatting.model, 'openai/gpt-6-luna');
  assert.deepEqual(legacy.latex, { model: 'openai/gpt-5.6-luna', reasoningEffort: 'low', promptCaching: false, customInstruction: '' });
  assert.deepEqual(legacy.references, { model: '', reasoningEffort: 'low', promptCaching: false, lookupOnline: true, useAi: true, webSearch: false, contactEmail: '', autoCreateForPdfs: false, customInstruction: '' });
  assert.equal(normalizeAiPreferences({ references: { contactEmail: 'not an email', model: 'bad model' } }).references.contactEmail, '');
  assert.equal(normalizeAiPreferences({ references: { model: 'bad model' } }).references.model, '');
  assert.deepEqual(legacy.whereWasI, { enabled: true, summarize: true, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low', customInstruction: '' });
  assert.equal(normalizeAiPreferences({ whereWasI: { model: 'bad model', reasoningEffort: 'huge' } }).whereWasI.model, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(legacy.pdfToMarkdown, { engine: 'local', model: 'openai/gpt-6-luna', reasoningEffort: 'low', concurrency: 6, cleanup: true, customInstruction: '' });
  assert.deepEqual(legacy.definitions, { model: '', reasoningEffort: '', customInstruction: '' });
  assert.deepEqual(legacy.modelPool, ['existing/model']);
  assert.deepEqual(legacy.localLlms, []);
  assert.deepEqual(normalizeAiPreferences({ pdfToMarkdown: { engine: 'cloud', model: 'bad model', concurrency: 40, cleanup: 'no' } }).pdfToMarkdown, legacy.pdfToMarkdown);
  const efforts = { formatting: 'low', rewrite: 'high', write: 'medium', chat: 'xhigh', review: 'high', recordingRecap: 'low', imageToMarkdown: 'medium', latex: 'max' };
  const aiFunctions = Object.fromEntries(AI_FUNCTIONS.map((name) => [name, {
    model: name === "chat" ? "deepseek/deepseek-v4.1-flash" : `provider/${name}`,
    reasoningEffort: efforts[name],
    promptCaching: name !== "chat",
    customInstruction: ['rewrite', 'chat'].includes(name) ? `Instructions for ${name}.` : '',
  }]));
  aiFunctions.references = { model: 'provider/references', reasoningEffort: 'high', promptCaching: true, lookupOnline: false, useAi: true, webSearch: true, contactEmail: 'me@example.org', autoCreateForPdfs: true, customInstruction: 'Prefer the published version.' };
  aiFunctions.whereWasI = { enabled: false, summarize: false, model: 'provider/recap', reasoningEffort: 'medium', customInstruction: '' };
  aiFunctions.pdfToMarkdown = { engine: 'openrouter', model: 'provider/pdf', reasoningEffort: 'medium', concurrency: 3, cleanup: false, customInstruction: '' };
  aiFunctions.definitions = { model: 'anthropic/claude-sonnet-4.5', reasoningEffort: 'high', customInstruction: 'Skip standard notation.' };
  aiFunctions.modelPool = ['anthropic/claude-sonnet-4.5', 'google/gemini-3.5-pro', 'provider/formatting', 'provider/rewrite', 'provider/write', 'deepseek/deepseek-v4.1-flash', 'provider/review'];
  aiFunctions.localLlms = [{ alias: 'myllm', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.2' }];
  aiFunctions.routing = Object.fromEntries(ROUTING_FUNCTIONS.map((name) => [name, { sort: 'price', allowFallbacks: true, dataCollection: 'allow', zdr: false, ignore: [] }]));
  aiFunctions.routing.chat = { sort: 'latency', maxLatency: 2, allowFallbacks: true, dataCollection: 'deny', zdr: false, ignore: ['deepinfra'] };
  aiFunctions.routing.formatting = { sort: 'throughput', maxPromptPrice: 0.5, maxCompletionPrice: 1.5, allowFallbacks: false, dataCollection: 'allow', zdr: true, ignore: [] };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'libera-ai-prefs-'));
  try {
    const configPath = path.join(directory, 'libera-electron-config.json');
    writeFileSync(configPath, JSON.stringify({ aiFunctions: normalizeAiPreferences(aiFunctions) }));
    const restarted = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(normalizeAiPreferences(restarted.aiFunctions), aiFunctions);
    const env = aiPreferencesEnvironment(restarted.aiFunctions);
    for (const name of AI_FUNCTIONS) {
      assert.equal(env[`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_PROMPT_CACHING`], String(aiFunctions[name].promptCaching));
      assert.equal(env[`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_MODEL`], aiFunctions[name].model);
      assert.equal(env[`LIBERA_AI_${AI_FUNCTION_ENV_NAMES[name]}_REASONING_EFFORT`], aiFunctions[name].reasoningEffort);
    }
    assert.equal(env.LIBERA_AI_MODEL_POOL, JSON.stringify(aiFunctions.modelPool));
    assert.equal(env.LIBERA_AI_REFERENCES_MODEL, 'provider/references');
    assert.equal(env.LIBERA_WHERE_WAS_I_ENABLED, 'false');
    assert.equal(env.LIBERA_WHERE_WAS_I_SUMMARIZE, 'false');
    assert.equal(env.LIBERA_AI_WHERE_WAS_I_MODEL, 'provider/recap');
    assert.equal(env.LIBERA_AI_WHERE_WAS_I_REASONING_EFFORT, 'medium');
    assert.equal(env.LIBERA_PDF_TO_MARKDOWN_ENGINE, 'openrouter');
    assert.equal(env.LIBERA_AI_PDF_TO_MARKDOWN_MODEL, 'provider/pdf');
    assert.equal(env.LIBERA_PDF_TO_MARKDOWN_CONCURRENCY, '3');
    assert.equal(env.LIBERA_PDF_TO_MARKDOWN_CLEANUP, 'false');
    assert.equal(env.LIBERA_AI_REFERENCES_REASONING_EFFORT, 'high');
    assert.equal(env.LIBERA_AI_REFERENCES_PROMPT_CACHING, 'true');
    assert.equal(env.LIBERA_REFERENCES_LOOKUP_ONLINE, 'false');
    assert.equal(env.LIBERA_REFERENCES_USE_AI, 'true');
    assert.equal(env.LIBERA_REFERENCES_WEB_SEARCH, 'true');
    assert.equal(env.LIBERA_REFERENCES_CONTACT_EMAIL, 'me@example.org');
    assert.equal(env.LIBERA_REFERENCES_AUTO_CREATE_PDFS, 'true');
    assert.deepEqual(JSON.parse(env.LIBERA_AI_ROUTING), aiFunctions.routing);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('routing preferences default to the cheapest provider and drop invalid limits', () => {
  const defaults = { sort: 'price', allowFallbacks: true, dataCollection: 'allow', zdr: false, ignore: [] };
  assert.deepEqual(normalizeRoutingPreferences(undefined), defaults);
  assert.deepEqual(Object.keys(normalizeAiPreferences(undefined).routing), ROUTING_FUNCTIONS);
  assert.deepEqual(normalizeRoutingPreferences({ sort: 'fastest', maxPromptPrice: -1, maxCompletionPrice: 'abc', minThroughput: '40', maxLatency: 9999, zdr: 'yes', ignore: [' DeepInfra ', 'deepinfra', 'bad slug', 7] }),
    { ...defaults, minThroughput: 40, ignore: ['deepinfra'] });
});

test('the Model Pool is trimmed and deduplicated, and always holds the models in use', () => {
  assert.deepEqual(normalizeModelPool([
    ' provider/one ', 'provider/two', 'provider/one', '', 'not a/model', 42,
  ], ['provider/default', 'provider/two']), ['provider/one', 'provider/two', 'provider/default']);
  assert.deepEqual(normalizeModelPool('one/model\r\ntwo/model\none/model'), ['one/model', 'two/model']);
  // At the limit the models in use stay and the extras go.
  const many = Array.from({ length: 60 }, (_, index) => `extra/${index}`);
  const capped = normalizeModelPool(many, ['in/use']);
  assert.equal(capped.length, 50);
  assert.equal(capped.at(-1), 'in/use');
});

test("AI Chat's alternative models become the Model Pool, and an explicit pool wins", () => {
  const legacy = normalizeAiPreferences({ chat: { model: 'own/chat', alternativeModels: ['fast/one', 'own/chat'] }, formatting: { model: 'own/format' } }, 'base/model');
  assert.deepEqual(legacy.modelPool, ['fast/one', 'own/chat', 'own/format', 'base/model']);
  assert.equal('alternativeModels' in legacy.chat, false);
  const saved = normalizeAiPreferences({ ...legacy, chat: { ...legacy.chat, alternativeModels: ['stale/model'] }, modelPool: ['kept/model'] }, 'base/model');
  assert.equal(saved.modelPool.includes('stale/model'), false);
  assert.equal(saved.modelPool[0], 'kept/model');
  for (const name of POOL_FUNCTIONS) assert.ok(saved.modelPool.includes(saved[name].model), name);
});

test('Generate Definitions keeps only valid settings, and its model joins the pool', () => {
  const preferences = normalizeAiPreferences({ definitions: { model: 'local/myllm', reasoningEffort: 'huge', customInstruction: 'Skip the basics.' } }, 'base/model');
  assert.deepEqual(preferences.definitions, { model: 'local/myllm', reasoningEffort: '', customInstruction: 'Skip the basics.' });
  assert.ok(preferences.modelPool.includes('local/myllm'));
  assert.equal(normalizeAiPreferences({ definitions: { model: 'bad model' } }).definitions.model, '');
});

test('only settings the server reads at startup ask for a restart', () => {
  const before = normalizeAiPreferences({ chat: { model: 'one/model' } });
  const live = normalizeAiPreferences({
    chat: { model: 'one/model', customInstruction: 'Be brief.' },
    references: { customInstruction: 'Prefer journals.' },
    modelPool: ['two/model'],
    definitions: { model: 'two/model', reasoningEffort: 'high' },
    localLlms: [{ alias: 'myllm', baseUrl: 'http://localhost:1234/v1', model: 'qwen' }],
  });
  assert.deepEqual(aiPreferencesNeedingRestart(live), aiPreferencesNeedingRestart(before));
  const changed = normalizeAiPreferences({ chat: { model: 'other/model' } });
  assert.notDeepEqual(aiPreferencesNeedingRestart(changed), aiPreferencesNeedingRestart(before));
});

test('Preferences UI loads and saves every function setting', async () => {
  const aiFunctions = normalizeAiPreferences({
    chat: { customInstruction: 'Prefer concise answers.', model: 'test/default-model', alternativeModels: ['test/fast-model', 'test/deep-model'] },
    rewrite: { customInstruction: 'Preserve the author voice.' },
    references: { webSearch: true, contactEmail: 'me@example.org' },
  });
  const quickPrompts = [{ identifier: 'summary', prompt: 'Summarize $1.' }];
  const loadedPrompts = ['Rewrite instruction loaded from a file.', 'Instruction loaded from a file.'];
  let saved;
  let exportRequests = 0;
  let importRequests = 0;
  const dom = new JSDOM(readFileSync(path.join(__dirname, '../../electron/setup.html'), 'utf8'), {
    url: 'http://localhost/?mode=configuration', runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ aiFunctions, quickPrompts, hasApiKey: true, hasPasswordHash: true, dataDir: '/tmp/notebooks' }),
        save: async (input) => { saved = JSON.parse(JSON.stringify(input)); },
        exportPreferences: async () => { exportRequests += 1; return { canceled: false, fileName: 'libera-preferences.json' }; },
        importPreferences: async () => { importRequests += 1; return { canceled: true }; },
        loadAiSystemPromptFile: async () => ({ canceled: false, content: loadedPrompts.shift() }),
      };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const document = dom.window.document;
    const addToPool = (model) => {
      const picker = document.querySelector('#model-pool-picker');
      picker.value = model;
      picker.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    const ioNavigation = document.querySelector('[data-section-button="io"]');
    assert.equal(ioNavigation.classList.contains('hidden'), false);
    ioNavigation.click();
    assert.equal(document.querySelector('[data-section="io"]').classList.contains('hidden'), false);
    assert.ok(document.querySelector('#export-preferences-button svg'));
    assert.ok(document.querySelector('#import-preferences-button svg'));
    document.querySelector('#export-preferences-button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(exportRequests, 1);
    assert.equal(document.querySelector('#io-status').textContent, 'Exported libera-preferences.json.');
    document.querySelector('#import-preferences-button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(importRequests, 1);
    document.querySelector('[data-section-button="ai"]').click();
    assert.equal(document.querySelector('[data-section="ai"]').classList.contains('hidden'), false);
    assert.equal(document.querySelector('label[for="openrouter-model"]').textContent, 'Fallback OpenRouter model');
    for (const name of AI_FUNCTIONS) {
      assert.equal(document.querySelector(`#ai-${name}-model`).value, aiFunctions[name].model);
      assert.deepEqual(Array.from(document.querySelector(`#ai-${name}-effort`).options, (option) => option.value), ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(document.querySelector(`#ai-${name}-caching`).value, String(name === "chat" || name === "review" || name === "rewrite" || name === "write"));
      document.querySelector(`#ai-${name}-caching`).value = String(name !== "chat");
      if (POOL_FUNCTIONS.includes(name)) addToPool(`custom/${name}`);
      document.querySelector(`#ai-${name}-model`).value = `custom/${name}`;
      document.querySelector(`#ai-${name}-effort`).value = 'max';
    }
    assert.equal(document.querySelector('#ai-references-model').value, '');
    assert.equal(document.querySelector('#ai-references-model').placeholder, 'Same as AI Formatting');
    assert.equal(document.querySelector('#references-lookup-online').checked, true);
    assert.equal(document.querySelector('#references-use-ai').checked, true);
    assert.equal(document.querySelector('#references-web-search').checked, true);
    assert.equal(document.querySelector('#references-auto-create-pdfs').checked, false);
    assert.equal(document.querySelector('#references-contact-email').value, 'me@example.org');
    document.querySelector('#ai-references-model').value = ' custom/references ';
    document.querySelector('#references-lookup-online').checked = false;
    document.querySelector('#references-auto-create-pdfs').checked = true;
    assert.equal(document.querySelector('#where-was-i-enabled').checked, true);
    assert.equal(document.querySelector('#ai-whereWasI-model').value, 'deepseek/deepseek-v4.1-flash');
    assert.equal(document.querySelector('#ai-whereWasI-effort').value, 'low');
    assert.equal(document.querySelector('#where-was-i-summarize').checked, true);
    assert.equal(document.querySelector('#ai-whereWasI-model').disabled, false);
    document.querySelector('#where-was-i-summarize').checked = false;
    document.querySelector('#where-was-i-summarize').dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.querySelector('#ai-whereWasI-model').disabled, true);
    document.querySelector('#where-was-i-enabled').checked = false;
    document.querySelector('#where-was-i-enabled').dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.querySelector('#where-was-i-summarize').disabled, true);
    document.querySelector('#ai-whereWasI-model').value = ' custom/recap ';
    assert.equal(document.querySelector('#pdf-to-markdown-engine').value, 'local');
    assert.equal(document.querySelector('#ai-pdfToMarkdown-model').value, 'openai/gpt-6-luna');
    assert.equal(document.querySelector('#ai-pdfToMarkdown-model').disabled, true);
    document.querySelector('#pdf-to-markdown-engine').value = 'openrouter';
    document.querySelector('#pdf-to-markdown-engine').dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.querySelector('#ai-pdfToMarkdown-model').disabled, false);
    document.querySelector('#ai-pdfToMarkdown-model').value = ' custom/pdf ';
    document.querySelector('#pdf-to-markdown-concurrency').value = '4';
    assert.equal(document.querySelector('#ai-chat-custom-instruction').value, 'Prefer concise answers.');
    const poolModels = () => Array.from(document.querySelectorAll('.model-pool-id'), (element) => element.textContent);
    assert.ok(poolModels().includes('test/fast-model'));
    assert.equal(document.querySelector('#ai-chat-alternative-models'), null);
    // Every pool function and Generate Definitions offer exactly the pool.
    for (const selector of [...POOL_FUNCTIONS.map((name) => `#ai-${name}-model`)]) {
      assert.deepEqual(Array.from(document.querySelector(selector).options, (option) => option.value), poolModels(), selector);
    }
    assert.deepEqual(Array.from(document.querySelector('#ai-definitions-model').options, (option) => option.value), ['', ...poolModels()]);
    // The rest keep their free-text field.
    for (const name of ['imageToMarkdown', 'latex', 'recordingRecap']) assert.equal(document.querySelector(`#ai-${name}-model`).tagName, 'INPUT');
    // A model in use cannot leave the pool; an unused one can.
    const poolRow = (model) => Array.from(document.querySelectorAll('.model-pool-row')).find((row) => row.querySelector('.model-pool-id').textContent === model);
    document.querySelector('#ai-chat-model').dispatchEvent(new dom.window.Event('change'));
    assert.equal(poolRow('custom/chat').querySelector('.model-pool-remove').disabled, true);
    assert.equal(poolRow('custom/chat').querySelector('.model-pool-use').textContent, 'Chat');
    poolRow('test/deep-model').querySelector('.model-pool-remove').click();
    assert.equal(poolModels().includes('test/deep-model'), false);
    document.querySelector('#ai-definitions-model').value = 'test/fast-model';
    document.querySelector('#ai-definitions-effort').value = 'high';
    document.querySelector('#ai-definitions-custom-instruction').value = 'Skip standard notation.';
    document.querySelector('#ai-latex-custom-instruction').value = 'Use the article class.';
    assert.equal(document.querySelector('#ai-rewrite-custom-instruction').value, 'Preserve the author voice.');
    assert.equal(document.querySelector('[data-ai-function="rewrite"] .ai-prompt-state').hidden, false);
    assert.equal(document.querySelector('[data-ai-function="formatting"] .ai-prompt-state').hidden, true);
    // Every function's card has a custom system prompt.
    assert.equal(document.querySelectorAll('.ai-system-prompt textarea').length, AI_FUNCTIONS.length + 4);
    assert.equal(document.querySelectorAll('.quick-prompt-card').length, 1);
    assert.equal(document.querySelector('.quick-prompt-identifier').value, 'summary');
    assert.equal(document.querySelector('.quick-prompt-text').value, 'Summarize $1.');
    document.querySelector('#add-quick-prompt-button').click();
    const promptCards = document.querySelectorAll('.quick-prompt-card');
    promptCards[1].querySelector('.quick-prompt-identifier').value = 'rewrite';
    promptCards[1].querySelector('.quick-prompt-text').value = 'Rewrite $1 for $2.';
    document.querySelector('[data-ai-function="rewrite"] .ai-system-prompt button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('#ai-rewrite-custom-instruction').value, 'Rewrite instruction loaded from a file.');
    document.querySelector('[data-ai-function="chat"] .ai-system-prompt button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('#ai-chat-custom-instruction').value, 'Instruction loaded from a file.');
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(saved.aiFunctions.pdfToMarkdown, { engine: 'openrouter', model: 'custom/pdf', reasoningEffort: 'low', concurrency: 4, cleanup: true, customInstruction: '' });
    assert.deepEqual(saved.aiFunctions.definitions, { model: 'test/fast-model', reasoningEffort: 'high', customInstruction: 'Skip standard notation.' });
    assert.deepEqual(saved.aiFunctions.modelPool, poolModels());
    for (const name of AI_FUNCTIONS) assert.deepEqual(saved.aiFunctions[name], {
      model: `custom/${name}`,
      reasoningEffort: 'max',
      promptCaching: name !== 'chat',
      customInstruction: { chat: 'Instruction loaded from a file.', rewrite: 'Rewrite instruction loaded from a file.', latex: 'Use the article class.' }[name] ?? '',
    });
    assert.deepEqual(saved.aiFunctions.references, {
      model: 'custom/references', reasoningEffort: 'low', promptCaching: false, lookupOnline: false, useAi: true, webSearch: true, autoCreateForPdfs: true, contactEmail: 'me@example.org', customInstruction: '',
    });
    assert.deepEqual(saved.aiFunctions.whereWasI, { enabled: false, summarize: false, model: 'custom/recap', reasoningEffort: 'low', customInstruction: '' });
    // Every function gets a routing button; unset, each routes to the cheapest provider.
    assert.equal(document.querySelectorAll('.routing-button').length, ROUTING_FUNCTIONS.length);
    assert.deepEqual(saved.aiFunctions.routing, normalizeAiPreferences(undefined).routing);
    const chatRouting = document.querySelector('[data-ai-function="chat"] .routing-button');
    assert.equal(chatRouting.textContent, 'Cheapest');
    chatRouting.click();
    assert.equal(document.querySelector('#routing-dialog').hasAttribute('open'), true);
    assert.match(document.querySelector('#routing-recommendation').textContent, /Fastest first response/);
    document.querySelector('#routing-presets input[value="latency"]').click();
    document.querySelector('#routing-max-latency').value = '1.5';
    document.querySelector('#routing-max-latency').dispatchEvent(new dom.window.Event('input'));
    document.querySelector('#routing-apply').click();
    assert.equal(document.querySelector('#routing-dialog').hasAttribute('open'), false);
    assert.equal(chatRouting.textContent, 'Fastest start');
    // Batch: recommended routing for every function but the chat; models stay.
    document.querySelector('#ai-routing-all').click();
    assert.equal(document.querySelectorAll('#routing-targets input:checked').length, ROUTING_FUNCTIONS.length);
    document.querySelector('#routing-targets input[value="chat"]').click();
    document.querySelector('#routing-presets input[value="recommended"]').click();
    document.querySelector('#routing-max-prompt-price').value = '2';
    document.querySelector('#routing-max-prompt-price').dispatchEvent(new dom.window.Event('input'));
    document.querySelector('#routing-apply').click();
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(saved.aiFunctions.routing.chat, { sort: 'latency', maxLatency: 1.5, allowFallbacks: true, dataCollection: 'allow', zdr: false, ignore: [] });
    assert.deepEqual(saved.aiFunctions.routing.formatting, { sort: 'throughput', maxPromptPrice: 2, allowFallbacks: true, dataCollection: 'allow', zdr: false, ignore: [] });
    assert.deepEqual(saved.aiFunctions.routing.whereWasI, { sort: 'price', maxPromptPrice: 2, allowFallbacks: true, dataCollection: 'allow', zdr: false, ignore: [] });
    assert.equal(saved.aiFunctions.formatting.model, 'custom/formatting');
    document.querySelector('#ai-all-models').value = ' every/model ';
    document.querySelector('#ai-all-models-apply').click();
    for (const selector of ['#openrouter-model', ...AI_FUNCTIONS.map((name) => `#ai-${name}-model`), '#ai-references-model', '#ai-whereWasI-model']) {
      assert.equal(document.querySelector(selector).value, 'every/model', selector);
    }
    assert.ok(poolModels().includes('every/model'));
    assert.deepEqual(saved.quickPrompts, [
      { identifier: 'summary', prompt: 'Summarize $1.' },
      { identifier: 'rewrite', prompt: 'Rewrite $1 for $2.' },
    ]);
  } finally { dom.window.close(); }
});
