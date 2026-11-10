import { TreeFragment, type Tree } from "@lezer/common";
import { latexParser as parser } from "../codemirror/latex-parser";
import { resolveRelativeNotebookPath } from "../project";
import { bodyStartOf, isInLatexComment, macroAt, readLatexDefinitions, readLatexInputs, type LatexDefinitions, type LatexInput } from "./definitions";
import { computeLatexNumbering, type LabelTarget, type LatexNumbering, type NumberingStart } from "./numbering";

/* Where a chapter's counters start (docs/latex-visual-editor-plan.md §7.7): the
 * main file's body is numbered up to the `\input` or `\include` of the
 * chapter, with the files it includes before that in place, so a chapter's
 * first section is "3", not "1". */

/** Files read at most, to keep the work bounded on large projects (LongBench's 29 files are well inside it). */
const MAX_FILES = 400;
/** How deep includes are followed. */
const MAX_DEPTH = 3;

type ReadText = (path: string) => Promise<string>;

/**
 * The files TeX may read for an include, in the order it tries them: from the main file's directory (where TeX runs,
 * whichever file names it), or for the import package's commands and in the files they import, from the import
 * directory first. `importDir` is the directory the included file's own includes start from.
 */
export function includeTargets(input: LatexInput, rootPath: string, importDir = ""): { paths: string[]; importDir: string } {
  const resolve = (name: string) => resolveRelativeNotebookPath(rootPath, /\.(?:tex|ltx|sty)$/i.test(name) ? name : `${name}.tex`);
  if (input.dir !== undefined) {
    // `\subimport{dir/}{file}` is relative to the importing file's directory, `\import{dir/}{file}` to the main file's.
    const dir = input.command.startsWith("sub") ? `${importDir}${input.dir}` : input.dir;
    const path = resolve(`${dir}${input.file ?? ""}`);
    return { paths: path ? [path] : [], importDir: dir };
  }
  const paths = [importDir ? resolve(`${importDir}${input.path}`) : null, resolve(input.path)].filter((path): path is string => !!path);
  return { paths: [...new Set(paths)], importDir };
}

/** A file on the way from the main file to a chapter, with where the include leading on is (its end; in the file that includes the chapter, its start). */
export type InclusionStep = { path: string; text: string; cut: number };

/** The files from the main file's body to the one that includes `filePath`, in TeX's reading order; null when it is not included. */
export async function findInclusion(filePath: string, rootPath: string, readText: ReadText): Promise<InclusionStep[] | null> {
  if (filePath === rootPath) return null;
  const rootText = await readText(rootPath);
  if (!rootText) return null;
  let reads = 0;
  const visit = async (path: string, text: string, from: number, depth: number, importDir: string): Promise<InclusionStep[] | null> => {
    for (const input of readLatexInputs(text)) {
      if (input.pos < from) continue;
      const target = includeTargets(input, rootPath, importDir);
      // The first of the paths TeX tries that exists is the file it reads.
      for (const candidate of target.paths) {
        if (candidate === filePath) return [{ path, text, cut: input.pos }];
        if (depth >= MAX_DEPTH || reads >= MAX_FILES) break;
        reads++;
        const included = await readText(candidate);
        if (!included) continue;
        const inner = await visit(candidate, included, 0, depth + 1, target.importDir);
        if (inner) return [{ path, text, cut: input.end }, ...inner];
        break;
      }
    }
    return null;
  };
  return visit(rootPath, rootText, bodyStartOf(rootText), 0, "");
}

/**
 * The last parse of each expanded text (by main file and part): the next run reuses the tree of what did not change, so
 * an edit in one chapter of a book does not parse the others again (the book 2403.14606: 330 ms for the whole parse).
 */
const parses = new Map<string, { text: string; tree: Tree }>();

/** `seed`: another text's parse to start from when this one has none (a chapter's prefix starts as the whole document does). */
function parseAgain(key: string, text: string, seed?: string): Tree {
  const last = parses.get(key) ?? (seed === undefined ? undefined : parses.get(seed));
  let tree: Tree;
  if (last?.text === text) tree = last.tree;
  else if (last) {
    // The changed range, between what both texts start and end with.
    const old = last.text;
    let start = 0;
    const shortest = Math.min(old.length, text.length);
    while (start < shortest && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endOld = old.length;
    let endNew = text.length;
    while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) { endOld--; endNew--; }
    tree = parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(last.tree), [{ fromA: start, toA: endOld, fromB: start, toB: endNew }]));
  } else tree = parser.parse(text);
  parses.delete(key);
  parses.set(key, { text, tree });
  if (parses.size > 8) parses.delete(parses.keys().next().value!);
  return tree;
}

