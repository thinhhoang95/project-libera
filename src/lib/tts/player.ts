import { speechChunks, speechText, type SpeechFormat } from "@/lib/tts/text";

/**
 * The one thing being read aloud in this window. Text is split into passages
 * (src/lib/tts/text.ts); each is synthesized by /api/tts and played in turn
 * while the next ones are prepared, so speech starts after the first sentence.
 * Starting something new stops what was playing.
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

type Session = {
  chunks: string[];
  audio: Map<number, Promise<string>>;
  controller: AbortController;
};

let state: SpeechState = IDLE;
let session: Session | null = null;
let element: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<SpeechState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
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

function prepare(current: Session, index: number) {
  for (let ahead = index; ahead < Math.min(current.chunks.length, index + 1 + PREFETCH); ahead += 1) {
    if (current.audio.has(ahead)) continue;
    const pending = synthesize(current.chunks[ahead], current.controller.signal);
    pending.catch(() => undefined);
    current.audio.set(ahead, pending);
  }
}

function release(current: Session) {
  current.controller.abort();
  for (const pending of current.audio.values()) pending.then((url) => URL.revokeObjectURL(url), () => undefined);
  current.audio.clear();
}

async function play(current: Session, index: number) {
  if (session !== current) return;
  if (index >= current.chunks.length) {
    stopSpeech();
    return;
  }
  prepare(current, index);
  if (!element || element.paused) setState({ status: "loading", index });
  let url: string;
  try {
    url = await current.audio.get(index)!;
  } catch (error) {
    if (session !== current) return;
    stopSpeech();
    setState({ error: error instanceof Error ? error.message : "Could not read the text aloud." });
    return;
  }
  if (session !== current) return;
  element ??= new Audio();
  const audio = element;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    current.audio.delete(index);
    void play(current, index + 1);
  };
  audio.onerror = () => {
    if (session !== current) return;
    stopSpeech();
    setState({ error: "This audio could not be played." });
  };
  audio.src = url;
  try {
    await audio.play();
    if (session === current) setState({ status: "playing", index });
  } catch (error) {
    if (session !== current || (error instanceof DOMException && error.name === "AbortError")) return;
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
  const current: Session = { chunks, audio: new Map(), controller: new AbortController() };
  session = current;
  setState({ ...IDLE, status: "loading", sourceId, label, total: chunks.length });
  void play(current, 0);
}

export function stopSpeech() {
  const current = session;
  session = null;
  if (element) {
    element.onended = null;
    element.onerror = null;
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
  if (current) release(current);
  if (state.status !== "idle" || state.error) setState(IDLE);
}

export function toggleSpeechPause() {
  if (!element || !session) return;
  if (state.status === "playing") {
    element.pause();
    setState({ status: "paused" });
  } else if (state.status === "paused") {
    void element.play().then(() => setState({ status: "playing" }), () => undefined);
  }
}

export function dismissSpeechError() {
  if (state.error) setState({ error: "" });
}

/** Read aloud, or stop when this source is the one being read. */
export function toggleSpeech(markdown: string, options: SpeakOptions & { sourceId: string }) {
  if (state.sourceId === options.sourceId && state.status !== "idle") stopSpeech();
  else speakMarkdown(markdown, options);
}
