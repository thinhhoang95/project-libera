export type QuoteMatch = { ratio: number; start: number; end: number };

/**
 * The best approximate occurrence of `needle` in `haystack` (both already
 * normalized): Sellers' algorithm, edit distance against any substring.
 * Offsets are in `haystack`.
 */
export function approximateMatch(needle: string, haystack: string): QuoteMatch | null {
  const m = needle.length;
  if (!m || !haystack.length) return null;
  let previous = new Int32Array(m + 1);
  let previousStart = new Int32Array(m + 1);
  let current = new Int32Array(m + 1);
  let currentStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) { previous[i] = i; previousStart[i] = 0; }
  let best = { distance: previous[m], end: 0, start: 0 };
  for (let j = 1; j <= haystack.length; j++) {
    current[0] = 0;
    currentStart[0] = j;
    const character = haystack[j - 1];
    for (let i = 1; i <= m; i++) {
      const substitute = previous[i - 1] + (needle[i - 1] === character ? 0 : 1);
      const skipNeedle = current[i - 1] + 1;
      const skipHaystack = previous[i] + 1;
      if (substitute <= skipNeedle && substitute <= skipHaystack) { current[i] = substitute; currentStart[i] = previousStart[i - 1]; }
      else if (skipNeedle <= skipHaystack) { current[i] = skipNeedle; currentStart[i] = currentStart[i - 1]; }
      else { current[i] = skipHaystack; currentStart[i] = previousStart[i]; }
    }
    if (current[m] < best.distance) best = { distance: current[m], end: j, start: currentStart[m] };
    [previous, current] = [current, previous];
    [previousStart, currentStart] = [currentStart, previousStart];
  }
  return { ratio: 1 - best.distance / m, start: best.start, end: best.end };
}
