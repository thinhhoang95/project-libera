import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { decodeAttribute, destinationFrom, destinationRange, rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { isSlideChartDataFile, parseSlideChartSpec, slideChartBlocks } from "@/lib/slide-charts";
import { latexPathOccurrences, type LatexPathKind } from "@/lib/latex/path-occurrences";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";

// The paths a note or a LaTeX source writes, where they are in its text, and
// the rewrite of a move applied to them (docs/features/move-link-refactor.md).
// Pure, and the one function both sides apply: the server plans a note's
// rewrite against the disk (storage/move-links.ts) and writes it; the app
// applies the same rewrite to the text it holds (drafts, save baselines,
// saved workspaces), so the two agree to the byte.

/**
 * Where a path is written, which decides how it is read: `link` (Markdown
 * links and their reference definitions), `image` (Markdown images and their
 * definitions), `html-link` (`<a href>`), `html-image` (`<img src>`), `chart`
 * (a ```chart block's data file), and the LaTeX commands.
 */
export type MovedPathKind = "link" | "image" | "html-link" | "html-image" | "chart" | LatexPathKind;

/** Per kind of place: each path as written (its source text) → the text written there instead. */
export type MovedPathRewrite = Partial<Record<MovedPathKind, Record<string, string>>>;

export type PathOccurrence = {
  kind: MovedPathKind;
  /** The source text of the path. */
  written: string;
  /** The path as its reader takes it: Markdown escapes and HTML character references decoded, a chart value unquoted and trimmed. */
  value: string;
  start: number;
  end: number;
};

type MdNode = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};

// GFM, as the editor reads notes: `[^1]: old/doc.md` is a footnote's text, not a reference definition holding a path.
const parser = unified().use(remarkParse).use(remarkGfm);
const MARKDOWN = /\.(?:md|markdown)$/i;
const LATEX = /\.tex$/i;

function walk(node: MdNode, visit: (node: MdNode) => void) {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

/** The `href` of `<a>` and the `src` of `<img>` in a raw HTML node, outside comments and code. */
function htmlOccurrences(markdown: string, node: MdNode, add: (kind: MovedPathKind, start: number, end: number, value: string) => void) {
  const offset = node.position?.start.offset ?? 0;
  const html = markdown.slice(offset, node.position?.end.offset);
  const tags = /<!--[\s\S]*?-->|<(script|style|pre|code)\b[\s\S]*?<\/\1\s*>|<(a|img)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  for (const tag of html.matchAll(tags)) {
    if (!tag[2]) continue;
    const name = tag[2].toLowerCase();
    const wanted = name === "a" ? "href" : "src";
    const attributes = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    const opening = name.length + 1;
    for (const attribute of tag[0].slice(opening).matchAll(attributes)) {
      if (attribute[1].toLowerCase() !== wanted || !attribute[0].includes("=")) continue;
      const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      const valueOffset = attribute.index! + attribute[0].indexOf("=") + 1;
      const prefix = attribute[0].slice(attribute[0].indexOf("=") + 1).match(/^\s*["']?/)![0];
      const start = offset + tag.index! + opening + valueOffset + prefix.length;
      if (raw) add(name === "a" ? "html-link" : "html-image", start, start + raw.length, decodeAttribute(raw));
      break;
    }
  }
}

const CHART_PROBE = '"libera-chart-probe.csv"';

/** `text` from `start` to the end of the quoted scalar opening there (`"` with `\` escapes, `'` with `''`), or -1 when it never closes. */
function quotedEnd(text: string, start: number) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (quote === '"' && text[index] === "\\") index++;
    else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") index++;
      else return index + 1;
    }
  }
  return -1;
}

/**
 * Where a chart block (its code, YAML or JSON) writes its `data` value, as
 * written with its quotes: any form the chart reader accepts (indented, flow,
 * quoted keys, a value on the lines after the key). Candidates are found by
 * shape, and each is confirmed with the reader itself: the span replaced by
 * another value must make that the chart's `data`. A `#` comment, a nested
 * `data` key or anything else the reader does not take as the data fails that.
 */
