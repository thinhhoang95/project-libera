import { DEFAULT_INLINE_MATH_MARKERS, DEFAULT_BLOCK_MATH_MARKERS } from '../../electron/math-markers.cjs';
export type MathMarkerSettings = { inlineMathMarkers?: string; blockMathMarkers?: string };
export type MathMarkerPair = { open: string; close: string; display: boolean };

function configuredMathMarkerPairs(settings: MathMarkerSettings = {}): MathMarkerPair[] {
  return [[settings.inlineMathMarkers ?? DEFAULT_INLINE_MATH_MARKERS, false], [settings.blockMathMarkers ?? DEFAULT_BLOCK_MATH_MARKERS, true]].flatMap(([text, display]) =>
    String(text).split('\n').filter(Boolean).map(line => { const [open, close] = line.trim().split(/\s+/); return { open, close, display: Boolean(display) }; })
  );
}

/** The first configured pair is the canonical pair for newly generated Markdown. */
export function preferredMathMarkerPair(settings: MathMarkerSettings = {}, display: boolean) {
  return configuredMathMarkerPairs(settings).find(pair => pair.display === display);
}

export function mathMarkerPairs(settings: MathMarkerSettings = {}): MathMarkerPair[] {
  // Parsing still checks longer openers first so `$` cannot steal `$$`.
  return configuredMathMarkerPairs(settings).sort((a, b) => b.open.length - a.open.length);
}

function promptPair(pair: MathMarkerPair) {
  return `\`${pair.open}\` … \`${pair.close}\``;
}

/** Keep generated chat Markdown inside the exact math syntax accepted by the editors. */
export function mathMarkerSystemInstruction(settings: MathMarkerSettings = {}) {
  const pairs = configuredMathMarkerPairs(settings);
  const inlinePairs = pairs.filter(pair => !pair.display);
  const displayPairs = pairs.filter(pair => pair.display);
  const preferredInline = inlinePairs[0];
  const preferredDisplay = displayPairs[0];
  const instructions = [
    "When a response contains mathematics, use only Libera's configured equation markers so the Markdown can be pasted directly into the WYSIWYG and Source editors.",
  ];

  instructions.push(preferredInline
    ? `Configured inline pairs: ${inlinePairs.map(promptPair).join(", ")}. For new inline equations, wrap the LaTeX with ${promptPair(preferredInline)} on the same line.`
    : "Inline equation markers are disabled; do not emit inline equation delimiters.");
  instructions.push(preferredDisplay
    ? `Configured display pairs: ${displayPairs.map(promptPair).join(", ")}. For new display equations, put ${promptPair(preferredDisplay)} and the LaTeX on three separate lines, with each marker on its own line.`
    : "Display equation markers are disabled; do not emit display equation delimiters.");
  instructions.push("Do not substitute any other math delimiter pair.");

  return instructions.join(" ");
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
