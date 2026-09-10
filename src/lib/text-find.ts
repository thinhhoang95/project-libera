export type TextMatch = { start: number; end: number };

export type TextFindOptions = {
  wildcards?: boolean;
};

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardRegularExpression(query: string) {
  let pattern = "";

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    const escapedCharacter = query[index + 1];

    if (character === "\\" && escapedCharacter && ["*", "?", "\\"].includes(escapedCharacter)) {
      pattern += escapeRegularExpression(escapedCharacter);
      index += 1;
    } else if (character === "*") {
      pattern += "[^\\r\\n]*";
      while (query[index + 1] === "*") index += 1;
    } else if (character === "?") {
      pattern += "[^\\r\\n]";
    } else {
      pattern += escapeRegularExpression(character);
    }
  }

  return pattern;
}

export function findTextMatches(
  value: string,
  query: string,
  { wildcards = false }: TextFindOptions = {},
): TextMatch[] {
  if (!query) return [];

  if (wildcards) {
    const expression = new RegExp(wildcardRegularExpression(query), "giu");
    return Array.from(value.matchAll(expression), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })).filter((match) => match.end > match.start);
  }

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
  let result = value;
  for (const match of matches.toReversed()) {
    result = `${result.slice(0, match.start)}${replacement}${result.slice(match.end)}`;
  }
  return result;
}
