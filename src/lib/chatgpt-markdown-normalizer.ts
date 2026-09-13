import { preferredMathMarkerPair, type MathMarkerSettings } from "./math-markers";

type Placeholder = {
  token: string;
  value: string;
};

const PLACEHOLDER_PREFIX = "\uE000LIBERA_CHATGPT_MD_";
const PLACEHOLDER_SUFFIX = "\uE001";

function createPlaceholder(placeholders: Placeholder[], value: string) {
  const token = `${PLACEHOLDER_PREFIX}${placeholders.length}${PLACEHOLDER_SUFFIX}`;
  placeholders.push({ token, value });
  return token;
}

function protectPattern(
  value: string,
  placeholders: Placeholder[],
  pattern: RegExp,
) {
  return value.replace(pattern, (match) => createPlaceholder(placeholders, match));
}

function protectMarkdownLinks(value: string, placeholders: Placeholder[]) {
  return value
    .replace(
      /!?\[[^\]\n]*\]\([^\s)]*(?:\([^\s)]*\)[^\s)]*)?(?:\s+"[^"]*")?\)/g,
      (match) => createPlaceholder(placeholders, match),
    )
    .replace(/!?\[[^\]\n]+\]\[[^\]\n]*\]/g, (match) =>
      createPlaceholder(placeholders, match),
    );
}

function protectNonTargets(value: string, placeholders: Placeholder[]) {
  let protectedValue = value;

  protectedValue = protectPattern(
    protectedValue,
    placeholders,
    /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g,
  );
  protectedValue = protectPattern(
    protectedValue,
    placeholders,
    /(^|\n)[ \t]*\$\$[\s\S]*?\n[ \t]*\$\$[ \t]*(?=\n|$)/g,
  );
  protectedValue = protectPattern(
    protectedValue,
    placeholders,
    /(?<!\\)\$(?!\$)(?:\\.|[^\n$])+(?<!\\)\$/g,
  );
  protectedValue = protectPattern(protectedValue, placeholders, /`[^`\n]+`/g);
  protectedValue = protectMarkdownLinks(protectedValue, placeholders);
  protectedValue = protectPattern(
    protectedValue,
    placeholders,
    /https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/g,
  );

  return protectedValue;
}

function restorePlaceholders(value: string, placeholders: Placeholder[]) {
  let restored = value;

  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const placeholder = placeholders[index];
    restored = restored.split(placeholder.token).join(placeholder.value);
  }

  return restored;
}

// ChatGPT's source already contains LaTeX. Only translate its explicit math
// delimiters to the configured canonical delimiters understood by both editors.
export function normalizeChatGptCopiedMarkdown(
  value: string,
  mathMarkers: MathMarkerSettings = {},
) {
  const placeholders: Placeholder[] = [];
  const protectedValue = protectNonTargets(value, placeholders);
  const inlinePair = preferredMathMarkerPair(mathMarkers, false);
  const displayPair = preferredMathMarkerPair(mathMarkers, true);
  const normalized = protectedValue.replace(
    /(?<!\\)\\\[([\s\S]*?)\\\]|(?<!\\)\\\(([^\n]*?)\\\)/g,
    (match, display: string | undefined, inline: string | undefined, offset: number) => {
      if (display !== undefined) {
        if (!displayPair) return match;
        const before = protectedValue.slice(0, offset);
        const after = protectedValue.slice(offset + match.length);
        const leadingBreak = before && !/(?:^|\n)[ \t]*$/.test(before) ? "\n\n" : "";
        const trailingBreak = after && !/^[ \t]*(?:\r?\n|$)/.test(after) ? "\n\n" : "";
        return `${leadingBreak}${displayPair.open}\n${display.trim()}\n${displayPair.close}${trailingBreak}`;
      }
      return inlinePair
        ? `${inlinePair.open}${inline!.trim()}${inlinePair.close}`
        : match;
    },
  );

  return restorePlaceholders(normalized, placeholders);
}
