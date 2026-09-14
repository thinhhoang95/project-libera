const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { AI_FUNCTIONS, AI_FUNCTION_ENV_NAMES, normalizeAiPreferences, aiPreferencesEnvironment } = require('../../electron/ai-preferences.cjs');

test('AI preferences migrate legacy models and survive a config file round trip', () => {
  const legacy = normalizeAiPreferences(undefined, 'existing/model');
  assert.equal(legacy.formatting.model, 'existing/model');
  assert.equal(legacy.rewrite.model, 'existing/model');
  assert.deepEqual(legacy.rewrite, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false, customInstruction: '' });
  assert.equal(legacy.chat.model, 'existing/model');
  assert.deepEqual(legacy.imageToMarkdown, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false });
  assert.deepEqual(legacy.chat, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.deepEqual(legacy.latex, { model: 'openai/gpt-5.6-luna', reasoningEffort: 'low', promptCaching: false });
  const efforts = { formatting: 'low', rewrite: 'high', chat: 'xhigh', imageToMarkdown: 'medium', latex: 'max' };
  const aiFunctions = Object.fromEntries(AI_FUNCTIONS.map((name) => [name, {
    model: name === "chat" ? "deepseek/deepseek-v4.1-flash" : `provider/${name}`,
    reasoningEffort: efforts[name],
    promptCaching: name !== "chat",
    ...(['rewrite', 'chat'].includes(name) ? { customInstruction: `Instructions for ${name}.` } : {}),
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Preferences UI loads and saves all five function settings', async () => {
  const aiFunctions = normalizeAiPreferences({
    chat: { customInstruction: 'Prefer concise answers.' },
    rewrite: { customInstruction: 'Preserve the author voice.' },
  });
  let saved;
  const dom = new JSDOM(readFileSync(path.join(__dirname, '../../electron/setup.html'), 'utf8'), {
    url: 'http://localhost/?mode=configuration', runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ aiFunctions, hasApiKey: true, hasPasswordHash: true, dataDir: '/tmp/notebooks' }),
        save: async (input) => { saved = JSON.parse(JSON.stringify(input)); },
        loadAiChatCustomInstructionFile: async () => ({ canceled: false, content: 'Instruction loaded from a file.' }),
        loadAiRewriteCustomInstructionFile: async () => ({ canceled: false, content: 'Rewrite instruction loaded from a file.' }),
      };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const document = dom.window.document;
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
    assert.equal(document.querySelector('#ai-rewrite-custom-instruction').value, 'Preserve the author voice.');
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
      ...(name === 'chat' ? { customInstruction: 'Instruction loaded from a file.' } : {}),
      ...(name === 'rewrite' ? { customInstruction: 'Rewrite instruction loaded from a file.' } : {}),
    });
  } finally { dom.window.close(); }
});
