const HYPHENS = /[-‐‑‒–—―−­]/;

function isLetter(character: string | undefined) {
  return !!character && /\p{L}/u.test(character);
}

/** Normalized text and, for each of its characters, the offset in the original it came from. */
export function normalizeForMatch(input: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let index = 0;
  while (index < input.length) {
    const code = input.codePointAt(index)!;
    const character = String.fromCodePoint(code);
    const size = character.length;
    if (character === "­") { index += size; continue; }
    // A word hyphenated across a line break: drop the hyphen and the break.
    if (HYPHENS.test(character) && isLetter(out.at(-1))) {
      let next = index + size;
      let newline = false;
      while (next < input.length && /\s/.test(input[next])) { if (input[next] === "\n") newline = true; next++; }
      if (newline && next < input.length && /\p{Ll}/u.test(input[next])) { index = next; continue; }
    }
    if (/\s/.test(character)) {
      if (out.length && out.at(-1) !== " ") { out.push(" "); map.push(index); }
      index += size;
      continue;
    }
    const normalized = character.normalize("NFKC").toLowerCase()
      .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″«»]/g, "\"").replace(/[‐‑‒–—―−]/g, "-");
    for (const part of normalized) {
      if (/\s/.test(part)) { if (out.length && out.at(-1) !== " ") { out.push(" "); map.push(index); } continue; }
      out.push(part);
      map.push(index);
    }
    index += size;
  }
  while (out.at(-1) === " ") { out.pop(); map.pop(); }
  return { text: out.join(""), map };
}
