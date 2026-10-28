import type { Plugin } from "unified";
import type { Root } from "mdast";
import { MARKDOWN_BOX_SHORTCUTS } from "./markdown-boxes";
import { escapedAt, mathMarkerPairs, matchMath, preferredMathMarkerPair, type MathMarkerPair, type MathMarkerSettings } from "./math-markers";

/**
 * Markdown macros (docs/features/markdown-macros.md). A ```libera-macro block
 * defines macros for its whole document, LaTeX style:
 *
 *     \fset = $\mathcal{F}$
 *     \newcommand{\theorem}[2]{**Theorem \counter-theorem (#1).** *#2*}
 *
 * A macro whose body is wrapped in math markers is a math macro: inside math
 * its LaTeX is substituted, outside math it is written as inline (or, alone on
 * its line, display) math. Any other macro is Markdown text, expanded outside
 * math only. `\counter-name` needs no definition: each use is the next number
 * of that counter, in document order. Expansion happens when the document is
 * rendered; the file keeps the macros as written.
 */
export const MACRO_BLOCK_LANGUAGE = "libera-macro";

/**
 * What the AI chat and agent are told about macros (a constant, so system
 * prompts stay byte-identical for provider prompt caches).
 */
export const MARKDOWN_MACROS_INSTRUCTION = "A Markdown note may define macros in a ```libera-macro block, LaTeX style: `\\name = $LaTeX$` is a math macro, `\\name = text` and `\\newcommand{\\name}[2]{Markdown with #1 and #2}` are text macros, and `\\counter-name` (no definition needed) numbers itself in document order. Libera expands a note's macros when it is shown, and expands the macros of the documents in this conversation in your replies, so you may use them as the note does: `\\name` or `$\\name$` for a math macro, `\\name{…}{…}` for one with arguments. When you edit a note, keep its macros and macro blocks as written and use its macros for new text where they fit; do not expand them unless the user asks.";

export type MarkdownMacro = {
  name: string;
  /** Number of `{…}` arguments, `#1` … `#9` in the body (`##` is a literal `#`). */
  arity: number;
  /** Markdown, or LaTeX for a math macro. */
  body: string;
  math: false | "inline" | "display";
  /** 1-based line of the definition in its block. */
  line: number;
};
export type MacroDefinitionError = { line: number; message: string };
export type MarkdownMacroDefinitions = { macros: Map<string, MarkdownMacro>; errors: MacroDefinitionError[] };
/** Definitions and counters carried into a part of a document (a slide), so it expands as the whole would. */
export type MarkdownMacroScope = { definitions: MarkdownMacroDefinitions; counters?: Record<string, number> };
export type MarkdownMacroOptions = { mathMarkers?: MathMarkerSettings; scope?: MarkdownMacroScope };

export type MarkdownMacroReplacement = {
  /** Source range replaced. */
  start: number;
  end: number;
  /** Where its text starts in the expanded Markdown. */
  outStart: number;
  text: string;
  kind: "macro" | "counter" | "math" | "block";
  /** The quote or list prefix the text's later lines were given, to take off where it renders inside that container. */
  prefix?: string;
};

