// Maps a section of an old text (a revision) onto the current text by its
// surrounding context, for restoring one section (M2.5). The section itself
// may have changed completely since, which is why it is restored, so it is
// found by the text just before and just after it, not by its own content.

/** Context lengths tried, longest first; a longer match is more trustworthy. */
const CONTEXT_LENGTHS = [64, 32, 16, 8, 4];
/** Bound on occurrences examined per context, so pathological texts stay cheap. */
const MAX_OCCURRENCES = 1000;

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length < MAX_OCCURRENCES) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + 1;
  }
  return found;
}

/**
 * Where the text before the section ends in `current`, for each place the
 * longest available context occurs; [0] when the section starts the text.
 */
function sectionStarts(old: string, start: number, current: string): number[] {
  if (start === 0) return [0];
  for (const length of CONTEXT_LENGTHS) {
    const context = old.slice(Math.max(0, start - length), start);
    const found = occurrences(current, context).map((index) => index + context.length);
    if (found.length > 0) return found;
  }
  return [];
}

/** Where the text after the section starts in `current`; [length] when it ends the text. */
function sectionEnds(old: string, end: number, current: string): number[] {
  if (end === old.length) return [current.length];
  for (const length of CONTEXT_LENGTHS) {
    const context = old.slice(end, end + length);
    const found = occurrences(current, context);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * The range of `current` that corresponds to old[start, end), or null when
 * the context on either side cannot be found in order. When the context
 * occurs several times, the pair closest to the section's proportional
 * position (and of the most similar length) wins.
 */
export function locateSection(old: string, start: number, end: number, current: string): { start: number; end: number } | null {
  const starts = sectionStarts(old, start, current);
  const ends = sectionEnds(old, end, current);
  if (starts.length === 0 || ends.length === 0) return null;
  const scale = old.length === 0 ? 1 : current.length / old.length;
  const expectedStart = start * scale;
  const length = end - start;
  let best: { start: number; end: number; score: number } | null = null;
  for (const from of starts) {
    // The nearest end at or after this start: a later one would swallow text.
    const to = ends.find((candidate) => candidate >= from);
    if (to === undefined) continue;
    const score = Math.abs(from - expectedStart) + Math.abs(to - from - length);
    if (!best || score < best.score) best = { start: from, end: to, score };
  }
  return best ? { start: best.start, end: best.end } : null;
}
