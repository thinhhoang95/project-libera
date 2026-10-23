import { markdownImageSources, rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { fileStem, markdownAssetsFolder } from "@/lib/storage/asset-names";

// A note's Python lives in a sidecar file in the note's assets folder, beside
// its figures and out of the notebook's tree: `Notes/analysis.md` has
// `Notes/_assets/analysis.md/analysis.py`. Storage moves, copies and deletes it
// with its note (storage/files.ts). The sidecar is split into cells by `# %%`
// lines, as in Jupytext, VS Code and Spyder; a cell with an id (`# %% [loss-curve]`)
// produces figures, saved into the note's assets and shown in the note as
// ordinary Markdown images named after the cell. Shared by the agent, the run
// route and the Visual editor; keep free of Node imports.

/** `[a-z…]` ids: letters, digits, `-` and `_`, starting with a letter or digit. */
export const PYTHON_CELL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CELL_HEADER = /^# %%(?:[ \t]+\[([^\]\n]*)\])?[ \t]*(.*)$/;
// Jupytext marks text cells this way; they are not code.
const TEXT_CELL_TYPES = new Set(["markdown", "md", "raw"]);

export type PythonCell = {
  /** Null for setup cells: the code before the first `# %%`, and cells without an id. */
  id: string | null;
  title: string;
  /** 1-based line of the cell's first code line in the sidecar. */
  startLine: number;
  code: string;
  /** Jupytext text cells (`# %% [markdown]`) are kept but never run. */
  text: boolean;
};

/** Original layout, used only to migrate unambiguous sidecars. */
export function legacyPythonSidecarPath(documentPath: string) {
  const [notebook, ...parts] = documentPath.split("/");
  return [notebook, markdownAssetsFolder(parts), `${fileStem(parts.at(-1) ?? "")}.py`].join("/");
}

/** Exact folders and the full note name keep spaces, punctuation and extensions distinct. */
export function pythonSidecarPath(documentPath: string) {
  const [notebook, ...parts] = documentPath.split("/");
  // Percent escapes are decoded by asset URLs; keep literal percent names unambiguous.
  const escape = (part: string) => part.replace(/[~%]/g, (char) => `~${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return [notebook, "_assets", ...parts.map(escape), escape(`${fileStem(parts.at(-1) ?? "")}.py`)].join("/");
}

export function pythonFigureFolder(documentPath: string) {
  return pythonSidecarPath(documentPath).split("/").slice(1, -1).join("/");
}

export function pythonFigureSourcePrefix(documentPath: string) {
  return pythonFigureFolder(documentPath).split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

const SOURCE_METADATA = /^# Libera Python figure sources: (.*)$/m;

/** Exact sources carried by a move or by migration from the original sidecar layout. */
export function previousPythonFigureSources(source: string): string[] {
  try {
    const value: unknown = JSON.parse(SOURCE_METADATA.exec(source)?.[1] ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

export function withPreviousPythonFigureSources(source: string, sources: string[]) {
  const line = `# Libera Python figure sources: ${JSON.stringify([...new Set(sources)])}`;
  // Append a comment, rather than inserting lines ahead of the user's code and tracebacks.
  return SOURCE_METADATA.test(source) ? source.replace(SOURCE_METADATA, () => line) : `${source.trimEnd()}\n\n${line}\n`;
}

export function ownsPythonFigureSource(documentPath: string, source: string, previous: readonly string[] = []) {
  if (!parsePythonFigureSource(source)) return false;
  const normalize = (value: string) => {
    const clean = value.split(/[?#]/, 1)[0].replace(/^\.\/+/, "");
    try { return decodeURIComponent(clean); } catch { return clean; }
  };
  const clean = normalize(source);
  return previous.some((entry) => normalize(entry) === clean) || clean.slice(0, clean.lastIndexOf("/")) === pythonFigureFolder(documentPath);
}

/** The sidecar as a link from its note, e.g. `../_assets/Lab/Growth%20notes.md/Growth%20notes.py`. */
export function pythonSidecarHref(documentPath: string) {
  const depth = documentPath.split("/").length - 2;
  return `${"../".repeat(depth)}${encodeURI(pythonSidecarPath(documentPath).split("/").slice(1).join("/"))}`;
}

export function parsePythonCells(source: string): PythonCell[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const cells: PythonCell[] = [];
  let current: PythonCell = { id: null, title: "", startLine: 1, code: "", text: false };
  let body: string[] = [];
  const close = () => {
    current.code = body.join("\n");
    if (current.id !== null || current.title || current.code.trim()) cells.push(current);
  };
  lines.forEach((line, index) => {
    const header = CELL_HEADER.exec(line);
    if (!header) {
      body.push(line);
      return;
    }
    close();
    const tag = header[1]?.trim() ?? "";
    const text = TEXT_CELL_TYPES.has(tag.toLowerCase());
    current = { id: tag && !text ? tag : null, title: header[2].trim(), startLine: index + 2, code: "", text };
    body = [];
  });
  close();
  return cells;
}

/** What is wrong with the sidecar's cell ids, or null. */
export function pythonCellProblem(cells: PythonCell[]): string | null {
  const seen = new Set<string>();
  for (const cell of cells) {
    if (cell.id === null) continue;
    if (!PYTHON_CELL_ID.test(cell.id)) return `The cell id "${cell.id}" (line ${cell.startLine - 1}) is invalid: use letters, digits, - and _ (up to 64), as in "# %% [loss-curve]".`;
    if (seen.has(cell.id)) return `Two cells have the id "${cell.id}". Cell ids must be unique.`;
    seen.add(cell.id);
  }
  return null;
}

/**
 * The sidecar with the cell `id` holding `code`: its body replaced, or a new
 * cell appended. A new sidecar gets a line saying what it is.
 */
export function upsertPythonCell(source: string, id: string, code: string, title = "") {
  const metadata = SOURCE_METADATA.exec(source)?.[0];
  source = source.replace(SOURCE_METADATA, "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const complete = (text: string) => finish(metadata ? `${text.trimEnd()}\n\n${metadata}` : text, newline);
  const body = code.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const cells = parsePythonCells(source);
  const index = cells.findIndex((cell) => cell.id === id);
  if (index >= 0) {
    const start = cells[index].startLine - 1;
    const next = cells[index + 1];
    // Keep the blank line that separates this cell from the next one.
    const end = next ? next.startLine - 2 : lines.length;
    const replaced = [...lines.slice(0, start), ...body.split("\n"), ...(next ? [""] : []), ...lines.slice(end)];
    return complete(replaced.join("\n"));
  }
  const header = `# %% [${id}]${title.trim() ? ` ${title.trim()}` : ""}`;
  const existing = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const intro = existing ? `${existing}\n\n` : "# Python for the note beside this file. Libera runs it cell by cell (`# %% [id]`);\n# each cell's figures appear in the note.\n\n";
  return complete(`${intro}${header}\n${body}`);
}

function finish(text: string, newline: string) {
  const normalized = `${text.replace(/\s+$/, "")}\n`;
  return newline === "\n" ? normalized : normalized.replace(/\n/g, newline);
}

// Figures are named `py-<cell>.<n>.<hash>.png`: the cell links the image to its
// code, and the content hash gives every result its own file, so a re-run
// shows at once (no stale cache) and undo brings the earlier figure back.
const FIGURE_NAME = /^py-([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(\d{1,3})\.([0-9a-f]{8,16})\.png$/;

export function pythonFigureFileName(cell: string, index: number, hash: string) {
  return `py-${cell}.${index}.${hash.slice(0, 10)}.png`;
}

/** The cell and figure number of a generated figure's image source, or null for any other image. */
export function parsePythonFigureSource(source: string): { cell: string; index: number } | null {
  const path = source.split(/[?#]/, 1)[0];
  let name = path.slice(path.lastIndexOf("/") + 1);
  try { name = decodeURIComponent(name); } catch { /* keep as written */ }
  const match = FIGURE_NAME.exec(name);
  return match ? { cell: match[1], index: Number(match[2]) } : null;
}

export type PythonFigure = { cell: string; index: number; src: string; width: number; height: number };

/**
 * Points every image of a re-run cell at its new figure. Images of figures the
 * cell no longer draws are left as they are and returned as `orphaned`.
 */
export function replacePythonFigureSources(documentPath: string, markdown: string, figures: PythonFigure[], ranCells: Iterable<string>, previousSources: readonly string[] = []) {
  const ran = new Set(ranCells);
  const next = new Map(figures.map((figure) => [`${figure.cell}.${figure.index}`, figure.src]));
  const sources: Record<string, string> = {};
  const referenced = new Set<string>();
  const orphaned: string[] = [];
  for (const source of markdownImageSources(markdown)) {
    const figure = parsePythonFigureSource(source);
    if (!figure || !ran.has(figure.cell) || !ownsPythonFigureSource(documentPath, source, previousSources)) continue;
    const key = `${figure.cell}.${figure.index}`;
    const replacement = next.get(key);
    if (replacement) {
      referenced.add(key);
      if (replacement !== source) sources[source] = replacement;
    } else if (!orphaned.includes(source)) orphaned.push(source);
  }
  const content = Object.keys(sources).length ? rewriteMarkdownImageSources(markdown, sources) : markdown;
  return {
    content,
    /** Figures already shown in the note (now updated). */
    referenced,
    orphaned,
  };
}
