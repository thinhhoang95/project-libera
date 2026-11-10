/* On-demand previews of drawings the Visual mode does not draw (TikZ,
 * pgfplots, tikz-cd, xy, circuitikz, quantikz…): the picture's source is cut
 * out of its float, put in a one-page document with the project's own
 * preamble, compiled like a normal build (preview-build.ts), and the page is
 * cropped to the ink. This file holds the pure parts, shared by the editor and
 * the server: finding the picture, assembling the document, the cache key and
 * the cropping. */

/** Environments drawn by TikZ-based packages, with the name the Visual mode gives their placeholder (walk.ts). */
const PICTURE_ENVIRONMENTS: Record<string, string> = {
  tikzpicture: "", tikzcd: "diagram:tikz-cd", quantikz: "diagram:quantikz", circuitikz: "diagram:circuitikz",
  pchstack: "diagram:cryptocode", pcvstack: "diagram:cryptocode", pgfpicture: "diagram:PGF",
};

/** The text with each comment blanked (same length, so offsets hold). */
function maskComments(text: string) {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (all, lead: string, slashes: string) => lead + slashes + " ".repeat(all.length - lead.length - slashes.length));
}

/** The end of the group opening at `open` (a `{`), or -1. */
function groupEnd(text: string, open: number) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") { index++; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

