import { ensureLocalModel } from "@/components/libera/local-models/local-model-client";
import { speechChunks, speechText, type SpeechFormat } from "@/lib/tts/text";

/**
 * The one thing being read aloud in this window. Text is split into passages
 * (src/lib/tts/text.ts); each is synthesized by /api/tts and played in turn
 * while the next ones are prepared, so speech starts after the first sentence.
 * Reading can jump to any passage, or partway into one. Starting something new
 * stops what was playing.
 */
export type SpeechStatus = "idle" | "loading" | "playing" | "paused";
export type SpeechState = {
  status: SpeechStatus;
  /** Who started it, such as "chat:<message id>", so its button can show Stop. */
  sourceId: string | null;
  label: string;
  /** The passage being played (0-based) and how many there are. */
  index: number;
  total: number;
  error: string;
};

const IDLE: SpeechState = { status: "idle", sourceId: null, label: "", index: 0, total: 0, error: "" };
/** Passages prepared ahead of the one playing. */
const PREFETCH = 2;
/** Played passages kept so going back a little is instant. */
const KEEP_BEHIND = 3;
/** Going back from further into a passage than this restarts it instead of moving to the previous one. */
const RESTART_SECONDS = 3;

type Clip = { url: Promise<string>; controller: AbortController; ready: boolean };
type Session = {
  chunks: string[];
  audio: Map<number, Clip>;
  /** Bumped on every jump, so an earlier jump that finishes loading late is dropped. */
  generation: number;
};

let state: SpeechState = IDLE;
let session: Session | null = null;
let element: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();
/** Where reading is, in passages: 2.5 is halfway through the third. Kept apart from `state` since it changes as audio plays. */
let progress = 0;
const progressListeners = new Set<() => void>();

function setState(next: Partial<SpeechState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function setProgress(next: number) {
  if (next === progress) return;
  progress = next;
  for (const listener of progressListeners) listener();
}

export function subscribeSpeech(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSpeechState() {
  return state;
}

export function getIdleSpeechState() {
  return IDLE;
}

export function subscribeSpeechProgress(listener: () => void) {
  progressListeners.add(listener);
  return () => { progressListeners.delete(listener); };
}

export function getSpeechProgress() {
  return progress;
}

/** The text of one passage of what is being read, to preview where a jump lands. */
export function getSpeechPassage(index: number) {
  return session?.chunks[index] ?? "";
}

async function synthesize(text: string, signal: AbortSignal) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Could not read the text aloud.");
  }
  return URL.createObjectURL(await response.blob());
}

function discard(clip: Clip) {
  clip.controller.abort();
  clip.url.then((url) => URL.revokeObjectURL(url), () => undefined);
}

/** Prepare the passages from `index` on and let go of those far from it. */
function prepare(current: Session, index: number) {
  for (const [at, clip] of current.audio) {
    if (at < index - KEEP_BEHIND || at > index + PREFETCH) {
      discard(clip);
      current.audio.delete(at);
    }
  }
  for (let ahead = index; ahead < Math.min(current.chunks.length, index + 1 + PREFETCH); ahead += 1) {
    if (current.audio.has(ahead)) continue;
    const controller = new AbortController();
    const clip: Clip = { url: synthesize(current.chunks[ahead], controller.signal), controller, ready: false };
    clip.url.then(() => { clip.ready = true; }, () => undefined);
    current.audio.set(ahead, clip);
  }
}

function release(current: Session) {
  for (const clip of current.audio.values()) discard(clip);
  current.audio.clear();
}

function detach(audio: HTMLAudioElement) {
  audio.onended = null;
  audio.onerror = null;
  audio.ontimeupdate = null;
  audio.pause();
}

