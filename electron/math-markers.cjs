const DEFAULT_INLINE_MATH_MARKERS = '$ $\n$$ $$\n\\( \\)';
const DEFAULT_BLOCK_MATH_MARKERS = '\\[ \\]';
function normalizeMathMarkers(value, fallback) {
  if (typeof value !== 'string') return fallback;
  if (value.length > 4096) throw new Error('Math markers must be at most 4096 characters.');
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const pair = line.split(/\s+/);
    if (pair.length !== 2 || pair.some(marker => marker.length > 32 || /[\w`\u0000-\u001f]/.test(marker))) {
      throw new Error('Math markers: enter two punctuation-only markers separated by a space on each line (maximum 32 characters per marker; no backticks).');
    }
    if (seen.has(pair[0])) throw new Error('Each opening math marker must be unique.');
    seen.add(pair[0]);
  }
  return lines.map(line => line.split(/\s+/).join(' ')).join('\n');
}
module.exports = { DEFAULT_INLINE_MATH_MARKERS, DEFAULT_BLOCK_MATH_MARKERS, normalizeMathMarkers };
