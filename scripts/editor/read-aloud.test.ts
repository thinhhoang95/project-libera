import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { normalizeTtsPreferences, ttsPreferencesFromEnvironment } from "../../electron/tts-preferences.cjs";
import { GET as getTtsStatus, POST as postTts } from "../../src/app/api/tts/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { kokoroLanguage, kokoroSpeakerId, kokoroVoiceNames, resolveKokoroModel } from "../../src/lib/tts/kokoro";
import { speechRequestBody } from "../../src/lib/tts/openrouter-tts";
import { MAX_TTS_REQUEST_CHARS, speechChunks, speechText, speechTextFromLatex, speechTextFromMarkdown, speechTextFromPlain } from "../../src/lib/tts/text";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createOpenRouterModelCatalog } = require("../../electron/openrouter-models.cjs");

test("preferences default to Kokoro on OpenRouter and keep valid choices", () => {
  assert.deepEqual(normalizeTtsPreferences({}), {
    engine: "openrouter",
    openRouterModel: "hexgrad/kokoro-82m",
    openRouterVoice: "af_heart",
    modelDirectory: "",
    localVoice: "af_heart",
    speed: 1,
  });
  const chosen = normalizeTtsPreferences({ engine: "local", modelDirectory: "/models/kokoro", localVoice: "bm_george", speed: "1.25", openRouterVoice: "" });
  assert.equal(chosen.engine, "local");
  assert.equal(chosen.modelDirectory, path.resolve("/models/kokoro"));
  assert.equal(chosen.localVoice, "bm_george");
  assert.equal(chosen.speed, 1.25);
  // An emptied OpenRouter voice sends none, for providers with a default.
  assert.equal(chosen.openRouterVoice, "");
  const invalid = normalizeTtsPreferences({ engine: "cloud", speed: 9, openRouterModel: "bad model", localVoice: "two words" });
  assert.equal(invalid.engine, "openrouter");
  assert.equal(invalid.speed, 2);
  assert.equal(invalid.openRouterModel, "hexgrad/kokoro-82m");
  assert.equal(invalid.localVoice, "af_heart");
  assert.equal(normalizeTtsPreferences({ speed: 0.1 }).speed, 0.5);
  assert.equal(ttsPreferencesFromEnvironment({ LIBERA_TTS_ENGINE: "local", LIBERA_TTS_SPEED: "0.9" } as unknown as NodeJS.ProcessEnv).speed, 0.9);
});