/** The end of `\end{name}` closing the environment begun before `from`, counting nested ones of the same name. */
function environmentEnd(text: string, name: string, from: number) {
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${name.replace(/[*]/g, "\\*")}\\}`, "g");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

export type DrawingCandidate = { from: number; to: number; drawing: string; math: boolean };

/** Display-math delimiters around a picture (`\[\begin{tikzcd}…\end{tikzcd}\]`): the wider range, else null. */
function mathAround(text: string, from: number, to: number) {
  const before = text.slice(0, from).replace(/\s+$/, "");
  const after = text.slice(to).replace(/^\s+/, "");
  const pairs: Array<[RegExp, RegExp]> = [
    [/\\\[$/, /^\\\]/], [/\$\$$/, /^\$\$/], [/\\begin\s*\{(?:equation|displaymath|gather)\*?\}$/, /^\\end\s*\{(?:equation|displaymath|gather)\*?\}/],
    [/(?:^|[^$\\])\$$/, /^\$(?!\$)/], [/\\\($/, /^\\\)/],
  ];
  for (const [open, close] of pairs) {
    const opening = open.exec(before);
    const closing = close.exec(after);
    if (!opening || !closing) continue;
    const start = before.length - opening[0].replace(/^[^$\\]/, "").length;
    const end = text.length - after.length + closing[0].length;
    return { from: start, to: end };
  }
  return null;
}

/** The drawings in a float's source, in order, with the names the Visual mode gives their placeholders. */
export function drawingCandidates(source: string): DrawingCandidate[] {
  const text = maskComments(source);
  const found: DrawingCandidate[] = [];
  const pattern = /\\begin\s*\{([A-Za-z]+)\}|\\xymatrix(?![A-Za-z@])|\\(input|include|includestandalone|tikzfig|ctikzfig)(?![A-Za-z@])\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let candidate: { from: number; to: number; drawing: string } | null = null;
    if (match[1] !== undefined) {
      const drawing = PICTURE_ENVIRONMENTS[match[1]];
      if (drawing === undefined) continue;
      const end = environmentEnd(text, match[1], match.index + match[0].length);
      if (end < 0) continue;
      candidate = { from: match.index, to: end, drawing };
    } else if (match[0].startsWith("\\xymatrix")) {
      // `\xymatrix@C=1em@R=2pt{…}`: the spacing settings, then the group.
      const open = text.indexOf("{", match.index + match[0].length);
      const end = open < 0 ? -1 : groupEnd(text, open);
      if (end < 0) continue;
      candidate = { from: match.index, to: end, drawing: "diagram:xy" };
    } else {
      const argument = match[3].trim();
      if (!argument) continue;
      candidate = { from: match.index, to: match.index + match[0].length, drawing: /tikzfig$/.test(match[2]) ? `${argument}.tikz` : argument };
    }
    const math = mathAround(text, candidate.from, candidate.to);
    found.push({ ...candidate, ...(math ?? {}), math: !!math });
    // What is inside a picture is part of it (a tikzpicture in a node of another).
    pattern.lastIndex = Math.max(pattern.lastIndex, candidate.to);
  }
  return found;
}

/**
 * The source of the `ordinal`-th drawing named `drawing` in a float (the
 * placeholder's name: "" for a tikzpicture, `diagram:<package>`, or a file),
 * ready to typeset in a document body, or null when it cannot be found.
 */
export function drawingSource(floatSource: string, drawing: string, ordinal: number) {
  const matches = drawingCandidates(floatSource).filter((candidate) => candidate.drawing === drawing);
  const picked = matches[ordinal];
  if (!picked) return null;
  const text = floatSource.slice(picked.from, picked.to).trim();
  // xy's `\xymatrix` is set in math mode.
  return picked.drawing === "diagram:xy" && !picked.math ? `\\(${text}\\)` : text;
}

/** The preamble of a document: the text before `\begin{document}`, or null when it has no `\documentclass` before it. */
export function documentPreamble(text: string) {
  const masked = maskComments(text);
  const begin = /\\begin\s*\{document\}/.exec(masked);
  if (!begin) return null;
  if (!/\\documentclass\s*(?:\[[^\]]*\])?\s*\{/.test(masked.slice(0, begin.index))) return null;
  return text.slice(0, begin.index);
}

export type PreviewClass = "own" | "article";

/**
 * The one-page document a drawing is compiled in: the project's preamble (its
 * packages and macros, and its class with "own", which keeps `\linewidth` and
 * the class's commands; `article` as the fallback when that class does not
 * compile on its own), an empty page style, no line numbers, and the picture.
 * A beamer picture goes in a plain frame, outside which beamer shows nothing.
 */
export function assemblePreviewDocument(preamble: string, picture: string, documentClass: PreviewClass = "own") {
  const masked = maskComments(preamble);
  const declaration = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/.exec(masked);
  const className = declaration?.[1].trim() ?? "article";
  let head = preamble;
  if (!declaration) head = `\\documentclass{article}\n${preamble}`;
  else if (documentClass === "article" && className !== "article") {
    head = `${preamble.slice(0, declaration.index)}\\documentclass{article}${preamble.slice(declaration.index + declaration[0].length)}`;
  }
  const beamer = documentClass === "own" && className === "beamer";
  return [
    head.replace(/\s+$/, ""),
    "\\begin{document}",
    "\\pagestyle{empty}\\thispagestyle{empty}%",
    "\\makeatletter\\@ifundefined{nolinenumbers}{}{\\nolinenumbers}\\makeatother%",
    ...(beamer ? ["\\begin{frame}[plain]"] : []),
    "\\noindent",
    picture,
    ...(beamer ? ["\\end{frame}"] : []),
    "\\end{document}",
    "",
  ].join("\n");
}

/** A short, stable hash (cyrb53) for the client's cache key; the server keys its files by SHA-256. */
export function previewHash(...parts: string[]) {
  const text = parts.join("\u0000");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export type CropBox = { x: number; y: number; width: number; height: number };

/**
 * The part of a rendered page holding ink: the bounding box of the pixels
 * darker than `threshold` (or not opaque white), widened by `margin` pixels
 * and kept inside the page. Null for a blank page. `pixels` is RGBA.
 */
export function cropBox(pixels: ArrayLike<number>, width: number, height: number, { threshold = 248, margin = 8 }: { threshold?: number; margin?: number } = {}): CropBox | null {
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    let rowLeft = -1;
    let rowRight = -1;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const alpha = pixels[at + 3];
      // Transparent pixels are paper; opaque ones count when any channel is darker than the threshold.
      const ink = alpha > 16 && (pixels[at] < threshold || pixels[at + 1] < threshold || pixels[at + 2] < threshold);
      if (!ink) continue;
      if (rowLeft < 0) rowLeft = x;
      rowRight = x;
    }
    if (rowLeft < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    left = Math.min(left, rowLeft);
    right = Math.max(right, rowRight);
  }
  if (top < 0) return null;
  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);
  return { x, y, width: Math.min(width, right + margin + 1) - x, height: Math.min(height, bottom + margin + 1) - y };
}

/** The first error of a preview's log, short enough for the placeholder. */
export function previewErrorSummary(log: string) {
  const line = /^(?:!|.*:\d+:)\s*(.+)$/m.exec(log)?.[1]?.trim();
  if (!line) return "The picture could not be compiled.";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
