import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Kokoro 82M (Apache-2.0) on this computer, from sherpa-onnx's export:
 * https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
 * (kokoro-multi-lang-v1_0, its int8 variant, or kokoro-en-v0_19). Like the
 * EmbeddingGemma weights, it stays outside Libera: the user extracts the
 * archive and chooses its folder in Preferences → Read Aloud.
 */
export type KokoroModelFiles = {
  model: string;
  voices: string;
  tokens: string;
  dataDir: string;
  lexicon: string;
  lang: string;
};

// sherpa-onnx's speaker numbers for each release, in voices.bin order.
const VOICES_V1_0 = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];
const VOICES_V0_19 = ["af", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_adam", "am_michael", "bf_emma", "bf_isabella", "bm_george", "bm_lewis"];

/** Each Kokoro voice is a 510 × 256 float32 style table in voices.bin. */
const VOICE_BYTES = 510 * 256 * 4;

/** The voice names of a model with this many speakers; unknown releases are chosen by number. */
export function kokoroVoiceNames(speakers: number): string[] {
  if (speakers === VOICES_V1_0.length) return VOICES_V1_0;
  if (speakers === VOICES_V0_19.length) return VOICES_V0_19;
  return Array.from({ length: Math.max(0, speakers) }, (_, index) => String(index));
}

/** The speaker number for a voice name (or a number), falling back to each release's usual default. */
export function kokoroSpeakerId(voice: string, speakers: number) {
  const trimmed = voice.trim();
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return id < speakers ? id : 0;
  }
  const names = kokoroVoiceNames(speakers);
  const index = names.indexOf(trimmed);
  if (index >= 0) return index;
  // af_heart is v1.0's best-rated voice; a name from another release falls back to it, or to the first voice.
  const fallback = names.indexOf("af_heart");
  return fallback >= 0 ? fallback : 0;
}

/**
 * The espeak-ng language for a v1.0 voice, from its first letter. English is
 * left to the model (it reads it with its own lexicon); Japanese and Chinese
 * use the lexicon and dictionaries in the folder.
 */
export function kokoroLanguage(voiceName: string) {
  return ({ e: "es", f: "fr-fr", h: "hi", i: "it", p: "pt-br" } as Record<string, string>)[voiceName[0] ?? ""] ?? "";
}

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export type KokoroModel = { files: KokoroModelFiles; speakers: number; sid: number; voice: string };

/**
 * The model files in the chosen folder, and the speaker for `voice`. The
 * 8-bit export (model.int8.onnx) is preferred when both precisions are there.
 */
export async function resolveKokoroModel(directory: string, voice: string): Promise<KokoroModel> {
  if (!directory) {
    throw new Error("Choose the Kokoro model folder in Preferences → Read Aloud, or read aloud with OpenRouter.");
  }
  if (!(await isDirectory(directory))) {
    throw new Error(`The Kokoro model folder ${directory} does not exist. Choose it again in Preferences → Read Aloud.`);
  }
  const entries = await readdir(directory).catch(() => [] as string[]);
  const onnx = entries.filter((name) => name.toLowerCase().endsWith(".onnx"));
  const modelName = ["model.int8.onnx", "model.onnx"].find((name) => onnx.includes(name)) ?? onnx.sort()[0];
  const voices = path.join(directory, "voices.bin");
  const tokens = path.join(directory, "tokens.txt");
  const dataDir = path.join(directory, "espeak-ng-data");
  const missing = [
    !modelName && "model.onnx",
    !(await isFile(voices)) && "voices.bin",
    !(await isFile(tokens)) && "tokens.txt",
    !(await isDirectory(dataDir)) && "espeak-ng-data/",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`The Kokoro model folder is missing ${missing.join(", ")}. Extract a sherpa-onnx Kokoro release (such as kokoro-multi-lang-v1_0) there.`);
  }

  const speakers = Math.max(1, Math.round((await stat(voices)).size / VOICE_BYTES));
  const sid = kokoroSpeakerId(voice, speakers);
  const voiceName = kokoroVoiceNames(speakers)[sid] ?? "";
  // v1.0 and later read English with a lexicon (British voices with the British one) and Chinese with its own.
  const english = voiceName.startsWith("b") && entries.includes("lexicon-gb-en.txt") ? "lexicon-gb-en.txt" : "lexicon-us-en.txt";
  const lexicon = [english, "lexicon-zh.txt"].filter((name) => entries.includes(name)).map((name) => path.join(directory, name)).join(",");

  return {
    files: { model: path.join(directory, modelName!), voices, tokens, dataDir, lexicon, lang: lexicon ? kokoroLanguage(voiceName) : "" },
    speakers,
    sid,
    voice: voiceName,
  };
}
