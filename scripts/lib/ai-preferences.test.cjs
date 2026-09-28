const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, normalizeAlternativeModels, normalizeAiPreferences, aiPreferencesEnvironment } = require('../../electron/ai-preferences.cjs');

test('AI preferences migrate legacy models and survive a config file round trip', () => {
  const legacy = normalizeAiPreferences(undefined, 'existing/model');
  assert.equal(legacy.formatting.model, 'existing/model');
  assert.equal(legacy.rewrite.model, 'existing/model');
  assert.deepEqual(legacy.rewrite, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false, customInstruction: '' });
  assert.equal(legacy.chat.model, 'existing/model');
  assert.deepEqual(legacy.imageToMarkdown, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false });
  assert.deepEqual(legacy.chat, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '', alternativeModels: [] });
  assert.deepEqual(legacy.latex, { model: 'openai/gpt-5.6-luna', reasoningEffort: 'low', promptCaching: false });
  const efforts = { formatting: 'low', rewrite: 'high', chat: 'xhigh', imageToMarkdown: 'medium', latex: 'max' };
  const aiFunctions = Object.fromEntries(AI_FUNCTIONS.map((name) => [name, {
    model: name === "chat" ? "deepseek/deepseek-v4.1-flash" : `provider/${name}`,
    reasoningEffort: efforts[name],
    promptCaching: name !== "chat",
    ...(['rewrite', 'chat'].includes(name) ? { customInstruction: `Instructions for ${name}.` } : {}),
    ...(name === 'chat' ? { alternativeModels: ['anthropic/claude-sonnet-4.5', 'google/gemini-3.5-pro'] } : {}),
  }]));
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
    assert.equal(env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS, JSON.stringify(aiFunctions.chat.alternativeModels));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('alternative models are trimmed, deduplicated, and exclude the default model', () => {
  assert.deepEqual(normalizeAlternativeModels([
    ' provider/alternative ', 'provider/default', 'provider/alternative', '', 'not a/model', 42,
  ], 'provider/default'), ['provider/alternative']);
  assert.deepEqual(normalizeAlternativeModels('one/model\r\ntwo/model\none/model', 'default/model'), ['one/model', 'two/model']);
});

test('Preferences UI loads and saves all five function settings', async () => {
  const aiFunctions = normalizeAiPreferences({
    chat: { customInstruction: 'Prefer concise answers.', model: 'test/default-model', alternativeModels: ['test/fast-model', 'test/deep-model'] },
    rewrite: { customInstruction: 'Preserve the author voice.' },
  });
  const quickPrompts = [{ identifier: 'summary', prompt: 'Summarize $1.' }];
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
        loadAiChatCustomInstructionFile: async () => ({ canceled: false, content: 'Instruction loaded from a file.' }),
        loadAiRewriteCustomInstructionFile: async () => ({ canceled: false, content: 'Rewrite instruction loaded from a file.' }),
      };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const document = dom.window.document;
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
      assert.equal(document.querySelector(`#ai-${name}-caching`).value, String(name === "chat"));
      document.querySelector(`#ai-${name}-caching`).value = String(name !== "chat");
      document.querySelector(`#ai-${name}-model`).value = `custom/${name}`;
      document.querySelector(`#ai-${name}-effort`).value = 'max';
    }
    assert.equal(document.querySelector('#ai-chat-custom-instruction').value, 'Prefer concise answers.');
    assert.equal(document.querySelector('#ai-chat-alternative-models').value, 'test/fast-model\ntest/deep-model');
    document.querySelector('#ai-chat-alternative-models').value = 'custom/chat\ncustom/fast\ncustom/fast';
    assert.equal(document.querySelector('#ai-rewrite-custom-instruction').value, 'Preserve the author voice.');
    assert.equal(document.querySelectorAll('.quick-prompt-card').length, 1);
    assert.equal(document.querySelector('.quick-prompt-identifier').value, 'summary');
    assert.equal(document.querySelector('.quick-prompt-text').value, 'Summarize $1.');
    document.querySelector('#add-quick-prompt-button').click();
    const promptCards = document.querySelectorAll('.quick-prompt-card');
    promptCards[1].querySelector('.quick-prompt-identifier').value = 'rewrite';
    promptCards[1].querySelector('.quick-prompt-text').value = 'Rewrite $1 for $2.';
    document.querySelector('#load-ai-rewrite-instruction-button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('#ai-rewrite-custom-instruction').value, 'Rewrite instruction loaded from a file.');
    document.querySelector('#load-ai-chat-instruction-button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('#ai-chat-custom-instruction').value, 'Instruction loaded from a file.');
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const name of AI_FUNCTIONS) assert.deepEqual(saved.aiFunctions[name], {
      model: `custom/${name}`,
      reasoningEffort: 'max',
      promptCaching: name !== 'chat',
      ...(name === 'chat' ? { customInstruction: 'Instruction loaded from a file.', alternativeModels: ['custom/chat', 'custom/fast', 'custom/fast'] } : {}),
      ...(name === 'rewrite' ? { customInstruction: 'Rewrite instruction loaded from a file.' } : {}),
    });
    assert.deepEqual(saved.quickPrompts, [
      { identifier: 'summary', prompt: 'Summarize $1.' },
      { identifier: 'rewrite', prompt: 'Rewrite $1 for $2.' },
    ]);
  } finally { dom.window.close(); }
});
