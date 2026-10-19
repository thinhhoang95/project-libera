// A small glob matcher for the agent's Glob and Grep tools. Supports `**`,
// `*`, `?`, `[...]` and `{a,b}`, matched case-insensitively against
// "/"-separated paths. A pattern without "/" matches file names at any depth,
// like ripgrep's --glob.

function escapeRegex(character: string) {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

function translate(pattern: string): string {
  let output = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const atSegmentStart = index === 0 || pattern[index - 1] === "/";
        const atSegmentEnd = index + 2 === pattern.length || pattern[index + 2] === "/";
        if (atSegmentStart && atSegmentEnd) {
          // "**/" matches zero or more whole segments; a trailing "**" matches the rest.
          if (pattern[index + 2] === "/") { output += "(?:[^/]*/)*"; index += 3; }
          else { output += ".*"; index += 2; }
          continue;
        }
        output += "[^/]*";
        index += 2;
        continue;
      }
      output += "[^/]*";
      index++;
      continue;
    }
    if (character === "?") { output += "[^/]"; index++; continue; }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close > index) {
        let body = pattern.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        output += `[${body.replace(/\\/g, "\\\\")}]`;
        index = close + 1;
        continue;
      }
    }
    if (character === "{") {
      let depth = 0;
      let close = -1;
      for (let cursor = index; cursor < pattern.length; cursor++) {
        if (pattern[cursor] === "{") depth++;
        else if (pattern[cursor] === "}" && --depth === 0) { close = cursor; break; }
      }
      if (close > index) {
        const alternatives: string[] = [];
        let start = index + 1;
        depth = 0;
        for (let cursor = index + 1; cursor < close; cursor++) {
          if (pattern[cursor] === "{") depth++;
          else if (pattern[cursor] === "}") depth--;
          else if (pattern[cursor] === "," && depth === 0) { alternatives.push(pattern.slice(start, cursor)); start = cursor + 1; }
        }
        alternatives.push(pattern.slice(start, close));
        output += `(?:${alternatives.map(translate).join("|")})`;
        index = close + 1;
        continue;
      }
    }
    output += escapeRegex(character);
    index++;
  }
  return output;
}

export function globToRegExp(pattern: string) {
  let normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized) normalized = "**";
  if (!normalized.includes("/")) normalized = `**/${normalized}`;
  return new RegExp(`^${translate(normalized)}$`, "i");
}

export function matchesGlob(relativePath: string, pattern: string | RegExp) {
  return (typeof pattern === "string" ? globToRegExp(pattern) : pattern).test(relativePath);
}
