import katex from "katex";

type Placeholder = {
  token: string;
  value: string;
};

const PLACEHOLDER_PREFIX = "\uE000LIBERA_CHATGPT_MD_";
const PLACEHOLDER_SUFFIX = "\uE001";
const MAX_INLINE_MATH_LENGTH = 240;

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
  protectedValue = protectPattern(protectedValue, placeholders, /\\\[[\s\S]*?\\\]/g);
  protectedValue = protectPattern(
    protectedValue,
    placeholders,
    /(?<!\\)\$(?!\$)(?:\\.|[^\n$])+(?<!\\)\$/g,
  );
  protectedValue = protectPattern(protectedValue, placeholders, /\\\([\s\S]*?\\\)/g);
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

function normalizeDisplayMathContent(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (/={2,}/.test(trimmed) && /^=+$/.test(trimmed)) {
        return "=";
      }

      if (/-{3,}/.test(trimmed) && /^-+$/.test(trimmed)) {
        return "-";
      }

      return line.trimEnd();
    })
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}

function normalizeInlineMathContent(value: string) {
  return value.trim().replace(/\s*\n\s*/g, " ");
}

function isValidKatex(value: string, displayMode: boolean) {
  try {
    katex.renderToString(value, {
      displayMode,
      throwOnError: true,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeDisplayMath(value: string, mathBlocks: string[]) {
  return value.replace(
    /(^|\n)([ \t]*)\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g,
    (match, prefix: string, indent: string, equation: string) => {
      const normalizedEquation = normalizeDisplayMathContent(equation);

      if (
        !normalizedEquation ||
        !isValidKatex(normalizedEquation, true)
      ) {
        return match;
      }

      mathBlocks.push(normalizedEquation);

      return `${prefix}${indent}$$\n${normalizedEquation}\n${indent}$$`;
    },
  );
}

function collectMathSymbols(mathBlocks: string[]) {
  const symbols = new Set<string>();

  for (const block of mathBlocks) {
    for (const match of block.matchAll(/[A-Za-z](?:[_^](?:\{?[A-Za-z0-9]+\}?))*/g)) {
      const token = match[0];
      symbols.add(token.replace(/[{}]/g, ""));
      symbols.add(token[0]);
    }
  }

  return symbols;
}

function hasStrongLatexSignal(value: string) {
  return (
    /\\[A-Za-z]+/.test(value) ||
    /[_^](?:\{[^}]+\}|[A-Za-z0-9]+)/.test(value) ||
    /\\(?:leq?|geq?|neq|in|notin|subset|sum|int|prod|lim|to|rightarrow|leftarrow|cdot|times|dots|ldots|alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|infty)\b/.test(
      value,
    )
  );
}

function isContextualSymbol(value: string, mathSymbols: Set<string>) {
  const normalized = value.replace(/[{}]/g, "");

  return (
    /^[A-Za-z](?:[_^][A-Za-z0-9]+)?$/.test(normalized) &&
    mathSymbols.has(normalized)
  );
}

function shouldConvertInlineMath(value: string, mathSymbols: Set<string>) {
  const normalized = normalizeInlineMathContent(value);

  if (
    !normalized ||
    normalized.length > MAX_INLINE_MATH_LENGTH ||
    /\n\s*\n/.test(value)
  ) {
    return false;
  }

  if (!hasStrongLatexSignal(normalized) && !isContextualSymbol(normalized, mathSymbols)) {
    return false;
  }

  return isValidKatex(normalized, false);
}

function findMatchingParen(value: string, start: number) {
  let depth = 0;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function normalizeInlineMath(value: string, mathSymbols: Set<string>): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "(") {
      result += value[index];
      index += 1;
      continue;
    }

    const closeIndex = findMatchingParen(value, index);

    if (closeIndex < 0) {
      result += value[index];
      index += 1;
      continue;
    }

    const content = value.slice(index + 1, closeIndex);

    if (shouldConvertInlineMath(content, mathSymbols)) {
      result += `$${normalizeInlineMathContent(content)}$`;
    } else {
      result += `(${normalizeInlineMath(content, mathSymbols)})`;
    }

    index = closeIndex + 1;
  }

  return result;
}

export function normalizeChatGptCopiedMarkdown(value: string) {
  const placeholders: Placeholder[] = [];
  const mathBlocks: string[] = [];
  let normalized = protectNonTargets(value, placeholders);

  normalized = normalizeDisplayMath(normalized, mathBlocks);
  normalized = protectPattern(
    normalized,
    placeholders,
    /(^|\n)[ \t]*\$\$[\s\S]*?\n[ \t]*\$\$[ \t]*(?=\n|$)/g,
  );
  normalized = normalizeInlineMath(normalized, collectMathSymbols(mathBlocks));

  return restorePlaceholders(normalized, placeholders);
}