/** A copy of definitions that reading more into it leaves the original as it was. */
function copyDefinitions(defs: LatexDefinitions): LatexDefinitions {
  return {
    ...defs,
    macros: new Map([...defs.macros].map(([name, list]) => [name, [...list]])), environments: new Map(defs.environments), theorems: new Map(defs.theorems),
    counterWithin: new Map(defs.counterWithin), counterPrefix: new Map(defs.counterPrefix), crefNames: new Map(defs.crefNames), packages: [...defs.packages],
    packageOptions: new Map(defs.packageOptions), graphicsPaths: [...defs.graphicsPaths], columnTypes: new Map(defs.columnTypes), colors: new Map(defs.colors),
    lists: defs.lists && new Map(defs.lists), listOptions: defs.listOptions && new Map(defs.listOptions), extents: [], problems: [...defs.problems], unsupported: [...defs.unsupported],
  };
}

/** The last numbering of each expanded text with the definitions it was read with: an unchanged text is not numbered again. */
const numberings = new Map<string, { text: string; preamble: string; defs: LatexDefinitions; numbering: LatexNumbering }>();

/**
 * The numbering of an expanded body, with the preamble's definitions and then the body's own where they are (a
 * `\renewcommand{\thetable}{A\arabic{table}}` before the appendices' `\input` numbers only what follows it).
 */
function numberBody(key: string, text: string, preamble: LatexDefinitions, seed?: string) {
  const last = numberings.get(key);
  if (last && last.text === text && last.preamble === preamble.fingerprint) return last;
  const defs = readLatexDefinitions(text, copyDefinitions(preamble), { bodyStart: 0 });
  const numbering = computeLatexNumbering(parseAgain(key, text, seed), (from, to) => text.slice(from, to), defs);
  const result = { text, preamble: preamble.fingerprint, defs, numbering };
  numberings.delete(key);
  numberings.set(key, result);
  if (numberings.size > 8) numberings.delete(numberings.keys().next().value!);
  return result;
}

/** Where the last `\appendix` (or `appendices` environment) of a text is, or -1. */
function lastAppendix(text: string) {
  let at = -1;
  for (const match of text.matchAll(/\\appendix(?![A-Za-z@])|\\begin\s*\{appendices\}/g)) if (!isInLatexComment(text, match.index ?? 0)) at = match.index ?? 0;
  return at;
}

export async function chapterNumberingStart(
  filePath: string,
  rootPath: string,
  readText: ReadText,
  baseDefinitions?: LatexDefinitions,
): Promise<NumberingStart | null> {
  if (filePath === rootPath) return null;
  const rootText = await readText(rootPath);
  if (!rootText) return null;
  const bodyStart = bodyStartOf(rootText);
  // The preamble's definitions (the body's are read where they are, below).
  const preamble = baseDefinitions ?? readLatexDefinitions(rootText.slice(0, bodyStart), undefined, { file: rootPath });
  let reads = 0;
  /**
   * The body with its includes expanded (and theirs, a few levels deep): up to the chapter when `stop` is its path
   * (`found` then says it was reached), or all of it.
   */
  const expand = async (text: string, from: number, depth: number, importDir: string, stop: string | null = filePath): Promise<{ text: string; found: boolean }> => {
    let out = "";
    let at = from;
    for (const input of readLatexInputs(text)) {
      if (input.pos < from) continue;
      const target = includeTargets(input, rootPath, importDir);
      out += text.slice(at, input.pos);
      at = input.end;
      // The first of the paths TeX tries that exists is the file it reads.
      let included = "";
      for (const candidate of target.paths) {
        if (stop !== null && candidate === stop) return { text: out, found: true };
        if (depth >= MAX_DEPTH || reads >= MAX_FILES) break;
        reads++;
        included = await readText(candidate);
        if (included) break;
      }
      if (!included) continue;
      const inner = await expand(included, 0, depth + 1, target.importDir, stop);
      out += `\n${inner.text}\n`;
      if (inner.found) return { text: out, found: true };
    }
    return { text: out + text.slice(at), found: false };
  };
  const prefix = await expand(rootText, bodyStart, 0, "");
  if (!prefix.found) return null;
  // The whole document, for the numbers of labels in the other chapters (a chapter's `\cref{thm:spanner}` to another).
  reads = 0;
  const whole = await expand(rootText, bodyStart, 0, "", null);
  const all = numberBody(rootPath, whole.text, preamble).numbering;
  const before = numberBody(`${rootPath}\u0000${filePath}`, prefix.text, preamble, rootPath);
  const labels = [...all.labels].map(([key, target]): [string, LabelTarget] => [key, { ...target, pos: -1 }]);
  const { counters, appendix } = before.numbering;
  // A `\renewcommand{\thesection}{…}` made after the main file's `\appendix` still applies to the chapter's sections.
  const appendixAt = appendix ? lastAppendix(prefix.text) : -1;
  const appendixFormats = appendixAt < 0 ? [] : ["chapter", "section"].filter((counter) => (macroAt(before.defs, `the${counter}`, prefix.text.length)?.pos ?? -1) > appendixAt);
  return { counters, appendix, labels, ...(appendixFormats.length ? { appendixFormats } : {}) };
}
