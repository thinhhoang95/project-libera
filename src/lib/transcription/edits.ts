import type { TranscriptSegment } from "@/lib/transcription/types";

/**
 * A transcript edited by its reader. Edits cover a prefix of the transcript
 * as it was transcribed: the first `basedOn` segments are replaced by
 * `segments`, the passages as the reader left them, and the rest show as
 * transcribed. A live transcript keeps growing below the edits; a saved
 * transcript's edits cover all of it. Nothing here touches the disk: the
 * views keep edits in memory and save them once, when the editing ends.
 */
export type SegmentEdits = { basedOn: number; segments: TranscriptSegment[] };

export const MAX_SEGMENT_TEXT = 4_000;
const MAX_SEGMENTS = 20_000;

export function applySegmentEdits(base: TranscriptSegment[], edits: SegmentEdits | null): TranscriptSegment[] {
  if (!edits) return base;
  return [...edits.segments, ...base.slice(Math.min(edits.basedOn, base.length))];
}

/** Edits that take in the shown passages up to `end` (exclusive), copying transcribed ones as they are. */
function cover(base: TranscriptSegment[], edits: SegmentEdits | null, end: number): SegmentEdits {
  const current = edits ?? { basedOn: 0, segments: [] };
  const missing = end - current.segments.length;
  if (missing <= 0) return current;
  const taken = base.slice(current.basedOn, current.basedOn + missing);
  return { basedOn: current.basedOn + taken.length, segments: [...current.segments, ...taken] };
}

/** What typing leaves in a line: one line of text, without the spaces around it. */
export function cleanLineText(text: string) {
  return text.replace(/ /g, " ").replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, MAX_SEGMENT_TEXT);
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;

export function setSegmentText(base: TranscriptSegment[], edits: SegmentEdits | null, index: number, text: string): SegmentEdits | null {
  const shown = applySegmentEdits(base, edits);
  if (!shown[index] || shown[index].text === text) return edits;
  const next = cover(base, edits, index + 1);
  const segments = [...next.segments];
  segments[index] = { ...segments[index], text };
  return { ...next, segments };
}

/**
 * Enter: the line breaks in two at `offset` of `text` (the line as typed). The
 * time between its start and end is shared in proportion to the text, since
 * a passage's words are not timed one by one; at the end of a line, the new
 * line starts where it ends.
 */
export function splitSegment(base: TranscriptSegment[], edits: SegmentEdits | null, index: number, text: string, offset: number): SegmentEdits | null {
  const shown = applySegmentEdits(base, edits);
  const segment = shown[index];
  if (!segment) return edits;
  const at = Math.max(0, Math.min(text.length, offset));
  const before = cleanLineText(text.slice(0, at));
  const after = cleanLineText(text.slice(at));
  const ratio = text.trim().length && after ? at / text.length : 1;
  const time = round(segment.start + (segment.end - segment.start) * ratio);
  const next = cover(base, edits, index + 1);
  const segments = [...next.segments];
  segments.splice(index, 1, { ...segment, text: before, end: time }, { ...segment, text: after, start: time, end: after ? segment.end : time });
  return { ...next, segments };
}

/**
 * Backspace at the start of line `index` (typed as `text`): it joins the line
 * before. Returns the edits and where the caret goes in the joined line.
 */
export function joinSegments(base: TranscriptSegment[], edits: SegmentEdits | null, index: number, text: string): { edits: SegmentEdits; caret: number } | null {
  const shown = applySegmentEdits(base, edits);
  const previous = shown[index - 1];
  const segment = shown[index];
  if (!previous || !segment) return null;
  const head = previous.text.trimEnd();
  const tail = cleanLineText(text);
  const joined = head && tail ? `${head} ${tail}` : head || tail;
  const next = cover(base, edits, index + 1);
  const segments = [...next.segments];
  segments.splice(index - 1, 2, { ...previous, text: joined, end: Math.max(previous.end, segment.end) });
  return { edits: { ...next, segments }, caret: head.length };
}

/** Lines left empty when the editing ends are dropped. */
export function withoutEmptySegments(edits: SegmentEdits): SegmentEdits {
  return { ...edits, segments: edits.segments.filter((segment) => segment.text.trim()) };
}

export function countWords(segments: TranscriptSegment[]) {
  return segments.reduce((total, segment) => total + (segment.text.match(/\S+/g)?.length ?? 0), 0);
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null);

/** Segments sent by a viewer, kept only when well formed; `speakers` is how many the transcript has. */
export function cleanSegments(value: unknown, speakers: number): TranscriptSegment[] | null {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return null;
  const segments: TranscriptSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { start, end, speaker, text } = entry as Partial<TranscriptSegment>;
    const from = finite(start);
    const to = finite(end);
    if (from === null || to === null || typeof text !== "string") return null;
    const clean = cleanLineText(text);
    if (!clean) continue;
    segments.push({
      start: round(from),
      end: round(Math.max(from, to)),
      speaker: Number.isInteger(speaker) && (speaker as number) >= 0 && (speaker as number) < speakers ? speaker as number : null,
      text: clean,
    });
  }
  return segments;
}

/** Edits sent by the recorder for a live transcript of `transcribed` segments so far. */
export function cleanSegmentEdits(value: unknown, transcribed: number): SegmentEdits | null {
  if (!value || typeof value !== "object") return null;
  const { basedOn, segments } = value as Partial<SegmentEdits>;
  const clean = cleanSegments(segments, 0);
  if (!clean || !Number.isInteger(basedOn) || (basedOn as number) < 0) return null;
  return { basedOn: Math.min(basedOn as number, transcribed), segments: clean };
}
