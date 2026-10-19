// Background worker for voice memo transcription.
//
// The Next server forks this file as a separate Node process (Electron runs it
// with ELECTRON_RUN_AS_NODE), like the search and PDF reading workers, so
// decoding hours of audio and running the speech models never block the app,
// a crash cannot take it down, and the memory is returned when it exits.
//
// It does the audio work only; the server plans the job (src/lib/transcription):
// it decodes a recording once to 16 kHz mono and keeps the samples while the
// server asks for speaker turns (pyannote segmentation-3.0 with a speaker
// embedding model and clustering, through sherpa-onnx), for pieces to be
// recognized here (NVIDIA Parakeet TDT 0.6B v3, also through sherpa-onnx), or
// for pieces as WAV to send to a speech-to-text service.
//
// The model weights stay outside the app, in the folder chosen in
// Preferences → Speech; their paths arrive with each request.
//
// Protocol (process.send / "message", advanced serialization):
//   → { id, type: "configure", config: { threads, decoder: { kind, path } } }
//   → { id, type: "open", path }                 ← { handle, duration, envelope: { frameSeconds, values } }
//   → { id, type: "diarize", handle, models, speakers }   ← { turns: [{ start, end, speaker }] }  (progress messages too)
//   → { id, type: "recognize", handle, start, end, model } ← { text, tokens, timestamps, durations }
//   → { id, type: "wav", handle, start, end }    ← Uint8Array (16-bit PCM WAV)
//   → { id, type: "peaks", path, buckets }       ← { duration, peaks }
//   → { id, type: "close", handle }
//   → { type: "cancel", target }                  stops a running decode
// Progress: { type: "progress", id, value } with value 0–1.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const PEAKS_SAMPLE_RATE = 4_000;
const ENVELOPE_FRAME_SECONDS = 0.05;

let config = { threads: 2, decoder: { kind: "wav-only", path: "" } };
let sherpa = null;
let recognizer = null;
let recognizerKey = "";
let diarizer = null;
let diarizerKey = "";
const recordings = new Map();
const running = new Map();
let nextHandle = 1;

function loadSherpa() {
  sherpa ??= require("sherpa-onnx-node");
  return sherpa;
}

// ---------------------------------------------------------------- decoding

/** Run a decoder that writes raw 16-bit little-endian samples to stdout. */
function decodeWithFfmpeg(file, sampleRate, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.decoder.path, [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    running.set(id, () => child.kill("SIGKILL"));
    const chunks = [];
    let length = 0;
    let errors = "";
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (errors.length < 4000) errors += chunk;
    });
    child.once("error", (error) => reject(new Error(`Could not run ffmpeg: ${error.message}`)));
    child.once("close", (code, signal) => {
      running.delete(id);
      if (signal === "SIGKILL") return reject(new Error("Cancelled."));
      if (code !== 0) return reject(new Error(errors.trim().split("\n").at(-1) || `ffmpeg stopped (${code}).`));
      resolve(int16ToFloat(chunks, length));
    });
  });
}

function int16ToFloat(chunks, length) {
  const samples = new Float32Array(Math.floor(length / 2));
  let index = 0;
  let carry = null;
  for (let chunk of chunks) {
    if (carry !== null) {
      chunk = Buffer.concat([Buffer.from([carry]), chunk]);
      carry = null;
    }
    const usable = chunk.length - (chunk.length % 2);
    for (let offset = 0; offset < usable; offset += 2) samples[index++] = chunk.readInt16LE(offset) / 32768;
    if (usable < chunk.length) carry = chunk[usable];
  }
  return samples;
}

/** macOS's own converter, for computers without ffmpeg. It writes a WAV file we then read. */
async function decodeWithAfconvert(file, sampleRate, id) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-audio-"));
  const output = path.join(directory, "decoded.wav");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(config.decoder.path || "/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI16@${sampleRate}`, "-c", "1", file, output], { stdio: ["ignore", "ignore", "pipe"] });
      running.set(id, () => child.kill("SIGKILL"));
      let errors = "";
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.once("error", (error) => reject(new Error(`Could not run afconvert: ${error.message}`)));
      child.once("close", (code, signal) => {
        running.delete(id);
        if (signal === "SIGKILL") reject(new Error("Cancelled."));
        else if (code !== 0) reject(new Error(errors.trim() || `This audio format cannot be read (afconvert ${code}).`));
        else resolve();
      });
    });
    return decodeWav(await readFile(output), sampleRate);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** PCM or float WAV of any rate and channel count, mixed to mono and resampled. */
