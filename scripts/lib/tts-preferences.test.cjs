const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { inspectKokoroFolder } = require("../../electron/tts-preferences.cjs");

function openPreferences(state, overrides = {}, query = "?mode=configuration&section=read-aloud") {
  const calls = { saved: undefined, checked: [], weights: [] };
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: `http://localhost/${query}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ dataDir: "/tmp/notebooks", hasApiKey: true, hasPasswordHash: true, ...state }),
        save: async (input) => { calls.saved = JSON.parse(JSON.stringify(input)); },
        selectSearchWeights: async (kind) => { calls.weights.push(kind); return "/models/kokoro-multi-lang-v1_0"; },
        checkTtsModel: async (folder) => {
          calls.checked.push(folder);
          return folder.includes("kokoro") ? { ok: true, exists: true, missing: [], voices: 53, quantized: true } : { ok: false, exists: true, missing: ["voices.bin"], voices: 0, quantized: false };
        },
        listOpenRouterModels: async () => ({ ok: true, models: [{ id: "hexgrad/kokoro-82m", name: "Kokoro", voices: ["af_heart", "bm_george"] }] }),
        ...overrides,
      };
    },
  });
  return { dom, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Read Aloud has its own Preferences section with a grouped Kokoro voice picker", async () => {
  const { dom, calls } = openPreferences({
    tts: { engine: "local", openRouterModel: "hexgrad/kokoro-82m", openRouterVoice: "af_heart", modelDirectory: "/old/folder", localVoice: "bm_george", speed: 1.25 },
  });
  try {
    await tick();
    await tick();
    const { document, Event } = dom.window;
    assert.ok(document.querySelector('[data-section-button="read-aloud"]'));
    assert.equal(document.querySelector('[data-section="read-aloud"]').classList.contains("hidden"), false);
    // The settings are no longer part of the AI section.
    assert.equal(document.querySelector('[data-section="ai"] #tts-engine'), null);

    const voice = document.querySelector("#tts-local-voice");
    assert.equal(voice.tagName, "SELECT");
    assert.equal(voice.querySelectorAll("option").length, 53);
    assert.equal(voice.querySelector("optgroup").label, "American English · female");
    assert.equal(voice.value, "bm_george");
    assert.equal(voice.selectedOptions[0].textContent, "George");
    assert.equal(document.querySelector("#tts-speed").value, "1.25");

    // Only the chosen engine's fields show; the folder is checked at once.
    assert.equal(document.querySelector("#tts-local-fields").hidden, false);
    assert.equal(document.querySelector("#tts-openrouter-fields").hidden, true);
    assert.deepEqual(calls.checked, ["/old/folder"]);
    assert.match(document.querySelector("#tts-model-status").textContent, /Missing voices\.bin/);

    document.querySelector("#tts-model-directory-button").click();
    await tick();
    await tick();
    assert.deepEqual(calls.weights, ["tts-model"]);
    assert.match(document.querySelector("#tts-model-status").textContent, /Ready: 53 voices, kokoro-multi-lang-v1_0, 8-bit/);

    voice.value = "ef_dora";
    document.querySelector("#tts-engine").value = "openrouter";
    document.querySelector("#tts-engine").dispatchEvent(new Event("change"));
    await tick();
    assert.equal(document.querySelector("#tts-local-fields").hidden, true);
    assert.equal(document.querySelector("#tts-openrouter-fields").hidden, false);
    assert.deepEqual([...document.querySelectorAll("#tts-openrouter-voices option")].map((option) => option.value), ["af_heart", "bm_george"]);

    document.querySelector("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(calls.saved.tts, {
      engine: "openrouter",
      openRouterModel: "hexgrad/kokoro-82m",
      openRouterVoice: "af_heart",
      modelDirectory: "/models/kokoro-multi-lang-v1_0",
      localVoice: "ef_dora",
      speed: "1.25",
    });
  } finally {
    dom.window.close();
  }
});

test("a saved voice the list does not have is kept", async () => {
  const { dom } = openPreferences({ tts: { engine: "local", localVoice: "12" } });
  try {
    await tick();
    const voice = dom.window.document.querySelector("#tts-local-voice");
    assert.equal(voice.value, "12");
    assert.equal(voice.selectedOptions[0].textContent, "Speaker 12");
  } finally {
    dom.window.close();
  }
});

test("a Kokoro folder reports what is missing and how many voices it has", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "libera-kokoro-check-"));
  try {
    assert.deepEqual(inspectKokoroFolder(""), { ok: false, exists: false, missing: [], voices: 0, quantized: false });
    assert.equal(inspectKokoroFolder(path.join(folder, "nope")).exists, false);
    assert.deepEqual(inspectKokoroFolder(folder).missing, ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/"]);
    writeFileSync(path.join(folder, "model.int8.onnx"), "");
    writeFileSync(path.join(folder, "tokens.txt"), "");
    writeFileSync(path.join(folder, "voices.bin"), Buffer.alloc(11 * 510 * 256 * 4));
    mkdirSync(path.join(folder, "espeak-ng-data"));
    assert.deepEqual(inspectKokoroFolder(folder), { ok: true, exists: true, missing: [], voices: 11, quantized: true });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
