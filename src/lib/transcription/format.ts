import type { Transcript, TranscriptSegment } from "@/lib/transcription/types";

/** "3:05", or "1:02:03" past an hour. */
export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "1h 12m", "4m 05s", "38s". */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${total}s`;
}

export function speakerName(transcript: Pick<Transcript, "speakers">, speaker: number | null) {
  return speaker === null ? "" : transcript.speakers[speaker]?.name || `Speaker ${speaker + 1}`;
}

/** The segment playing at `time`, or the last one before it; -1 before the first. */
export function segmentIndexAt(segments: TranscriptSegment[], time: number) {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].start <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

const PASSAGE_TARGET_CHARS = 1100;
const PASSAGE_CONTEXT_CHARS = 200;

/** A transcript passage for Global Search. Times are milliseconds into the recording. */
export type TranscriptPassage = { title: string; text: string; context: string; start: number; end: number };

/**
 * Global Search passages: consecutive segments up to about 250 tokens, each
 * line led by its speaker so a search for a name finds what they said. The
 * passage's start and end are milliseconds into the recording.
 */
export function transcriptPassages(transcript: Transcript): TranscriptPassage[] {
  const passages: TranscriptPassage[] = [];
  let lines: string[] = [];
  let names = new Set<string>();
  let start = 0;
  let end = 0;
  let previousTail = "";

  const flush = () => {
    if (!lines.length) return;
    const text = lines.join("\n");
    passages.push({ title: [...names].join(", "), text, context: previousTail, start: Math.round(start * 1000), end: Math.round(end * 1000) });
    previousTail = text.slice(-PASSAGE_CONTEXT_CHARS).replace(/^\S*\s/, "");
    lines = [];
    names = new Set();
  };

  for (const segment of transcript.segments) {
    if (!segment.text) continue;
    const name = speakerName(transcript, segment.speaker);
    const line = name ? `${name}: ${segment.text}` : segment.text;
    if (lines.length && lines.join("\n").length + line.length > PASSAGE_TARGET_CHARS) flush();
    if (!lines.length) start = segment.start;
    lines.push(line);
    if (name) names.add(name);
    end = segment.end;
  }
  flush();
  return passages;
}

/** One line of a transcript as the AI reads it: "[3:05] Vy: …". */
export function transcriptLine(transcript: Pick<Transcript, "speakers">, segment: TranscriptSegment, text = segment.text) {
  const name = speakerName(transcript, segment.speaker);
  return `[${formatClock(segment.start)}]${name ? ` ${name}:` : ""} ${text}`;
}

/** A transcript as context for the AI: who speaks, then every line with its time. */
export function transcriptContextText(transcript: Transcript, name: string, path?: string) {
  const speakers = transcript.speakers.map((speaker) => speaker.name).join(", ");
  const header = `Transcript of the recording ${name} (${formatClock(transcript.audio.duration)}${speakers ? `; speakers: ${speakers}` : ""}).`;
  // Answers can point to moments, which open the recording there.
  const linking = path ? `To cite a moment, link it as [3:05](${path.split("/").map(encodeURIComponent).join("/")}#t=185), with the time in seconds after #t=.` : "";
  return [header, linking, "", ...transcript.segments.map((segment) => transcriptLine(transcript, segment))].filter((line, index) => line || index !== 1).join("\n");
}

/** The transcript as plain text: each speaker turn as a paragraph led by its time and speaker. */
export function transcriptToText(transcript: Transcript) {
  const blocks: string[] = [];
  let previous: number | null | undefined;
  for (const segment of transcript.segments) {
    if (blocks.length && segment.speaker === previous) blocks[blocks.length - 1] += ` ${segment.text}`;
    else blocks.push(transcriptLine(transcript, segment));
    previous = segment.speaker;
  }
  return `${blocks.join("\n\n")}\n`;
}

/** WebVTT subtitles, with speakers as voice tags. */
export function transcriptToVtt(transcript: Transcript) {
  const time = (seconds: number) => srtTime(seconds).replace(",", ".");
  const cues = transcript.segments.map((segment) => {
    const name = speakerName(transcript, segment.speaker);
    return `${time(segment.start)} --> ${time(segment.end)}\n${name ? `<v ${name}>` : ""}${segment.text}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** The transcript as Markdown: each speaker turn led by the speaker and its time. */
export function transcriptToMarkdown(transcript: Transcript, title: string) {
  const blocks = [`# ${title}`, ""];
  const speakers = transcript.speakers.length ? transcript.speakers.map((speaker) => speaker.name).join(", ") : "";
  if (speakers) blocks.push(`*${speakers}*`, "");
  let previous: number | null | undefined;
  for (const segment of transcript.segments) {
    const name = speakerName(transcript, segment.speaker);
    if (segment.speaker !== previous || !name) {
      blocks.push(name ? `**${name}** · ${formatClock(segment.start)}` : `${formatClock(segment.start)}`);
    }
    blocks.push(segment.text, "");
    previous = segment.speaker;
  }
  return `${blocks.join("\n").trim()}\n`;
}

function srtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`;
}

/** SubRip subtitles, with speakers as voice labels. */
export function transcriptToSrt(transcript: Transcript) {
  return transcript.segments.map((segment, index) => {
    const name = speakerName(transcript, segment.speaker);
    return `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${name ? `${name}: ` : ""}${segment.text}\n`;
  }).join("\n");
}

export type TranscriptQuery = {
  /** What is left to find in the text, once `speaker:` filters are taken out. */
  text: string;
  /** Speakers the query is limited to; null when it names none. */
  speakers: number[] | null;
  /** `speaker:` values that match no speaker. */
  unknown: string[];
};

/**
 * Splits a transcript search into its `speaker:` filters and the words to
 * find: `budget speaker:Vy`, `speaker:"Speaker 2" deadline`, `speaker:2`.
 * A speaker matches by the start of their name, ignoring case and accents,
 * or by number. Several `speaker:` filters show any of them.
 */
export function parseTranscriptQuery(query: string, speakers: Array<{ name: string }>): TranscriptQuery {
  // Đ/đ has no decomposition, so it is folded by hand (Vietnamese names).
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d").trim();
  const found = new Set<number>();
  const unknown: string[] = [];
  let named = false;
  const text = query.replace(/(?:^|\s)speaker:(?:"([^"]*)"?|(\S*))/gi, (_match, quoted: string | undefined, bare: string | undefined) => {
    const value = (quoted ?? bare ?? "").trim();
    if (!value) return " ";
    named = true;
    const wanted = fold(value);
    const names = speakers.map((speaker) => fold(speaker.name));
    // An exact name wins over names it is the start of ("Vy" over "Vyas").
    const exact = names.flatMap((name, index) => (name === wanted ? [index] : []));
    const matches = exact.length ? exact : names.flatMap((name, index) => (name.startsWith(wanted) || String(index + 1) === wanted ? [index] : []));
    matches.forEach((index) => found.add(index));
    if (!matches.length) unknown.push(value);
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { text, speakers: named ? [...found].sort((a, b) => a - b) : null, unknown };
}
