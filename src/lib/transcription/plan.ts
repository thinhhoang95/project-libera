import type { TranscriptDiarization, TranscriptSegment, TranscriptSpeaker } from "@/lib/transcription/types";

// The transcription pipeline's arithmetic, kept free of I/O so it can be tested.
//
// Recognition and diarization run independently over the same timeline:
// pyannote says who speaks when (turns), the recognizer says which words are
// spoken when, and every word then takes the speaker whose turn it overlaps
// most. A long recording is recognized in pieces cut at its quietest moments,
// so no word is split between pieces and the pieces need no overlap: their
// words simply follow one another.

export type Span = { start: number; end: number };
/** A pyannote turn. Speaker ids are arbitrary until renumbered by `orderSpeakers`. */
export type SpeakerTurn = Span & { speaker: number };
export type TimedWord = Span & { text: string; speaker?: number | null };

/** RMS loudness of the recording in frames of `frameSeconds`. */
export type LoudnessEnvelope = { frameSeconds: number; values: Float32Array | number[] };

/**
 * Where speech is: the turns, padded a little so word edges are not clipped,
 * and joined across short pauses. Without diarization, the whole recording.
 */
export function speechRegions(turns: SpeakerTurn[], duration: number, { padding = 0.25, joinGap = 1 } = {}): Span[] {
  if (!turns.length) return duration > 0 ? [{ start: 0, end: duration }] : [];
  const sorted = [...turns].sort((left, right) => left.start - right.start);
  const regions: Span[] = [];
  for (const turn of sorted) {
    const start = Math.max(0, turn.start - padding);
    const end = Math.min(duration, turn.end + padding);
    if (end <= start) continue;
    const last = regions.at(-1);
    if (last && start - last.end <= joinGap) last.end = Math.max(last.end, end);
    else regions.push({ start, end });
  }
  return regions;
}

/** The quietest moment between `from` and `to`, by the loudness envelope. */
export function quietestPoint(envelope: LoudnessEnvelope, from: number, to: number) {
  const { frameSeconds, values } = envelope;
  const first = Math.max(0, Math.floor(from / frameSeconds));
  const last = Math.min(values.length - 1, Math.ceil(to / frameSeconds));
  if (last < first) return (from + to) / 2;
  // A few frames together, so a single silent frame inside a word does not win.
  let best = first;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (let frame = first; frame <= last; frame += 1) {
    const level = (values[frame - 1] ?? values[frame]) + values[frame] * 2 + (values[frame + 1] ?? values[frame]);
    if (level < bestLevel) {
      bestLevel = level;
      best = frame;
    }
  }
  return Math.min(to, Math.max(from, (best + 0.5) * frameSeconds));
}

/**
 * Pieces of at most `maxSeconds` to recognize one at a time. Speech regions
 * close together are packed into one piece (fewer requests, more context for
 * the model); a region longer than a piece is cut at its quietest moment in
 * the last third of each window.
 */
export function planPieces(regions: Span[], envelope: LoudnessEnvelope, { maxSeconds, packGap }: { maxSeconds: number; packGap: number }): Span[] {
  const packed: Span[] = [];
  for (const region of regions) {
    const last = packed.at(-1);
    if (last && region.start - last.end <= packGap && region.end - last.start <= maxSeconds) last.end = region.end;
    else packed.push({ ...region });
  }

  const pieces: Span[] = [];
  for (const span of packed) {
    let start = span.start;
    while (span.end - start > maxSeconds) {
      const cut = quietestPoint(envelope, start + maxSeconds * 0.66, start + maxSeconds);
      pieces.push({ start, end: cut });
      start = cut;
    }
    if (span.end - start > 0.05) pieces.push({ start, end: span.end });
  }
  return pieces;
}

const WORD_START = /^[\s▁]/;

/**
 * Words from a transducer's tokens (sherpa-onnx): a token starting with a space
 * (or SentencePiece's ▁) starts a word. Token times are relative to the piece.
 */
export function wordsFromTokens(tokens: string[], timestamps: number[], offset: number, pieceEnd: number, durations?: number[]): TimedWord[] {
  const words: TimedWord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const start = offset + (timestamps[index] ?? 0);
    const tokenEnd = durations?.[index] ? start + durations[index] : offset + (timestamps[index + 1] ?? pieceEnd - offset);
    const end = Math.min(pieceEnd, Math.max(start, tokenEnd));
    const last = words.at(-1);
    if (last && !WORD_START.test(token)) {
      last.text += token;
      last.end = Math.max(last.end, end);
    } else {
      const text = token.replace(/^[\s▁]+/, "");
      if (text) words.push({ start, end, text });
    }
  }
  return words.filter((word) => word.text.trim());
}

/**
 * Words when a service returns only timed segments: each segment's words share
 * its time in proportion to their length. Good enough to attribute speakers.
 */
export function wordsFromSegments(segments: Array<Span & { text: string }>, offset: number): TimedWord[] {
  const words: TimedWord[] = [];
  for (const segment of segments) {
    const parts = segment.text.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
    const span = Math.max(0, segment.end - segment.start);
    let position = segment.start;
    for (const part of parts) {
      const length = span * ((part.length + 1) / total);
      words.push({ start: offset + position, end: offset + position + length, text: part });
      position += length;
    }
  }
  return words;
}

