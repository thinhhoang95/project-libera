import { DEFAULT_INLINE_MATH_MARKERS, DEFAULT_BLOCK_MATH_MARKERS } from '../../electron/math-markers.cjs';
export type MathMarkerSettings = { inlineMathMarkers?: string; blockMathMarkers?: string };
export type MathMarkerPair = { open: string; close: string; display: boolean };
export function mathMarkerPairs(settings: MathMarkerSettings = {}): MathMarkerPair[] {
  return [[settings.inlineMathMarkers ?? DEFAULT_INLINE_MATH_MARKERS, false], [settings.blockMathMarkers ?? DEFAULT_BLOCK_MATH_MARKERS, true]].flatMap(([text, display]) =>
    String(text).split('\n').filter(Boolean).map(line => { const [open, close] = line.trim().split(/\s+/); return { open, close, display: Boolean(display) }; })
  ).sort((a, b) => b.open.length - a.open.length);
}
export function escapedAt(source: string, index: number) {
  let backslashes = 0;
  while (index > 0 && source[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}
export function matchMath(source: string, pairs: MathMarkerPair[], display: boolean) {
  const pair = pairs.find(pair => source.startsWith(pair.open));
  if (!pair || pair.display !== display) return;
  let end = pair.open.length;
  while ((end = source.indexOf(pair.close, end)) >= 0) {
    if (escapedAt(source, end)) { end += pair.close.length; continue; }
    const latex = source.slice(pair.open.length, end);
    if (!latex.trim() || (!display && /[\r\n]/.test(latex))) return;
    const length = end + pair.close.length;
    if (display && !/^[ \t]*(?:\r?\n|$)/.test(source.slice(length))) return;
    return { raw: source.slice(0, length), latex: latex.trim(), open: pair.open, close: pair.close };
  }
}