function chartDataSpan(code: string) {
  const keys = /(^|[\s{,])(?:data|"data"|'data')[ \t]*:/g;
  for (const key of code.matchAll(keys)) {
    let start = key.index! + key[0].length;
    while (/\s/.test(code[start] ?? "")) start++;
    if (start >= code.length) continue;
    const lineStart = code.lastIndexOf("\n", key.index! + key[0].length - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0].length;
    const ends: number[] = [];
    if (code[start] === '"' || code[start] === "'") ends.push(quotedEnd(code, start));
    else {
      const lineEnd = code.indexOf("\n", start) < 0 ? code.length : code.indexOf("\n", start);
      const stripped = (end: number) => start + code.slice(start, end).replace(/\s+#.*$/, "").trimEnd().length;
      ends.push(stripped(lineEnd));
      // A plain value goes on over the lines indented deeper than its key.
      let end = lineEnd;
      for (;;) {
        const next = code.indexOf("\n", end + 1) < 0 ? code.length : code.indexOf("\n", end + 1);
        const line = code.slice(end + 1, next);
        if (end >= code.length || !line.trim() || line.trim().startsWith("#") || /^[ \t]*/.exec(line)![0].length <= indent) break;
        end = next;
      }
      if (end !== lineEnd) ends.push(stripped(end));
      // In flow style the value stops at `,`, `}` or `]`.
      const flow = code.slice(start, lineEnd).search(/[,}\]]/);
      if (flow > 0) ends.push(start + code.slice(start, start + flow).trimEnd().length);
    }
    for (const end of ends) {
      if (end <= start) continue;
      const probed = parseSlideChartSpec(code.slice(0, start) + CHART_PROBE + code.slice(end));
      if ("spec" in probed && probed.spec.data === "libera-chart-probe.csv") return { start, end };
    }
  }
  return null;
}

function chartOccurrences(markdown: string, add: (kind: MovedPathKind, start: number, end: number, value: string) => void) {
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index += 1) if (markdown[index] === "\n") lineStarts.push(index + 1);
  for (const block of slideChartBlocks(markdown)) {
    const parsed = parseSlideChartSpec(block.code);
    if (!("spec" in parsed) || !isSlideChartDataFile(parsed.spec.data)) continue;
    const span = chartDataSpan(block.code);
    if (!span) continue;
    // `block.line` is the fence's line (1-based), so body line i is line `block.line + i` counted from 0 (the code joins them with `\n`, whatever the file's line ends are).
    const codeLines = [0];
    for (let index = 0; index < block.code.length; index += 1) if (block.code[index] === "\n") codeLines.push(index + 1);
    const at = (position: number) => {
      let line = 0;
      while (line + 1 < codeLines.length && codeLines[line + 1] <= position) line++;
      return lineStarts[block.line + line] + position - codeLines[line];
    };
    add("chart", at(span.start), at(span.end - 1) + 1, parsed.spec.data!.trim());
  }
}

/**
 * Every path a Markdown note writes in a place a reader resolves: links and
 * images, inline or through their reference definition (the first definition
 * of a label, as CommonMark reads it), HTML `<a href>` and `<img src>`, and
 * chart data files. Code spans and fences hold none. A definition used by a
 * link and an image is listed once per kind, at the same span.
 */
