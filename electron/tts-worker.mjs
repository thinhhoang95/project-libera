// Background worker for reading text aloud on this computer.
//
// The Next server forks this file as a separate Node process (Electron runs it
// with ELECTRON_RUN_AS_NODE), like the transcription worker, so running the
// speech model never blocks the app, a crash cannot take it down, and the
// memory is returned when it exits.
//
// It runs Kokoro 82M (Apache-2.0) through sherpa-onnx, from sherpa-onnx's
// export of the model. The weights stay outside the app, in the folder chosen
// in Preferences → Read Aloud; their paths arrive with each request.
//
// Protocol (process.send / "message", advanced serialization):
//   → { id, type: "configure", config: { threads } }
//   → { id, type: "synthesize", model, text, sid, speed }  ← Uint8Array (16-bit PCM WAV)
//   → { type: "cancel", target }                             stops a running synthesis
// `model` is { model, voices, tokens, dataDir, lexicon, lang }.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let config = { threads: 2 };
let sherpa = null;
let tts = null;
let ttsKey = "";
const cancelled = new Set();

function loadSherpa() {
  sherpa ??= require("sherpa-onnx-node");
  return sherpa;
}

function getTts(model) {
  const key = JSON.stringify([model, config.threads]);
  if (tts && ttsKey === key) return tts;
  const { OfflineTts } = loadSherpa();
  tts = new OfflineTts({
    model: {
      kokoro: {
        model: model.model,
        voices: model.voices,
        tokens: model.tokens,
        dataDir: model.dataDir,
        ...(model.lexicon ? { lexicon: model.lexicon } : {}),
        ...(model.lang ? { lang: model.lang } : {}),
        lengthScale: 1,
      },
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
  });
  ttsKey = key;
  return tts;
}

function wavBytes(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), 44 + index * 2);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

async function synthesize(message) {
  const instance = getTts(message.model);
  const sid = Number.isInteger(message.sid) && message.sid >= 0 && message.sid < instance.numSpeakers ? message.sid : 0;
  const request = { text: String(message.text ?? ""), sid, speed: Number(message.speed) || 1 };
  let audio;
  if (typeof instance.generateAsync === "function") {
    try {
      // Asynchronous, so a cancel can arrive and stop it between sentences.
      // enableExternalBuffer is off because Electron's V8 refuses external
      // ArrayBuffers, which fails the call with "TTS settlement failed".
      audio = await instance.generateAsync({ ...request, enableExternalBuffer: false, onProgress: () => !cancelled.has(message.id) });
    } catch (error) {
      // A build whose asynchronous call takes other arguments: run it here instead.
      if (!(error instanceof TypeError)) throw error;
      audio = instance.generate(request);
    }
  } else {
    audio = instance.generate(request);
  }
  if (cancelled.delete(message.id)) throw new Error("Cancelled.");
  const samples = audio?.samples instanceof Float32Array ? audio.samples : Float32Array.from(audio?.samples ?? []);
  return wavBytes(samples, Number(audio?.sampleRate) || instance.sampleRate || 24_000);
}

async function handle(message) {
  switch (message.type) {
    case "configure":
      config = { ...config, ...message.config };
      return null;
    case "synthesize":
      return synthesize(message);
    default:
      throw new Error(`Unknown request: ${message.type}`);
  }
}

process.on("message", (message) => {
  if (message?.type === "cancel") {
    cancelled.add(message.target);
    return;
  }
  if (typeof message?.id !== "number") return;
  handle(message).then(
    (result) => process.send?.({ id: message.id, ok: true, result }),
    (error) => process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  ).finally(() => cancelled.delete(message.id));
});

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