const MAX_DEPTH = 16;
const COUNTER = /^\\counter-([A-Za-z][A-Za-z0-9_]*)/;
const REMARK_MATH_PAIRS: MathMarkerPair[] = [{ open: "$$", close: "$$", display: true }, { open: "$", close: "$", display: false }];
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/;
/** A quote's `>`, or a colored box's `b>`, at the start of a line. */
const QUOTE = `(?:[${MARKDOWN_BOX_SHORTCUTS}]>(?!>)|>)`;
const CONTAINER_PREFIX = new RegExp(`^(?:[ \\t]*(?:${QUOTE}[ \\t]?|(?:[-*+]|\\d{1,9}[.)])[ \\t]+))*`, "i");
/** A line's quote prefix, then its list item or heading marker. */
const LINE_MARKERS = new RegExp(`^([ \\t]*(?:${QUOTE}[ \\t]?)*)((?:(?:[-*+]|\\d{1,9}[.)])[ \\t]+(?:\\[[ xX]\\][ \\t]+)?|#{1,6}[ \\t]+)?)`, "i");
/** Inline Markdown that may wrap a parameter, `[color=#2563eb]#1[/color]` or `**#1**`: an opener before it and its closer. */
const WRAPPERS: Array<[RegExp, (open: string) => string]> = [
  [/\[color=#[0-9A-Fa-f]{3,8}\]$/, () => "[/color]"],
  [new RegExp(`[${MARKDOWN_BOX_SHORTCUTS}]?>>>$`, "i"), () => "<<<"],
  [/(?:\*\*|__|~~|==|\*|_)$/, (open) => open],
];
/**
 * `#1`…`#9` is a parameter and `##1` a literal `#1`, as in LaTeX (`##` before
 * anything else is Markdown, such as a heading). A hex color (`#2563eb`,
 * `#2563ebcc`) stays as written, so colors need no escaping.
 */
const PARAMETER = /##(?=[1-9])|#(?![0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?(?![0-9A-Za-z_]))([1-9])/g;

export function isMacroBlockLanguage(info: unknown) {
  return String(info ?? "").trim().split(/\s+/)[0] === MACRO_BLOCK_LANGUAGE;
}

export function emptyMacroDefinitions(): MarkdownMacroDefinitions {
  return { macros: new Map(), errors: [] };
}

/** Reads a `{…}` group at `index`; braces escaped with a backslash do not count. */
function readGroup(source: string, index: number) {
  if (source[index] !== "{") return null;
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { content: source.slice(index + 1, i), end: i + 1 };
  }
  return null;
}

function highestParameter(body: string) {
  let highest = 0;
  for (const match of body.matchAll(PARAMETER)) if (match[1]) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** A body wrapped in `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is LaTeX. */
function mathBody(body: string): { latex: string; display: boolean } | null {
  const text = body.trim();
  for (const [open, close, display] of [["$$", "$$", true], ["\\[", "\\]", true], ["$", "$", false], ["\\(", "\\)", false]] as const) {
    if (text.length <= open.length + close.length || !text.startsWith(open) || !text.endsWith(close)) continue;
    const latex = text.slice(open.length, -close.length);
    // `$a$ and $b$` is text with two formulas, not one math body.
    if (open === "$" && /(^|[^\\])\$/.test(latex)) return null;
    if (!latex.trim()) return null;
    return { latex: latex.trim(), display };
  }
  return null;
}

function defineMacro(definitions: MarkdownMacroDefinitions, name: string, body: string, declared: number | null, line: number) {
  const math = mathBody(body);
  const content = math ? math.latex : body.trim();
  const highest = highestParameter(content);
  const arity = declared ?? highest;
  if (highest > arity) {
    definitions.errors.push({ line, message: `\\${name} uses #${highest} but takes ${arity} argument${arity === 1 ? "" : "s"}` });
    return;
  }
  definitions.macros.set(name, { name, arity, body: content, math: math ? (math.display ? "display" : "inline") : false, line });
}

/**
 * Parses one macro block's text into `definitions` (later definitions win, as
 * with \renewcommand). Lines starting with `%` are comments.
 */