export function markdownPathOccurrences(markdown: string): PathOccurrence[] {
  const root = parser.parse(markdown) as MdNode;
  const definitions = new Map<string, MdNode>();
  walk(root, (node) => {
    if (node.type === "definition" && node.identifier && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node);
  });
  // Inline HTML is one node per tag: what lies between a `<code>` node and its `</code>` node is code too.
  const insideCode = new Set<MdNode>();
  walk(root, (parent) => {
    let open: string | null = null;
    for (const child of parent.children ?? []) {
      if (child.type !== "html") continue;
      const html = markdown.slice(child.position?.start.offset ?? 0, child.position?.end.offset);
      if (open) {
        insideCode.add(child);
        if (new RegExp(`</${open}\\s*>`, "i").test(html)) open = null;
        continue;
      }
      const last = [...html.matchAll(/<(script|style|pre|code)\b[^>]*>/gi)].at(-1);
      if (last && !new RegExp(`</${last[1]}\\s*>`, "i").test(html.slice(last.index! + last[0].length))) open = last[1];
    }
  });
  const found: PathOccurrence[] = [];
  const seen = new Set<string>();
  const add = (kind: MovedPathKind, start: number, end: number, value: string) => {
    if (start >= end || seen.has(`${kind}:${start}`)) return;
    seen.add(`${kind}:${start}`);
    found.push({ kind, written: markdown.slice(start, end), value, start, end });
  };
  const definition = (node: MdNode | undefined, kind: MovedPathKind) => {
    if (!node?.url || node.position?.start.offset === undefined) return;
    const offset = node.position.start.offset;
    const range = destinationRange(markdown.slice(offset, node.position.end.offset), true);
    add(kind, offset + range.start, offset + range.end, node.url);
  };
  walk(root, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "link" && node.url && start !== undefined && end !== undefined && markdown[start] === "[") {
      // The text ends at its last child; the destination follows the `](` after it (an autolink has no brackets).
      const lastChild = node.children?.at(-1)?.position?.end.offset ?? start + 1;
      const close = markdown.indexOf("](", lastChild);
      if (close < 0 || close >= end) return;
      const range = destinationFrom(markdown.slice(close + 2, end), 0);
      add("link", close + 2 + range.start, close + 2 + range.end, node.url);
    } else if (node.type === "image" && node.url && start !== undefined) {
      const range = destinationRange(markdown.slice(start, end), false);
      add("image", start + range.start, start + range.end, node.url);
    } else if (node.type === "linkReference" && node.identifier) {
      definition(definitions.get(node.identifier.toUpperCase()), "link");
    } else if (node.type === "imageReference" && node.identifier) {
      definition(definitions.get(node.identifier.toUpperCase()), "image");
    } else if (node.type === "html" && !insideCode.has(node)) {
      htmlOccurrences(markdown, node, add);
    }
  });
  chartOccurrences(markdown, add);
  return found.sort((left, right) => left.start - right.start);
}

/** The paths a file's text writes: a Markdown note's or a LaTeX source's; none for other files. */
export function movedPathOccurrences(text: string, filePath: string): PathOccurrence[] {
  if (MARKDOWN.test(filePath)) return markdownPathOccurrences(text);
  if (LATEX.test(filePath)) return latexPathOccurrences(text).map((occurrence) => ({ ...occurrence, value: occurrence.written }));
  return [];
}

export type PathEdit = { start: number; end: number; text: string };

const lookup = (map: Record<string, string> | undefined, key: string) => map && Object.hasOwn(map, key) ? map[key] : undefined;

/**
 * The edits `rewrite` makes to a text, from its end to its start. A span read
 * by several kinds (a reference definition used by a link and an image)
 * changes only when every kind maps it to the same text.
 */
export function movedPathEdits(text: string, filePath: string, rewrite: MovedPathRewrite | undefined): PathEdit[] {
  if (!rewrite || !Object.values(rewrite).some((map) => map && Object.keys(map).length)) return [];
  const spans = new Map<number, { end: number; written: string; kinds: MovedPathKind[] }>();
  for (const occurrence of movedPathOccurrences(text, filePath)) {
    const span = spans.get(occurrence.start) ?? { end: occurrence.end, written: occurrence.written, kinds: [] };
    span.kinds.push(occurrence.kind);
    spans.set(occurrence.start, span);
  }
  const edits: PathEdit[] = [];
  for (const [start, span] of spans) {
    const replacements = span.kinds.map((kind) => lookup(rewrite[kind], span.written));
    if (replacements.some((replacement) => replacement === undefined) || new Set(replacements).size !== 1) continue;
    if (replacements[0] !== span.written) edits.push({ start, end: span.end, text: replacements[0]! });
  }
  return edits.sort((left, right) => right.start - left.start);
}

/** Applies edits listed from the end of the text to its start. */
export function applyPathEdits(text: string, edits: readonly PathEdit[]) {
  let next = text;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return next;
}

/** A move's rewrite of one file's text (`filePath` says how it is read). */
export function rewriteMovedPaths(text: string, filePath: string, rewrite: MovedPathRewrite | undefined) {
  return applyPathEdits(text, movedPathEdits(text, filePath, rewrite));
}

/**
 * Everything a move rewrites in one file's text, in the one order the server
 * applies it: images (a migration's copies), then paths, then citation keys.
 */
