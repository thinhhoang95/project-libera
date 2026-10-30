const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createPreferencesBackup, parsePreferencesBackup } = require("../../electron/preferences-io.cjs");

function openPreferences(state, overrides = {}, query = "?mode=configuration") {
  const calls = { saved: undefined, weights: [] };
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: `http://localhost/${query}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ dataDir: "/tmp/notebooks", hasApiKey: true, hasPasswordHash: true, searchDefaultIndexFile: "/app/search-index/x/libera-search.sqlite", ...state }),
        save: async (input) => {
          calls.saved = JSON.parse(JSON.stringify(input));
        },
        selectSearchWeights: async (kind) => {
          calls.weights.push(kind);
          if (kind === "reading") return "/models/granite-docling-258M-ONNX";
          return kind === "vision" ? "/models/onnx/vision_encoder_quantized.onnx" : "/models/onnx/model_quantized.onnx";
        },
        selectSearchIndexFile: async (mode) => (mode === "new" ? "/local/new-index.sqlite" : "/local/copied.sqlite"),
        revealSearchIndex: async (file) => {
          calls.revealed = file;
          return false;
        },
        ...overrides,
      };
    },
  });
  return { dom, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Search preferences load, choose weights and save with the other preferences", async () => {
  const { dom, calls } = openPreferences({
    search: { textWeights: "/old/model_q4.onnx", visionWeights: "", dimensions: 512, visionTokens: 280, indexImages: false, backgroundIndexing: true, embeddingIntervalMinutes: 60, embeddingOnlyOnAC: false, keywordIntervalMinutes: 300, indexFile: "" },
  });

  try {
    await tick();
    const { document, Event } = dom.window;
    document.querySelector('[data-section-button="search"]').click();
    const section = document.querySelector('[data-section="search"]');
    assert.equal(section.classList.contains("hidden"), false);
    assert.equal(document.querySelector("#search-text-weights").value, "/old/model_q4.onnx");
    assert.equal(document.querySelector("#search-dimensions").value, "512");
    assert.equal(document.querySelector("#search-vision-tokens").value, "280");
    assert.equal(document.querySelector("#search-index-images").checked, false);
    assert.equal(document.querySelector("#search-embedding-interval").value, "180");
    assert.equal(document.querySelector("#search-embedding-only-on-ac").checked, false, "preserve an explicitly saved off setting");
    assert.deepEqual(Array.from(document.querySelector("#search-embedding-interval").options, (option) => [option.value, option.textContent]), [
      ["180", "3 hours"], ["720", "12 hours"], ["1440", "1 day"], ["10080", "7 days"],
    ]);
    assert.equal(document.querySelector("#search-keyword-interval").value, "480", "a value between choices rounds up");
    assert.deepEqual(Array.from(document.querySelector("#search-keyword-interval").options, (option) => [option.value, option.textContent]), [
      ["60", "1 hour"], ["240", "4 hours"], ["480", "8 hours"], ["1440", "1 day"], ["4320", "3 days"],
    ]);
    document.querySelector("#search-keyword-interval").value = "1440";
    document.querySelector("#search-embedding-interval").value = "720";
    document.querySelector("#search-embedding-only-on-ac").checked = true;

    document.querySelector("#search-text-weights-button").click();
    document.querySelector("#search-vision-weights-button").click();
    document.querySelector("#reading-model-directory-button").click();
    // Empty means the default, which Reveal shows.
    assert.match(document.querySelector("#search-index-file").placeholder, /search-index\/x\/libera-search\.sqlite/);
    document.querySelector("#search-index-reveal-button").click();
    await tick();
    assert.equal(calls.revealed, "/app/search-index/x/libera-search.sqlite");
    assert.match(document.querySelector("#search-index-help").textContent, /does not exist yet/);
    document.querySelector("#search-index-existing-button").click();
    await tick();
    assert.deepEqual(calls.weights, ["text", "vision", "reading"]);
    document.querySelector("#search-index-images").checked = true;

    document.querySelector("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(calls.saved.search, {
      textWeights: "/models/onnx/model_quantized.onnx",
      visionWeights: "/models/onnx/vision_encoder_quantized.onnx",
      dimensions: "512",
      visionTokens: "280",
      indexImages: true,
      backgroundIndexing: true,
      keywordIntervalMinutes: "1440",
      embeddingIntervalMinutes: "720",
      embeddingOnlyOnAC: true,
      indexFile: "/local/copied.sqlite",
      readingModelDirectory: "/models/granite-docling-258M-ONNX",
    });
  } finally {
    dom.window.close();
  }
});

test("Preferences can open at the Search section", async () => {
  const { dom } = openPreferences({}, {}, "?mode=configuration&section=search");
  try {
    await tick();
    const { document } = dom.window;
    assert.equal(document.querySelector('[data-section="search"]').classList.contains("hidden"), false);
    assert.equal(document.querySelector('[data-section="general"]').classList.contains("hidden"), true);
    // Defaults when nothing is saved yet.
    assert.equal(document.querySelector("#search-dimensions").value, "768");
    assert.equal(document.querySelector("#search-vision-tokens").value, "140");
    assert.equal(document.querySelector("#search-background-indexing").checked, true);
    assert.equal(document.querySelector("#search-embedding-interval").value, "180");
    assert.equal(document.querySelector("#search-embedding-only-on-ac").checked, true);
  } finally {
    dom.window.close();
  }
});

test("Search preferences are part of preference backups", () => {
  const search = { textWeights: "/models/model_q4.onnx", dimensions: 256, embeddingIntervalMinutes: 720, embeddingOnlyOnAC: true };
  const backup = createPreferencesBackup({ dataDir: "/notes", search, sessionSecret: "secret" });
  assert.deepEqual(backup.preferences.search, search);
  assert.deepEqual(parsePreferencesBackup(backup).search, search);
});