export function parseMacroDefinitions(source: string, definitions = emptyMacroDefinitions()) {
  let index = 0;
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const skipLine = () => {
    const next = source.indexOf("\n", index);
    index = next < 0 ? source.length : next + 1;
  };
  while (index < source.length) {
    const space = /^\s*/.exec(source.slice(index))![0];
    index += space.length;
    if (index >= source.length) break;
    const rest = source.slice(index);
    const line = lineAt(index);
    if (rest.startsWith("%")) { skipLine(); continue; }
    const command = /^\\(?:re|provide)?newcommand\*?[ \t]*(?:\{[ \t]*\\([A-Za-z]+)[ \t]*\}|\\([A-Za-z]+))[ \t]*(?:\[[ \t]*(\d)[ \t]*\])?[ \t]*/.exec(rest);
    const def = command ? null : /^\\[gex]?def[ \t]*\\([A-Za-z]+)((?:#[1-9])*)[ \t]*/.exec(rest);
    if (command || def) {
      const name = command ? command[1] ?? command[2] : def![1];
      const group = readGroup(source, index + (command ?? def)![0].length);
      if (!group) {
        definitions.errors.push({ line, message: `\\${name} has no {…} body` });
        skipLine();
        continue;
      }
      const declared = command ? (command[3] ? Number(command[3]) : null) : def![2].length / 2;
      defineMacro(definitions, name, group.content, declared, line);
      index = group.end;
      continue;
    }
    const assignment = /^\\([A-Za-z]+)[ \t]*(?:\[[ \t]*(\d)[ \t]*\])?[ \t]*=[ \t]*([^\n]*)/.exec(rest);
    if (assignment) {
      if (!assignment[3].trim()) definitions.errors.push({ line, message: `\\${assignment[1]} has an empty value` });
      else defineMacro(definitions, assignment[1], assignment[3], assignment[2] ? Number(assignment[2]) : null, line);
    } else {
      definitions.errors.push({ line, message: `Not a definition: ${rest.split("\n")[0].slice(0, 60)}` });
    }
    skipLine();
  }
  return definitions;
}

type FencedBlock = { start: number; end: number; contentStart: number; contentEnd: number; info: string };

/** The fenced code block opening on the line at `start`, if any. */
function fencedBlockAt(source: string, start: number): FencedBlock | null {
  const lineEnd = source.indexOf("\n", start);
  const open = FENCE_OPEN.exec(source.slice(start, lineEnd < 0 ? source.length : lineEnd));
  if (!open || (open[1][0] === "`" && open[2].includes("`"))) return null;
  const contentStart = lineEnd < 0 ? source.length : lineEnd + 1;
  const close = new RegExp(`^[ \\t]*${open[1][0] === "`" ? "`" : "~"}{${open[1].length},}[ \\t]*$`);
  let offset = contentStart;
  while (offset < source.length) {
    const next = source.indexOf("\n", offset);
    const end = next < 0 ? source.length : next;
    if (close.test(source.slice(offset, end))) {
      return { start, end: next < 0 ? source.length : next + 1, contentStart, contentEnd: offset, info: open[2].trim() };
    }
    offset = end + 1;
  }
  // An unclosed fence runs to the end of the document, as in CommonMark.
  return { start, end: source.length, contentStart, contentEnd: source.length, info: open[2].trim() };
}

/** Every ```libera-macro block of a document, in order. */
export function findMacroBlocks(markdown: string) {
  const blocks: FencedBlock[] = [];
  for (let start = 0; start < markdown.length;) {
    const block = fencedBlockAt(markdown, start);
    if (block) {
      if (isMacroBlockLanguage(block.info)) blocks.push(block);
      start = block.end;
      continue;
    }
    const next = markdown.indexOf("\n", start);
    if (next < 0) break;
    start = next + 1;
  }
  return blocks;
}

/** The definitions of all of a document's macro blocks (after those of `base`). */
export function collectMarkdownMacros(markdown: string, base?: MarkdownMacroDefinitions): MarkdownMacroDefinitions {
  const definitions: MarkdownMacroDefinitions = { macros: new Map(base?.macros), errors: [] };
  if (!markdown.includes(MACRO_BLOCK_LANGUAGE)) return definitions;
  for (const block of findMacroBlocks(markdown)) parseMacroDefinitions(markdown.slice(block.contentStart, block.contentEnd), definitions);
  return definitions;
}

type ExpandContext = {
  macros: Map<string, MarkdownMacro>;
  counters: Map<string, number>;
  pairs: MathMarkerPair[];
  inline: { open: string; close: string };
  display: { open: string; close: string };
};

function readArguments(source: string, index: number, arity: number) {
  const args: string[] = [];
  for (let n = 0; n < arity; n++) {
    while (source[index] === " " || source[index] === "\t") index++;
    const group = readGroup(source, index);
    if (!group) return null;
    args.push(group.content);
    index = group.end;
  }
  return { args, end: index };
}

/**
 * Puts arguments into a body. In a text macro an argument over several lines
 * continues the container its parameter is in: each line of `> #1` stays in
 * the quote and of `- #1` in the list item, while a heading or table row gets
 * it on one line. Blank lines at its edges (`{` and `}` on lines of their own) go.
 */
function substitute(body: string, args: string[], text: boolean) {
  return body.replace(PARAMETER, (whole, n: string | undefined, offset: number) => {
    if (!n) return "#";
    const arg = args[Number(n) - 1];
    if (arg === undefined || !text || !arg.includes("\n")) return arg ?? whole;
    const value = arg.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
    const line = body.slice(body.lastIndexOf("\n", offset - 1) + 1, offset);
    if (/^[ \t]*(?:#{1,6}[ \t]|\|)/.test(line)) return value.replace(/[ \t]*\n\s*/g, " ");
    const lineEnd = body.indexOf("\n", offset);
    const { open, close } = wrappersAround(line, body.slice(offset + whole.length, lineEnd < 0 ? body.length : lineEnd));
    return continueLines(rewrap(value, open, close), continuationPrefix(line));
  });
}

/** The invocation (or counter) at `index`, which holds a backslash. */
function invoke(source: string, index: number, context: ExpandContext, depth: number, math: boolean, prefix = "") {
  if (depth > MAX_DEPTH || escapedAt(source, index)) return null;
  const counter = COUNTER.exec(source.slice(index));
  if (counter) {
    const value = (context.counters.get(counter[1]) ?? 0) + 1;
    context.counters.set(counter[1], value);
    return { end: index + counter[0].length, text: String(value), kind: "counter" as const, macro: null };
  }
  const name = /^[A-Za-z]+/.exec(source.slice(index + 1))?.[0];
  const macro = name ? context.macros.get(name) : undefined;
  if (!macro || (math && !macro.math)) return null;
  const read = readArguments(source, index + 1 + name!.length, macro.arity);
  if (!read) return null;
  // An argument running over lines of a quote or list loses their prefix; the expansion gets it back.
  const args = read.args.map((arg) => removeLinePrefix(arg, prefix));
  const body = substitute(macro.body, args, !macro.math);
  const text = macro.math ? expandMath(body, context, depth + 1) : expandText(body, context, depth + 1);
  return { end: read.end, text, kind: "macro" as const, macro };
}

/** Expands macros and counters inside LaTeX; text macros do not apply there. */
function expandMath(latex: string, context: ExpandContext, depth: number) {
  if (!latex.includes("\\")) return latex;
  let output = "";
  let copied = 0;
  for (let i = 0; i < latex.length; i++) {
    if (latex[i] !== "\\") continue;
    if (latex[i + 1] === "\\") { i++; continue; }
    const result = invoke(latex, i, context, depth, true);
    if (!result) continue;
    output += latex.slice(copied, i) + result.text;
    copied = result.end;
    i = result.end - 1;
  }
  return output + latex.slice(copied);
}

/** The inline openers right before a parameter whose closers come right after it, innermost first. */
function wrappersAround(before: string, after: string) {
  let open = "";
  let close = "";
  for (let found = true; found;) {
    found = false;
    for (const [pattern, closer] of WRAPPERS) {
      const opener = pattern.exec(before)?.[0];
      const end = opener && closer(opener);
      if (!opener || !end || !after.startsWith(end)) continue;
      open = opener + open;
      close += end;
      before = before.slice(0, -opener.length);
      after = after.slice(end.length);
      found = true;
      break;
    }
  }
  return { open, close };
}

/**
 * Inline Markdown cannot cross a paragraph, list item or heading, so an
 * argument of several gets its wrapper closed and opened again around each
 * (the body has the first opener and the last closer). Code, tables and rules
 * are left unwrapped.
 */
function rewrap(value: string, open: string, close: string) {
  if (!open || !value.includes("\n")) return value;
  const out: string[] = [];
  let running = true;
  let last = -1;
  let fence = "";
  const end = () => {
    if (running && last >= 0) out[last] += close;
    else if (running) out.push(close, "");
    running = false;
  };
  value.split("\n").forEach((line, index) => {
    if (fence) {
      out.push(line);
      if (line.replace(/^[ \t]*(?:>[ \t]?)*/, "").trim().startsWith(fence)) fence = "";
      return;
    }
    const [markers, quote, marker] = LINE_MARKERS.exec(line)!;
    const content = line.slice(markers.length);
    const fenceOpen = /^[ \t]*(`{3,}|~{3,})/.exec(line.slice(quote.length));
    if (!line.slice(quote.length).trim() || fenceOpen || /^[ \t]*(?:\||(?:[-*_][ \t]*){3,}$)/.test(line.slice(quote.length))) {
      end();
      if (fenceOpen) fence = fenceOpen[1];
      out.push(line);
      return;
    }
    if (index === 0 && markers) end();
    if (!running || (marker && index > 0)) {
      end();
      out.push(markers + open + content);
      running = true;
    } else out.push(line);
    last = out.length - 1;
  });
  // The body's closer needs an opener to close.
  if (!running) out.push("", open);
  return out.join("\n");
}

/** What precedes an inserted line in this container: `> ` and `b> ` stay, list markers become spaces. */
function continuationPrefix(lineBefore: string) {
  const prefix = CONTAINER_PREFIX.exec(lineBefore)![0];
  return prefix.replace(/[-*+]|\d{1,9}[.)]/g, (marker) => " ".repeat(marker.length));
}

/** Takes `prefix` off the lines after the first, as written in a quote or list (a blank quote line may be a bare `>`). */
export function removeLinePrefix(text: string, prefix: string) {
  if (!prefix || !text.includes("\n")) return text;
  return text.split("\n").map((line, index) => index === 0 ? line : line.startsWith(prefix) ? line.slice(prefix.length) : line.trimEnd() === prefix.trimEnd() ? "" : line).join("\n");
}

/** Writes `prefix` before every line after the first; a blank line gets it without trailing spaces. */
function continueLines(text: string, prefix: string) {
  return prefix ? text.replace(/\n([^\n]*)/g, (_, line: string) => `\n${line ? prefix + line : prefix.trimEnd()}`) : text;
}

function expandText(source: string, context: ExpandContext, depth: number, emit?: (replacement: MarkdownMacroReplacement) => void) {
  let output = "";
  let copied = 0;
  let lineStart = 0;
  const replace = (start: number, end: number, text: string, kind: MarkdownMacroReplacement["kind"], prefix?: string) => {
    output += source.slice(copied, start);
    emit?.({ start, end, outStart: output.length, text, kind, ...(prefix ? { prefix } : {}) });
    output += text;
    copied = end;
  };
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === "\n") { lineStart = ++i; continue; }
    if (i === lineStart && (char === "`" || char === "~" || char === " " || char === "\t")) {
      const block = fencedBlockAt(source, i);
      if (block) {
        // Definitions are read before expansion; the block itself renders as nothing.
        if (depth === 0 && isMacroBlockLanguage(block.info)) replace(block.start, block.end, "", "block");
        i = lineStart = block.end;
        continue;
      }
    }
    if (char === "`") {
      const run = /^`+/.exec(source.slice(i))![0];
      const close = new RegExp(`(^|[^\`])${run}(?!\`)`, "g");
      close.lastIndex = i + run.length - 1;
      const found = close.exec(source);
      i = found ? found.index + found[0].length : i + run.length;
      continue;
    }
    if (!escapedAt(source, i) && context.pairs.some((pair) => source.startsWith(pair.open, i))) {
      const atLineStart = !source.slice(lineStart, i).trim();
      const match = (atLineStart ? matchMath(source.slice(i), context.pairs, true) : undefined) ?? matchMath(source.slice(i), context.pairs, false);
      if (match) {
        const bodyStart = i + match.open.length;
        const bodyEnd = i + match.raw.length - match.close.length;
        const body = source.slice(bodyStart, bodyEnd);
        const expanded = expandMath(body, context, depth);
        if (expanded !== body) replace(bodyStart, bodyEnd, expanded, "math");
        i += match.raw.length;
        continue;
      }
    }
    if (char !== "\\") { i++; continue; }
    if (/[!-/:-@[-`{-~]/.test(source[i + 1] ?? "")) { i += 2; continue; }
    const prefix = continuationPrefix(source.slice(lineStart, i));
    const result = invoke(source, i, context, depth, false, prefix);
    if (!result) { i++; continue; }
    let text = result.text;
    if (result.macro?.math) {
      const lineEnd = source.indexOf("\n", result.end);
      const alone = !source.slice(lineStart, i).trim() && !source.slice(result.end, lineEnd < 0 ? source.length : lineEnd).trim();
      text = result.macro.math === "display" && alone
        ? `${context.display.open}\n${text}\n${context.display.close}`
        : `${context.inline.open}${text}${context.inline.close}`;
    }
    text = continueLines(text, prefix);
    replace(i, result.end, text, result.kind, prefix);
    i = result.end;
  }
  return output + source.slice(copied);
}

function expandContext(definitions: MarkdownMacroDefinitions, mathMarkers?: MathMarkerSettings, counters?: Record<string, number>): ExpandContext {
  return {
    macros: definitions.macros,
    counters: new Map(Object.entries(counters ?? {})),
    // Without configured markers Markdown is read with remark-math: `$…$` inline, `$$` blocks.
    pairs: mathMarkers ? mathMarkerPairs(mathMarkers) : REMARK_MATH_PAIRS,
    inline: (mathMarkers && preferredMathMarkerPair(mathMarkers, false)) || { open: "$", close: "$" },
    display: (mathMarkers && preferredMathMarkerPair(mathMarkers, true)) || { open: "$$", close: "$$" },
  };
}

/** Whether rendering this Markdown can involve macros at all (cheap; no parsing). */
export function mayUseMarkdownMacros(markdown: string, scope?: MarkdownMacroScope) {
  return markdown.includes(MACRO_BLOCK_LANGUAGE) || markdown.includes("\\counter-") || Boolean(scope?.definitions.macros.size);
}

export type MarkdownMacroExpansion = {
  markdown: string;
  replacements: MarkdownMacroReplacement[];
  definitions: MarkdownMacroDefinitions;
  /** Each counter's last value, to continue in the next part of a document. */
  counters: Record<string, number>;
  /** Maps an offset in the expanded Markdown back to the source. Text a macro produced maps to its invocation. */
  toSource(offset: number, bias?: "start" | "end"): number;
};

/**
 * Expands a document's macros and counters and drops its macro blocks. Null
 * when the document uses none, so callers keep the source as it is.
 */
export function expandMarkdownMacros(markdown: string, { mathMarkers, scope }: MarkdownMacroOptions = {}): MarkdownMacroExpansion | null {
  if (!mayUseMarkdownMacros(markdown, scope)) return null;
  const definitions = collectMarkdownMacros(markdown, scope?.definitions);
  const context = expandContext(definitions, mathMarkers, scope?.counters);
  const replacements: MarkdownMacroReplacement[] = [];
  const expanded = expandText(markdown, context, 0, (replacement) => replacements.push(replacement));
  if (!replacements.length) return null;
  return {
    markdown: expanded,
    replacements,
    definitions,
    counters: Object.fromEntries(context.counters),
    toSource(offset, bias = "start") {
      let low = 0;
      let high = replacements.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (replacements[middle].outStart <= offset) { found = middle; low = middle + 1; } else high = middle - 1;
      }
      if (found < 0) return offset;
      const replacement = replacements[found];
      const outEnd = replacement.outStart + replacement.text.length;
      // A node ending where a replacement starts ends before it; one starting where it ends starts after it.
      if (offset === replacement.outStart && (replacement.text.length > 0 || bias === "end")) return replacement.start;
      if (offset >= outEnd) return replacement.end + offset - outEnd;
      return bias === "end" ? replacement.end : replacement.start;
    },
  };
}

/**
 * Expands one stretch of text (a paragraph of the Visual editor) with shared
 * definitions and counters, reporting each replacement in its source.
 */
export function expandMacroText(text: string, definitions: MarkdownMacroDefinitions, counters: Map<string, number>, mathMarkers?: MathMarkerSettings) {
  const context = { ...expandContext(definitions, mathMarkers), counters };
  const replacements: MarkdownMacroReplacement[] = [];
  const markdown = expandText(text, context, 1, (replacement) => replacements.push(replacement));
  return { markdown, replacements };
}

/** Expands macros and counters in a formula (a math node's LaTeX). */
export function expandMacroLatex(latex: string, definitions: MarkdownMacroDefinitions, counters: Map<string, number>) {
  return expandMath(latex, { ...expandContext(definitions), counters }, 0);
}

/**
 * The macros of several documents together (later documents win), for text
 * written about them, such as AI chat replies. Null when none defines any.
 */
export function combinedMacroScope(documents: string[]): MarkdownMacroScope | null {
  let definitions: MarkdownMacroDefinitions | undefined;
  for (const document of documents) {
    if (document.includes(MACRO_BLOCK_LANGUAGE)) definitions = collectMarkdownMacros(document, definitions);
  }
  return definitions?.macros.size ? { definitions } : null;
}

/** Equal for scopes with the same definitions, so renderers can keep a scope that did not change. */
export function macroScopeKey(scope: MarkdownMacroScope | null | undefined) {
  return scope ? JSON.stringify([...scope.definitions.macros.values()].map(({ name, arity, body, math }) => [name, arity, body, math])) : "";
}

/** Successive scopes for the parts of one document (slides), so counters continue across them. */
export function markdownMacroScopes(document: string, parts: string[], mathMarkers?: MathMarkerSettings): MarkdownMacroScope[] {
  const definitions = collectMarkdownMacros(document);
  let counters: Record<string, number> = {};
  return parts.map((part) => {
    const scope = { definitions, counters };
    const expansion = expandMarkdownMacros(part, { mathMarkers, scope });
    if (expansion) counters = expansion.counters;
    return scope;
  });
}

type PositionedNode = { position?: { start: Point; end: Point }; children?: PositionedNode[] };
type Point = { line: number; column: number; offset?: number };

function restorePositions(tree: PositionedNode, expansion: MarkdownMacroExpansion, source: string) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const point = (old: Point, bias: "start" | "end"): Point => {
    if (old.offset === undefined) return old;
    const offset = Math.min(source.length, expansion.toSource(old.offset, bias));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle; else high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1, offset };
  };
  const visit = (node: PositionedNode) => {
    if (node.position) node.position = { start: point(node.position.start, "start"), end: point(node.position.end, "end") };
    node.children?.forEach(visit);
  };
  visit(tree);
}

/**
 * Expands macros before Markdown is parsed, then points the tree's positions
 * back at the source, so source maps, citations and review ranges keep
 * working. Use right after remark-parse.
 */
export const remarkMarkdownMacros: Plugin<[MarkdownMacroOptions?], Root> = function (options = {}) {
  const parse = this.parser;
  if (!parse) return;
  this.parser = (document, file) => {
    const source = String(document);
    const expansion = expandMarkdownMacros(source, options);
    if (!expansion) return parse(document, file);
    const tree = parse(expansion.markdown, file);
    restorePositions(tree as PositionedNode, expansion, source);
    return tree;
  };
};
