export type TextMatch = { start: number; end: number };

export type TextFindOptions = {
  wildcards?: boolean;
};

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Dynamic programming avoids regex backtracking. Each cell records the
// furthest matching end for one pattern suffix and one Unicode input offset.
// Work is O(input code points × pattern code points), with O(input) memory.
function findWildcardMatches(value: string, query: string): TextMatch[] {
  const tokens: ("*" | "?" | RegExp)[] = [];
  const pattern = Array.from(query);
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && ["*", "?", "\\"].includes(pattern[i + 1])) {
      tokens.push(new RegExp(`^${escapeRegularExpression(pattern[++i])}$`, "iu"));
    } else if (char === "*") {
      if (tokens.at(-1) !== "*") tokens.push("*");
    } else if (char === "?") tokens.push("?");
    else tokens.push(new RegExp(`^${escapeRegularExpression(char)}$`, "iu"));
  }
  const chars = Array.from(value);
  const offsets = new Int32Array(chars.length + 1);
  let next = new Int32Array(chars.length + 1);
  let row = new Int32Array(chars.length + 1);
  for (let i = 0; i <= chars.length; i++) {
    next[i] = i;
    if (i < chars.length) offsets[i + 1] = offsets[i] + chars[i].length;
  }
  for (const token of tokens.toReversed()) {
    row.fill(-1);
    if (token === "*") row[chars.length] = next[chars.length];
    for (let i = chars.length - 1; i >= 0; i--) {
      const canConsume = chars[i] !== "\r" && chars[i] !== "\n";
      if (token === "*") row[i] = Math.max(next[i], canConsume ? row[i + 1] : -1);
      else if (token === "?" ? canConsume : token.test(chars[i])) row[i] = next[i + 1];
    }
    [next, row] = [row, next];
  }
  const matches: TextMatch[] = [];
  for (let i = 0; i < chars.length;) {
    const end = next[i];
    if (end > i) { matches.push({ start: offsets[i], end: offsets[end] }); i = end; }
    else i++;
  }
  return matches;
}

export function findTextMatches(
  value: string,
  query: string,
  { wildcards = false }: TextFindOptions = {},
): TextMatch[] {
  if (!query) return [];

  if (wildcards) return findWildcardMatches(value, query);

  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedValue = value.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let searchFrom = 0;

  while (searchFrom <= normalizedValue.length) {
    const start = normalizedValue.indexOf(normalizedQuery, searchFrom);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    searchFrom = start + normalizedQuery.length;
  }

  return matches;
}

export function replaceTextMatches(value: string, matches: TextMatch[], replacement: string) {
  const parts: string[] = [];
  let offset = 0;
  for (const match of matches) {
    parts.push(value.slice(offset, match.start), replacement);
    offset = match.end;
  }
  parts.push(value.slice(offset));
  return parts.join("");
}