function decodeWav(bytes, sampleRate) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("This recording needs ffmpeg to be read. Install ffmpeg, or choose it in Preferences → Speech.");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        code: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        rate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
      if (format.code === 0xfffe && size >= 26) format.code = bytes.readUInt16LE(body + 24);
    } else if (id === "data") {
      data = { start: body, end: Math.min(bytes.length, body + size) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new Error("The WAV file is incomplete.");
  const { code, channels, rate, bits } = format;
  const bytesPerSample = bits / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor((data.end - data.start) / frameBytes);
  const read = code === 3 && bits === 32 ? (at) => bytes.readFloatLE(at)
    : code === 1 && bits === 16 ? (at) => bytes.readInt16LE(at) / 32768
      : code === 1 && bits === 24 ? (at) => bytes.readIntLE(at, 3) / 8388608
        : code === 1 && bits === 32 ? (at) => bytes.readInt32LE(at) / 2147483648
          : code === 1 && bits === 8 ? (at) => (bytes[at] - 128) / 128
            : null;
  if (!read) throw new Error("This WAV encoding needs ffmpeg to be read.");
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const at = data.start + frame * frameBytes;
    for (let channel = 0; channel < channels; channel += 1) sum += read(at + channel * bytesPerSample);
    mono[frame] = sum / channels;
  }
  return resample(mono, rate, sampleRate);
}

/** Lower rates average the samples each output sample covers, which keeps aliasing out of speech. */
function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = index * ratio;
    if (ratio > 1) {
      const first = Math.floor(start);
      const last = Math.min(samples.length, Math.floor(start + ratio));
      let sum = 0;
      for (let position = first; position < last; position += 1) sum += samples[position];
      output[index] = sum / Math.max(1, last - first);
    } else {
      const position = Math.floor(start);
      const fraction = start - position;
      output[index] = samples[position] * (1 - fraction) + (samples[position + 1] ?? samples[position]) * fraction;
    }
  }
  return output;
}

async function decode(file, sampleRate, id) {
  const { kind } = config.decoder;
  if (kind === "ffmpeg") return decodeWithFfmpeg(file, sampleRate, id);
  if (kind === "afconvert") return decodeWithAfconvert(file, sampleRate, id);
  return decodeWav(await readFile(file), sampleRate);
}

function loudnessEnvelope(samples) {
  const frame = Math.round(SAMPLE_RATE * ENVELOPE_FRAME_SECONDS);
  const values = new Float32Array(Math.ceil(samples.length / frame));
  for (let index = 0; index < values.length; index += 1) {
    let sum = 0;
    const end = Math.min(samples.length, (index + 1) * frame);
    for (let position = index * frame; position < end; position += 1) sum += samples[position] * samples[position];
    values[index] = Math.sqrt(sum / Math.max(1, end - index * frame));
  }
  return { frameSeconds: ENVELOPE_FRAME_SECONDS, values };
}

function slice(handle, start, end) {
  const recording = recordings.get(handle);
  if (!recording) throw new Error("The recording is no longer open.");
  const from = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const to = Math.min(recording.samples.length, Math.ceil(end * SAMPLE_RATE));
  return recording.samples.subarray(from, Math.max(from, to));
}

function wavBytes(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), 44 + index * 2);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

// ---------------------------------------------------------------- models

function getRecognizer(model) {
  const key = JSON.stringify([model, config.threads]);
  if (recognizer && recognizerKey === key) return recognizer;
  const { OfflineRecognizer } = loadSherpa();
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
    decodingMethod: "greedy_search",
  });
  recognizerKey = key;
  return recognizer;
}