/** Each word takes the speaker whose turn overlaps it most, or the nearest turn within a second. */
export function assignSpeakers(words: TimedWord[], turns: SpeakerTurn[]): TimedWord[] {
  if (!turns.length) return words.map((word) => ({ ...word, speaker: null }));
  const sorted = [...turns].sort((left, right) => left.start - right.start);
  // The latest end among each turn and those before it: scanning back from the
  // last turn that starts near a word can stop once nothing earlier reaches it.
  const reach: number[] = [];
  for (const [index, turn] of sorted.entries()) reach.push(Math.max(turn.end, reach[index - 1] ?? 0));
  return words.map((word) => {
    let best: number | null = null;
    let bestOverlap = 0;
    let nearest: number | null = null;
    let nearestDistance = 1;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle].start <= word.end + 1) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0 && reach[index] >= word.start - 1; index -= 1) {
      const turn = sorted[index];
      const overlap = Math.min(turn.end, word.end) - Math.max(turn.start, word.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = turn.speaker;
      }
      const distance = Math.max(0, turn.start - word.end, word.start - turn.end);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = turn.speaker;
      }
    }
    return { ...word, speaker: best ?? nearest };
  });
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;

function joinWords(left: string, right: string) {
  if (!left) return right;
  // Scripts written without spaces, and punctuation a service returned as its own word.
  if ((CJK.test(left.at(-1)!) && CJK.test(right[0])) || /^[,.;:!?…%)\]}»”’]/.test(right)) return left + right;
  return `${left} ${right}`;
}

/**
 * Transcript segments: a new one starts when the speaker changes, after a
 * pause, or at a sentence end once a segment runs long, so each stays short
 * enough to follow while it plays and to seek to.
 */
export function groupSegments(words: TimedWord[], { pauseSeconds = 1.5, softMaxSeconds = 25, hardMaxSeconds = 45 } = {}): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  let previous: TimedWord | null = null;
  for (const word of words) {
    const speaker = word.speaker ?? null;
    const length = current ? word.end - current.start : 0;
    const startNew = !current
      || speaker !== current.speaker
      || (previous && word.start - previous.end > pauseSeconds)
      || (length > softMaxSeconds && previous && SENTENCE_END.test(previous.text))
      || length > hardMaxSeconds;
    if (startNew) {
      if (current) segments.push(current);
      current = { start: word.start, end: word.end, speaker, text: word.text };
    } else {
      current!.text = joinWords(current!.text, word.text);
      current!.end = Math.max(current!.end, word.end);
    }
    previous = word;
  }
  if (current) segments.push(current);
  return segments.map((segment) => ({ ...segment, start: round(segment.start), end: round(segment.end), text: segment.text.trim() }));
}

function round(seconds: number) {
  return Math.round(seconds * 100) / 100;
}

/**
 * Speakers numbered in the order they first speak, so "Speaker 1" opens the
 * recording, with what diarization measured about each. Segments and turns
 * are returned with the new numbers.
 */
export function orderSpeakers(segments: TranscriptSegment[], turns: SpeakerTurn[]) {
  const order = new Map<number, number>();
  for (const turn of [...turns].sort((left, right) => left.start - right.start)) {
    if (!order.has(turn.speaker)) order.set(turn.speaker, order.size);
  }
  for (const segment of segments) {
    if (segment.speaker !== null && !order.has(segment.speaker)) order.set(segment.speaker, order.size);
  }
  const renumbered = segments.map((segment) => ({ ...segment, speaker: segment.speaker === null ? null : order.get(segment.speaker)! }));
  const renumberedTurns = turns.map((turn) => ({ ...turn, speaker: order.get(turn.speaker)! }));
  const talk = new Array<number>(order.size).fill(0);
  for (const turn of renumberedTurns) talk[turn.speaker] += Math.max(0, turn.end - turn.start);
  const counts = new Array<number>(order.size).fill(0);
  for (const segment of renumbered) if (segment.speaker !== null) counts[segment.speaker] += 1;
  const totalTalk = talk.reduce((sum, value) => sum + value, 0);
  const speakers: TranscriptSpeaker[] = talk.map((seconds, index) => ({
    name: `Speaker ${index + 1}`,
    talkSeconds: round(seconds),
    share: totalTalk ? Math.round((seconds / totalTalk) * 1000) / 1000 : 0,
    segments: counts[index],
  }));
  return { segments: renumbered, turns: renumberedTurns, speakers };
}

/** Seconds of speech, and of speech where two or more turns overlap. */
export function speechCoverage(turns: SpeakerTurn[]) {
  const events = turns.flatMap((turn) => [{ time: turn.start, delta: 1 }, { time: turn.end, delta: -1 }])
    .sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let last = 0;
  let speech = 0;
  let overlap = 0;
  for (const event of events) {
    const span = event.time - last;
    if (active >= 1) speech += span;
    if (active >= 2) overlap += span;
    active += event.delta;
    last = event.time;
  }
  return { speechSeconds: round(speech), overlapSeconds: round(overlap) };
}

export function diarizationSummary(turns: SpeakerTurn[], speakerCount: number, requestedSpeakers: number, models: { segmentation: string; embedding: string }): TranscriptDiarization {
  return {
    segmentationModel: models.segmentation,
    embeddingModel: models.embedding,
    speakerCount,
    requestedSpeakers,
    turns: turns.length,
    ...speechCoverage(turns),
  };
}

/** Pyannote can report the same speaker in back-to-back turns; join them. */
export function joinTurns(turns: SpeakerTurn[], gap = 0.3): SpeakerTurn[] {
  const sorted = [...turns].filter((turn) => turn.end > turn.start).sort((left, right) => left.start - right.start);
  const joined: SpeakerTurn[] = [];
  for (const turn of sorted) {
    const last = joined.at(-1);
    if (last?.speaker === turn.speaker && turn.start - last.end <= gap) last.end = Math.max(last.end, turn.end);
    else joined.push({ ...turn });
  }
  return joined;
}
