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
  assert.deepEqual(legacy.rewrite, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '' });
  assert.equal(legacy.chat.model, 'existing/model');
  assert.deepEqual(legacy.imageToMarkdown, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: false });
  assert.deepEqual(legacy.chat, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true, customInstruction: '', alternativeModels: [] });
  assert.deepEqual(legacy.write, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true });
  assert.deepEqual(legacy.review, { model: 'existing/model', reasoningEffort: 'medium', promptCaching: true });
  assert.deepEqual(legacy.recordingRecap, { model: 'existing/model', reasoningEffort: 'low', promptCaching: false });
  // Split-off functions keep the settings of the one they shared until set.
  const split = normalizeAiPreferences({ rewrite: { model: 'own/rewrite', reasoningEffort: 'high', promptCaching: true }, chat: { model: 'own/chat', reasoningEffort: 'xhigh' }, formatting: { model: 'own/formatting', reasoningEffort: 'max' } }, 'existing/model');
  assert.deepEqual(split.write, { model: 'own/rewrite', reasoningEffort: 'high', promptCaching: true });
  assert.deepEqual(split.review, { model: 'own/chat', reasoningEffort: 'xhigh', promptCaching: true });
  assert.deepEqual(split.recordingRecap, { model: 'own/formatting', reasoningEffort: 'low', promptCaching: false });
  assert.equal(normalizeAiPreferences({ rewrite: { model: 'own/rewrite' }, write: { model: 'own/write' } }).write.model, 'own/write');
  assert.equal(normalizeAiPreferences(undefined).formatting.model, 'openai/gpt-6-luna');
  assert.deepEqual(legacy.latex, { model: 'openai/gpt-5.6-luna', reasoningEffort: 'low', promptCaching: false });
  assert.deepEqual(legacy.references, { model: '', reasoningEffort: 'low', promptCaching: false, lookupOnline: true, useAi: true, webSearch: false, contactEmail: '', autoCreateForPdfs: false });
  assert.equal(normalizeAiPreferences({ references: { contactEmail: 'not an email', model: 'bad model' } }).references.contactEmail, '');
  assert.equal(normalizeAiPreferences({ references: { model: 'bad model' } }).references.model, '');
  assert.deepEqual(legacy.whereWasI, { enabled: true, summarize: true, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low' });
  assert.equal(normalizeAiPreferences({ whereWasI: { model: 'bad model', reasoningEffort: 'huge' } }).whereWasI.model, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(legacy.pdfToMarkdown, { engine: 'local', model: 'openai/gpt-6-luna', reasoningEffort: 'low', concurrency: 6, cleanup: true });
  assert.deepEqual(normalizeAiPreferences({ pdfToMarkdown: { engine: 'cloud', model: 'bad model', concurrency: 40, cleanup: 'no' } }).pdfToMarkdown, legacy.pdfToMarkdown);
  const efforts = { formatting: 'low', rewrite: 'high', write: 'medium', chat: 'xhigh', review: 'high', recordingRecap: 'low', imageToMarkdown: 'medium', latex: 'max' };
  const aiFunctions = Object.fromEntries(AI_FUNCTIONS.map((name) => [name, {
    model: name === "chat" ? "deepseek/deepseek-v4.1-flash" : `provider/${name}`,
    reasoningEffort: efforts[name],
    promptCaching: name !== "chat",
    ...(['rewrite', 'chat'].includes(name) ? { customInstruction: `Instructions for ${name}.` } : {}),
    ...(name === 'chat' ? { alternativeModels: ['anthropic/claude-sonnet-4.5', 'google/gemini-3.5-pro'] } : {}),
  }]));
  aiFunctions.references = { model: 'provider/references', reasoningEffort: 'high', promptCaching: true, lookupOnline: false, useAi: true, webSearch: true, contactEmail: 'me@example.org', autoCreateForPdfs: true };
  aiFunctions.whereWasI = { enabled: false, summarize: false, model: 'provider/recap', reasoningEffort: 'medium' };
  aiFunctions.pdfToMarkdown = { engine: 'openrouter', model: 'provider/pdf', reasoningEffort: 'medium', concurrency: 3, cleanup: false };
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('alternative models are trimmed, deduplicated, and exclude the default model', () => {
  assert.deepEqual(normalizeAlternativeModels([
    ' provider/alternative ', 'provider/default', 'provider/alternative', '', 'not a/model', 42,
  ], 'provider/default'), ['provider/alternative']);
  assert.deepEqual(normalizeAlternativeModels('one/model\r\ntwo/model\none/model', 'default/model'), ['one/model', 'two/model']);
});

test('Preferences UI loads and saves every function setting', async () => {
  const aiFunctions = normalizeAiPreferences({
    chat: { customInstruction: 'Prefer concise answers.', model: 'test/default-model', alternativeModels: ['test/fast-model', 'test/deep-model'] },
    rewrite: { customInstruction: 'Preserve the author voice.' },
    references: { webSearch: true, contactEmail: 'me@example.org' },
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
      assert.equal(document.querySelector(`#ai-${name}-caching`).value, String(name === "chat" || name === "review" || name === "rewrite" || name === "write"));
      document.querySelector(`#ai-${name}-caching`).value = String(name !== "chat");
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
    assert.deepEqual(saved.aiFunctions.pdfToMarkdown, { engine: 'openrouter', model: 'custom/pdf', reasoningEffort: 'low', concurrency: 4, cleanup: true });
    for (const name of AI_FUNCTIONS) assert.deepEqual(saved.aiFunctions[name], {
      model: `custom/${name}`,
      reasoningEffort: 'max',
      promptCaching: name !== 'chat',
      ...(name === 'chat' ? { customInstruction: 'Instruction loaded from a file.', alternativeModels: ['custom/chat', 'custom/fast', 'custom/fast'] } : {}),
      ...(name === 'rewrite' ? { customInstruction: 'Rewrite instruction loaded from a file.' } : {}),
    });
    assert.deepEqual(saved.aiFunctions.references, {
      model: 'custom/references', reasoningEffort: 'low', promptCaching: false, lookupOnline: false, useAi: true, webSearch: true, autoCreateForPdfs: true, contactEmail: 'me@example.org',
    });
    assert.deepEqual(saved.aiFunctions.whereWasI, { enabled: false, summarize: false, model: 'custom/recap', reasoningEffort: 'low' });
    document.querySelector('#ai-all-models').value = ' every/model ';
    document.querySelector('#ai-all-models-apply').click();
    for (const selector of ['#openrouter-model', ...AI_FUNCTIONS.map((name) => `#ai-${name}-model`), '#ai-references-model', '#ai-whereWasI-model']) {
      assert.equal(document.querySelector(selector).value, 'every/model', selector);
    }
    assert.equal(document.querySelector('#ai-chat-alternative-models').value, 'custom/chat\ncustom/fast\ncustom/fast');
    assert.deepEqual(saved.quickPrompts, [
      { identifier: 'summary', prompt: 'Summarize $1.' },
      { identifier: 'rewrite', prompt: 'Rewrite $1 for $2.' },
    ]);
  } finally { dom.window.close(); }
});
