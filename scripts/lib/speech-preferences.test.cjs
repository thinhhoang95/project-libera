const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function openPreferences(state, query = "?mode=configuration") {
  const calls = { saved: undefined, picked: [] };
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: `http://localhost/${query}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ dataDir: "/tmp/notebooks", hasApiKey: true, hasPasswordHash: true, ...state }),
        save: async (input) => { calls.saved = JSON.parse(JSON.stringify(input)); },
        selectSearchWeights: async (kind) => {
          calls.picked.push(kind);
          return kind === "speech-models" ? "/models/libera-speech" : "/opt/homebrew/bin/ffmpeg";
        },
      };
    },
  });
  return { dom, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Speech holds the models, ffmpeg, voice memos and dictation; AI and Read Aloud do not", async () => {
  const { dom, calls } = openPreferences({
    transcription: { engine: "local", openRouterModel: "openai/whisper-large-v3", language: "vi", diarization: true, speakers: 2, modelDirectory: "", ffmpegPath: "", dictation: { engine: "same", openRouterModel: "", language: "" } },
  });
  try {
    await tick();
    const { document, Event } = dom.window;
    document.querySelector('[data-section-button="speech"]').click();
    const speech = document.querySelector('[data-section="speech"]');
    assert.equal(speech.classList.contains("hidden"), false);
    for (const id of ["#transcription-model-directory", "#transcription-ffmpeg", "#transcription-engine", "#dictation-engine", "#dictation-language"]) {
      assert.ok(speech.querySelector(id), `${id} is in Speech`);
    }
    assert.equal(document.querySelector('[data-section="ai"] #transcription-engine'), null);
    assert.equal(document.querySelector('[data-section="read-aloud"] #dictation-engine'), null);
    assert.equal(document.querySelector("#transcription-speakers").value, "2");
    assert.equal(document.querySelector("#dictation-language").placeholder, "Same as voice memos (vi)");
    // Parakeet for both: no OpenRouter model to choose for dictation.
    assert.equal(document.querySelector("#dictation-openrouter-fields").hidden, true);

    document.querySelector("#transcription-model-directory-button").click();
    document.querySelector("#transcription-ffmpeg-button").click();
    const engine = document.querySelector("#dictation-engine");
    engine.value = "openrouter";
    engine.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(document.querySelector("#dictation-openrouter-fields").hidden, false);
    document.querySelector("#dictation-openrouter-model").value = "openai/gpt-4o-mini-transcribe";
    await tick();
    assert.deepEqual(calls.picked, ["speech-models", "ffmpeg"]);

    document.querySelector("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(calls.saved.transcription.modelDirectory, "/models/libera-speech");
    assert.equal(calls.saved.transcription.ffmpegPath, "/opt/homebrew/bin/ffmpeg");
    assert.deepEqual(calls.saved.transcription.dictation, { engine: "openrouter", openRouterModel: "openai/gpt-4o-mini-transcribe", language: "" });
  } finally {
    dom.window.close();
  }
});

test("Preferences can open at Speech, as the transcript panel's links do", async () => {
  const { dom } = openPreferences({}, "?mode=configuration&section=speech");
  try {
    await tick();
    assert.equal(dom.window.document.querySelector('[data-section="speech"]').classList.contains("hidden"), false);
  } finally {
    dom.window.close();
  }
});