function getDiarizer(models, speakers) {
  const key = JSON.stringify([models, config.threads]);
  const clustering = { numClusters: speakers > 0 ? speakers : -1, threshold: 0.5 };
  if (diarizer && diarizerKey === key) {
    diarizer.setConfig({ clustering });
    return diarizer;
  }
  const { OfflineSpeakerDiarization } = loadSherpa();
  diarizer = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models.segmentation }, numThreads: config.threads, debug: 0 },
    embedding: { model: models.embedding, numThreads: config.threads, debug: 0 },
    clustering,
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  diarizerKey = key;
  return diarizer;
}

async function diarize(message) {
  const samples = slice(message.handle, 0, Number.POSITIVE_INFINITY);
  const instance = getDiarizer(message.models, message.speakers);
  const addon = require("sherpa-onnx-node/addon.js");
  let segments;
  if (typeof addon.offlineSpeakerDiarizationProcessAsync === "function") {
    // The asynchronous call runs off this thread, so cancellation and other
    // messages are still heard, and it reports how far it has come.
    const onProgress = (processed, total) => {
      const value = typeof total === "number" && total > 0 ? processed / total : processed;
      if (Number.isFinite(value)) process.send?.({ type: "progress", id: message.id, value: Math.max(0, Math.min(1, value)) });
      return 0;
    };
    try {
      segments = await addon.offlineSpeakerDiarizationProcessAsync(instance.handle, samples, onProgress);
    } catch (error) {
      // A build whose asynchronous call takes other arguments: run it here instead.
      if (!(error instanceof TypeError)) throw error;
      segments = instance.process(samples);
    }
  } else {
    segments = instance.process(samples);
  }
  if (typeof segments === "string") segments = JSON.parse(segments);
  return {
    turns: (Array.isArray(segments) ? segments : []).map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      speaker: Number(segment.speaker),
    })).filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && Number.isInteger(turn.speaker)),
  };
}

async function recognize(message) {
  const samples = slice(message.handle, message.start, message.end);
  if (samples.length < SAMPLE_RATE * 0.1) return { text: "", tokens: [], timestamps: [], durations: [] };
  const instance = getRecognizer(message.model);
  const stream = instance.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const result = typeof instance.decodeAsync === "function"
    ? await instance.decodeAsync(stream)
    : (instance.decode(stream), instance.getResult(stream));
  return {
    text: typeof result.text === "string" ? result.text : "",
    tokens: Array.isArray(result.tokens) ? result.tokens : [],
    timestamps: Array.isArray(result.timestamps) ? result.timestamps : [],
    durations: Array.isArray(result.durations) ? result.durations : [],
  };
}

async function peaks(message) {
  const samples = await decode(message.path, PEAKS_SAMPLE_RATE, message.id);
  const buckets = Math.max(1, Math.min(8000, message.buckets | 0));
  const size = samples.length / buckets;
  const values = [];
  for (let index = 0; index < buckets; index += 1) {
    let peak = 0;
    const end = Math.min(samples.length, Math.floor((index + 1) * size));
    for (let position = Math.floor(index * size); position < end; position += 1) {
      const value = Math.abs(samples[position]);
      if (value > peak) peak = value;
    }
    values.push(Math.round(peak * 1000) / 1000);
  }
  return { duration: samples.length / PEAKS_SAMPLE_RATE, peaks: values };
}

// ---------------------------------------------------------------- messages

async function handle(message) {
  switch (message.type) {
    case "configure":
      config = { ...config, ...message.config };
      return null;
    case "open": {
      const samples = await decode(message.path, SAMPLE_RATE, message.id);
      if (!samples.length) throw new Error("The recording has no audio.");
      const handleId = `r${nextHandle++}`;
      recordings.set(handleId, { samples });
      return { handle: handleId, duration: samples.length / SAMPLE_RATE, envelope: loudnessEnvelope(samples) };
    }
    case "diarize":
      return diarize(message);
    case "recognize":
      return recognize(message);
    case "wav":
      return wavBytes(slice(message.handle, message.start, message.end));
    case "peaks":
      return peaks(message);
    case "close":
      recordings.delete(message.handle);
      return null;
    default:
      throw new Error(`Unknown request: ${message.type}`);
  }
}

process.on("message", (message) => {
  if (message?.type === "cancel") {
    running.get(message.target)?.();
    return;
  }
  if (typeof message?.id !== "number") return;
  handle(message).then(
    (result) => process.send?.({ id: message.id, ok: true, result }),
    (error) => process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