export function moveTextRewrite(filePath: string, parts: { imageSources?: Record<string, string>; paths?: MovedPathRewrite; citationKeys?: Record<string, string> }) {
  const { imageSources, paths, citationKeys } = parts;
  const keys = citationKeys && Object.keys(citationKeys).length ? new Map(Object.entries(citationKeys)) : null;
  if (!(imageSources && Object.keys(imageSources).length) && !paths && !keys) return undefined;
  return (text: string) => {
    const withImages = imageSources ? rewriteMarkdownImageSources(text, imageSources) : text;
    const withPaths = rewriteMovedPaths(withImages, filePath, paths);
    return keys ? rewriteCitationKeys(withPaths, keys).text : withPaths;
  };
}

// ---- Writing a path back --------------------------------------------------------

const hexBytes = (character: string) => [...new TextEncoder().encode(character)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");

/**
 * A new path segment as a destination can hold it: fully percent-encoded
 * when the link already was (`%` in its path), otherwise only what a
 * destination can't hold as is (spaces, parentheses, `%`, `#`, `?`, quotes, `&`, brackets).
 */
function encodeSegment(segment: string, uri: boolean) {
  if (uri) return encodeURIComponent(segment).replace(/[!'()*]/g, hexBytes);
  return segment.replace(/[\s%()<>\\#?"'&[\]`\u0000-\u001f\u007f]/gu, hexBytes);
}

function decodeSegment(segment: string) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** `?query` or `#fragment` and what follows, as written. */
function splitSuffix(destination: string) {
  const index = destination.search(/[?#]/);
  return index < 0 ? { path: destination, suffix: "" } : { path: destination.slice(0, index), suffix: destination.slice(index) };
}

/**
 * A link destination pointing at `nextPath` (decoded segments joined by `/`,
 * relative or from the library root, or an address such as
 * `/api/files/raw/...`), keeping what the destination wrote around its path:
 * the query and fragment, `./`, the spelling and percent-encoding of each
 * segment that stays. `written` is the source text, `value` the destination as
 * read, `html` whether it is an HTML attribute. Returns the text to write and
 * the destination it reads as; null when it can't be written back (Markdown
 * escapes around whitespace).
 */
export function writeDestinationPath(written: string, value: string, nextPath: string, html: boolean): { written: string; value: string } | null {
  // Escapes or character references in the source: rebuild from the value, and escape what needs it.
  const escaped = html ? written.includes("&") : /[\\&]/.test(written);
  const { path: oldPath, suffix } = splitSuffix(escaped ? value : written);
  const spelled = new Map<string, string>();
  for (const segment of oldPath.split("/")) if (!spelled.has(decodeSegment(segment))) spelled.set(decodeSegment(segment), segment);
  const uri = oldPath.includes("%");
  const dot = oldPath.startsWith("./") && !nextPath.startsWith("../") && !nextPath.startsWith("/") ? "./" : "";
  const path = dot + nextPath.split("/").map((segment) => segment === "" || segment === "." || segment === ".."
    ? segment : spelled.get(segment) ?? encodeSegment(segment, uri)).join("/");
  const next = `${path}${suffix}`;
  if (!escaped) return { written: next, value: next };
  if (html) return { written: next.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), value: next };
  // Whitespace is only a destination's own inside angle brackets, which the span (their content) already had: kept, never added, and never across a line.
  if (/[\r\n]/.test(next) || (/\s/.test(next) && !/\s/.test(written))) return null;
  return { written: next.replace(/[\\()<>&"']/g, (character) => `\\${character}`), value: next };
}

/** A chart's data value written in the style of the one it replaces: quoted as it was, and quoted when YAML needs it. */
export function writeChartValue(written: string, next: string) {
  if (written.startsWith('"')) return JSON.stringify(next);
  if (written.startsWith("'")) return `'${next.replace(/'/g, "''")}'`;
  const plain = next === next.trim() && !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(next) && !/: | #|:$/.test(next);
  return plain ? next : JSON.stringify(next);
}

/**
 * A LaTeX path as written in braces; null when TeX or our readers would read it
 * otherwise: braces, `%`, `#`, a backslash; spaces at either end (the readers
 * trim them, and braces cannot quote them); and in `\bibliography{...}` a comma,
 * which separates keys there (latex/path-occurrences.ts, readLatexBibliographyReferences).
 */
export function writeLatexPath(next: string, kind?: LatexPathKind) {
  if (/[{}%#\\]/.test(next) || next !== next.trim()) return null;
  if (kind === "latex-bibliography" && next.includes(",")) return null;
  return next;
}