test("Markdown is spoken without markup, code, math or URLs", () => {
  const spoken = speechTextFromMarkdown([
    "---", "title: x", "---",
    "# Results", "",
    "The **effect** was *large* (see [the paper](https://example.com/a_(b)) and [@smith2020, p. 3]).",
    "", "- first item", "- [x] done item", "",
    "```js", "const a = 1;", "```", "",
    "Energy is $E = mc^2$ here.", "",
    "$$", "\\int f", "$$", "",
    "| A | B |", "|---|---|", "| 1 | 2 |", "",
    "Visit https://example.org now. Use `npm test`.", "![A cat](cat.png)",
  ].join("\n"));
  assert.ok(!/[*#`$|[\]]/.test(spoken), spoken);
  assert.ok(!spoken.includes("http"), spoken);
  assert.ok(!spoken.includes("title: x"), spoken);
  assert.match(spoken, /^Results\./);
  assert.match(spoken, /The effect was large \(see the paper and\s*\)\./);
  assert.match(spoken, /first item\.\ndone item\./);
  assert.match(spoken, /\(code omitted\)/);
  assert.match(spoken, /\(equation\)/);
  assert.match(spoken, /Energy is here\./);
  assert.match(spoken, /Use npm test\./);
  assert.match(spoken, /A cat\./);
});

test("LaTeX is spoken without commands, comments or references", () => {
  const spoken = speechTextFromLatex([
    "\\section{Method} % hidden comment",
    "We follow \\textbf{prior work}~\\cite{knuth84} as in",
    "Figure~\\ref{fig:a}, with $x^2$ terms.",
    "",
    "\\begin{equation}", "a = b", "\\end{equation}",
    "\\begin{itemize}", "\\item One", "\\item Two", "\\end{itemize}",
  ].join("\n"));
  assert.ok(!/[\\{}%$]/.test(spoken), spoken);
  assert.ok(!spoken.includes("hidden"), spoken);
  assert.match(spoken, /^Method\./);
  // Wrapped source lines join into one sentence.
  assert.match(spoken, /We follow prior work as in Figure, with terms\./);
  assert.match(spoken, /\(equation\)/);
  assert.match(spoken, /One\.\nTwo\./);
});

test("plain text keeps code as written and pauses at line ends", () => {
  assert.equal(speechTextFromPlain("const a = b * 2\n\n  return a;  "), "const a = b * 2.\nreturn a;");
  assert.equal(speechText("**bold**", "plain"), "**bold**.");
  assert.equal(speechText("**bold**"), "bold.");
});

test("passages pack whole sentences, start short, and never exceed a request", () => {
  const sentence = "This sentence has exactly forty-six characters.";
  const chunks = speechChunks(Array.from({ length: 20 }, () => sentence).join(" "));
  assert.ok(chunks[0].length <= 160, chunks[0]);
  assert.ok(chunks.slice(1).every((chunk) => chunk.length <= 320));
  assert.ok(chunks.every((chunk) => chunk.endsWith(".")));
  assert.equal(chunks.join(" "), Array.from({ length: 20 }, () => sentence).join(" "));
  // Paragraphs are never merged.
  assert.deepEqual(speechChunks("One.\nTwo."), ["One.", "Two."]);
  // A sentence longer than a request is split at commas or spaces.
  const long = Array.from({ length: 300 }, (_, index) => `word${index}`).join(", ");
  const parts = speechChunks(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= MAX_TTS_REQUEST_CHARS));
  assert.deepEqual(speechChunks("  \n "), []);
});

test("Kokoro voices map to sherpa-onnx speaker numbers", () => {
  assert.equal(kokoroVoiceNames(53).length, 53);
  assert.equal(kokoroSpeakerId("af_heart", 53), 3);
  assert.equal(kokoroSpeakerId("zm_yunyang", 53), 52);
  assert.equal(kokoroSpeakerId("bm_lewis", 11), 10);
  // A v1.0 voice on the English-only v0.19 model falls back to its first voice.
  assert.equal(kokoroSpeakerId("af_heart", 11), 0);
  assert.equal(kokoroSpeakerId("nobody", 53), 3);
  assert.equal(kokoroSpeakerId("7", 103), 7);
  assert.equal(kokoroSpeakerId("200", 103), 0);
  assert.equal(kokoroLanguage("ef_dora"), "es");
  assert.equal(kokoroLanguage("af_heart"), "");
});

test("the Kokoro folder is checked and resolved", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-kokoro-"));
  try {
    await assert.rejects(resolveKokoroModel(path.join(directory, "absent"), "af_heart"), /Kokoro 82M is not downloaded yet/);
    await assert.rejects(resolveKokoroModel(directory, "af_heart"), /missing model\.onnx, voices\.bin, tokens\.txt, espeak-ng-data/);
    await writeFile(path.join(directory, "model.onnx"), "");
    await writeFile(path.join(directory, "model.int8.onnx"), "");
    await writeFile(path.join(directory, "tokens.txt"), "");
    await writeFile(path.join(directory, "lexicon-us-en.txt"), "");
    await writeFile(path.join(directory, "lexicon-gb-en.txt"), "");
    await writeFile(path.join(directory, "lexicon-zh.txt"), "");
    await mkdir(path.join(directory, "espeak-ng-data"));
    // 53 voices of 510 × 256 float32 each: kokoro-multi-lang-v1_0.
    await writeFile(path.join(directory, "voices.bin"), Buffer.alloc(53 * 510 * 256 * 4));
    const model = await resolveKokoroModel(directory, "bf_emma");
    assert.equal(model.speakers, 53);
    assert.equal(model.sid, 21);
    assert.equal(model.files.model, path.join(directory, "model.int8.onnx"));
    assert.equal(model.files.lexicon, [path.join(directory, "lexicon-gb-en.txt"), path.join(directory, "lexicon-zh.txt")].join(","));
    assert.equal(model.files.lang, "");
    const spanish = await resolveKokoroModel(directory, "ef_dora");
    assert.equal(spanish.files.lang, "es");
    assert.ok(spanish.files.lexicon.startsWith(path.join(directory, "lexicon-us-en.txt")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter speech requests ask for MP3 and leave out defaults", () => {
  assert.deepEqual(speechRequestBody({ model: "hexgrad/kokoro-82m", voice: "af_heart", text: "Hi.", speed: 1 }), {
    model: "hexgrad/kokoro-82m", input: "Hi.", voice: "af_heart", response_format: "mp3",
  });
  assert.deepEqual(speechRequestBody({ model: "m", voice: "", text: "Hi.", speed: 1.5 }), {
    model: "m", input: "Hi.", response_format: "mp3", speed: 1.5,
  });
});

test("the speech model listing keeps each model's voices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-speech-models-"));
  try {
    const catalog = createOpenRouterModelCatalog({
      cacheDir: directory,
      url: "https://openrouter.ai/api/v1/models?output_modalities=speech",
      fetchImpl: async () => new Response(JSON.stringify({ data: [
        { id: "hexgrad/kokoro-82m", name: "Kokoro", supported_voices: ["af_heart", "bm_george"] },
        { id: "fish-audio/s1", name: "Fish", supported_voices: [] },
      ] })),
    });
    const { models } = await catalog.list();
    assert.deepEqual(models.find((model: { id: string }) => model.id === "hexgrad/kokoro-82m").voices, ["af_heart", "bm_george"]);
    assert.equal(models.find((model: { id: string }) => model.id === "fish-audio/s1").voices, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("/api/tts asks for sign-in, text, and a ready engine", async () => {
  const saved = { config: process.env.LIBERA_CONFIG_PATH, engine: process.env.LIBERA_TTS_ENGINE, dir: process.env.LIBERA_TTS_MODEL_DIR };
  delete process.env.LIBERA_CONFIG_PATH;
  process.env.LIBERA_TTS_ENGINE = "local";
  delete process.env.LIBERA_TTS_MODEL_DIR;
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
  const post = (body: unknown, signedIn = true) => new NextRequest("http://localhost/api/tts", {
    method: "POST", body: JSON.stringify(body), headers: signedIn ? { cookie, "content-type": "application/json" } : { "content-type": "application/json" },
  });
  try {
    assert.equal((await postTts(post({ text: "Hi." }, false))).status, 401);
    assert.equal((await postTts(post({ text: "  " }))).status, 400);
    assert.equal((await postTts(post({ text: "a".repeat(MAX_TTS_REQUEST_CHARS + 1) }))).status, 413);
    const missing = await postTts(post({ text: "Hello." }));
    assert.equal(missing.status, 502);
    assert.match((await missing.json()).error, /Kokoro 82M is not downloaded yet/);
    const status = await (await getTtsStatus(new NextRequest("http://localhost/api/tts", { headers: { cookie } }))).json();
    assert.equal(status.engine, "local");
    assert.equal(status.ready, false);
    assert.equal(status.modelMissing, true);
  } finally {
    for (const [name, value] of [["LIBERA_CONFIG_PATH", saved.config], ["LIBERA_TTS_ENGINE", saved.engine], ["LIBERA_TTS_MODEL_DIR", saved.dir]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
