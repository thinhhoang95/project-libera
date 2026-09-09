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
// delimiters to the dollar delimiters understood by the Markdown editors.
export function normalizeChatGptCopiedMarkdown(value: string) {
  const placeholders: Placeholder[] = [];
  const protectedValue = protectNonTargets(value, placeholders);
  const normalized = protectedValue.replace(
    /(?<!\\)\\\[([\s\S]*?)\\\]|(?<!\\)\\\(([^\n]*?)\\\)/g,
    (_match, display: string | undefined, inline: string | undefined) =>
      display !== undefined
        ? `$$\n${display.trim()}\n$$`
        : `$${inline!.trim()}$`,
  );

  return restorePlaceholders(normalized, placeholders);
}