/** Play passage `index` from `offset` (0–1 of the way through); with `autoplay` false it is only cued, paused. */
async function play(current: Session, index: number, offset = 0, autoplay = true) {
  if (session !== current) return;
  if (index >= current.chunks.length) {
    stopSpeech();
    return;
  }
  const generation = ++current.generation;
  const stale = () => session !== current || current.generation !== generation;
  prepare(current, index);
  setProgress(index + offset);
  if (!element || element.paused) setState({ status: autoplay ? "loading" : "paused", index });
  let url: string;
  try {
    url = await current.audio.get(index)!.url;
  } catch (error) {
    if (stale()) return;
    stopSpeech();
    setState({ error: error instanceof Error ? error.message : "Could not read the text aloud." });
    return;
  }
  if (stale()) return;
  element ??= new Audio();
  const audio = element;
  detach(audio);
  audio.onended = () => { void play(current, index + 1); };
  audio.onerror = () => {
    if (stale()) return;
    stopSpeech();
    setState({ error: "This audio could not be played." });
  };
  audio.ontimeupdate = () => {
    if (!stale() && audio.duration > 0 && Number.isFinite(audio.duration)) setProgress(index + Math.min(audio.currentTime / audio.duration, 0.999));
  };
  if (offset > 0) {
    const loaded = new Promise((resolve) => {
      audio.addEventListener("loadedmetadata", resolve, { once: true });
      audio.addEventListener("error", resolve, { once: true });
    });
    audio.src = url;
    await loaded;
    if (stale()) return;
    if (Number.isFinite(audio.duration)) audio.currentTime = offset * audio.duration;
  } else {
    audio.src = url;
  }
  if (!autoplay) {
    setState({ status: "paused", index });
    return;
  }
  try {
    await audio.play();
    if (!stale()) setState({ status: "playing", index });
  } catch (error) {
    if (stale() || (error instanceof DOMException && error.name === "AbortError")) return;
    stopSpeech();
    setState({ error: error instanceof Error ? error.message : "This audio could not be played." });
  }
}

export type SpeakOptions = { sourceId?: string | null; label?: string; format?: SpeechFormat };

/** Read text aloud (Markdown unless `format` says otherwise); any reading in progress stops first. */
export function speakMarkdown(markdown: string, { sourceId = null, label = "", format = "markdown" }: SpeakOptions = {}) {
  stopSpeech();
  const chunks = speechChunks(speechText(markdown, format));
  if (!chunks.length) {
    setState({ ...IDLE, error: "There is no text to read aloud." });
    return;
  }
  const current: Session = { chunks, audio: new Map(), generation: 0 };
  session = current;
  setState({ ...IDLE, status: "loading", sourceId, label, total: chunks.length });
  void (async () => {
    if (!(await readAloudModelReady())) {
      if (session === current) stopSpeech();
      return;
    }
    void play(current, 0);
  })();
}

/** False when Kokoro is not downloaded and the user closed the offer to download it. */
async function readAloudModelReady() {
  try {
    const response = await fetch("/api/tts");
    const payload = (await response.json()) as { modelMissing?: boolean };
    return payload.modelMissing ? await ensureLocalModel("read-aloud") : true;
  } catch {
    // Reading reports the problem.
    return true;
  }
}

export function stopSpeech() {
  const current = session;
  session = null;
  if (element) {
    detach(element);
    element.removeAttribute("src");
    element.load();
  }
  if (current) release(current);
  setProgress(0);
  if (state.status !== "idle" || state.error) setState(IDLE);
}

export function toggleSpeechPause() {
  if (!element || !session) return;
  if (state.status === "playing") {
    element.pause();
    setState({ status: "paused" });
  } else if (state.status === "paused" && element.src) {
    void element.play().then(() => setState({ status: "playing" }), () => undefined);
  }
}

/**
 * Jump to a point in what is being read, in passages (2.5 is halfway through
 * the third). Reading carries on from there, or stays paused when it was.
 */
export function seekSpeech(position: number) {
  const current = session;
  if (!current || state.status === "idle") return;
  const clamped = Math.min(Math.max(position, 0), current.chunks.length - 0.001);
  const index = Math.floor(clamped);
  const keepPaused = state.status === "paused";
  if (element) {
    detach(element);
    // So resuming before the new passage is cued does not replay the old one.
    if (keepPaused) element.removeAttribute("src");
  }
  void play(current, index, clamped - index, !keepPaused);
}

/**
 * Move by whole passages. Going back from partway into a passage restarts it
 * first, like a media player's previous button.
 */
export function skipSpeechPassage(delta: number) {
  if (!session || state.status === "idle") return;
  const restart = delta < 0 && element && element.currentTime > RESTART_SECONDS;
  const target = restart ? state.index : state.index + delta;
  if (target >= session.chunks.length) return;
  seekSpeech(Math.max(target, 0));
}

export function dismissSpeechError() {
  if (state.error) setState({ error: "" });
}

/** Read aloud, or stop when this source is the one being read. */
export function toggleSpeech(markdown: string, options: SpeakOptions & { sourceId: string }) {
  if (state.sourceId === options.sourceId && state.status !== "idle") stopSpeech();
  else speakMarkdown(markdown, options);
}
