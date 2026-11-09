import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLatexIncludes } from "@/lib/latex/root";
import { hasDocumentClass, readLatexBibliographyReferences, resolveLatexRootPath, resolveRelativeNotebookPath, stripLatexComments } from "@/lib/latex/project";
import { isLatexCitingPath } from "@/lib/references/latex-cite-syntax";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";

// Which files a notebook's LaTeX sources need, resolved as TeX resolves them:
// from each source's main file's folder (`\subimport` from its own), through
// `\graphicspath`, with `\includegraphics*` and extension-less graphics, and
// bibliographies also from the notebook folder (BIBINPUTS, latex/build.ts).
// Main files are found through the include graph. Used by the migration
// review (files left behind) and the notebook check (files missing).

export const MAX_LATEX_FILES = 400;
export const MAX_LATEX_CHARACTERS = 1_000_000;

export type LatexReference = {
  kind: "include" | "bibliography" | "graphics";
  /** As written in the source. */
  written: string;
  /** Library paths TeX would try, in order; the reference is satisfied by any one that exists. */
  candidates: string[];
};

const GRAPHICS_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps"];

function graphicsPaths(text: string) {
  const match = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(stripLatexComments(text));
  return match ? [...match[1].matchAll(/\{([^}]*)\}/g)].map((group) => group[1].trim()) : [];
}

/**
 * `files`: the notebook's visible files (library paths). Returns, per LaTeX
 * source, the visible files it needs, its references (with every candidate,
 * found or not), its main files, and whether the sources were only partly read.
 */
export async function latexDependencies(notebook: string, files: readonly string[]) {
  const visible = new Set(files);
  const texFiles = files.filter((file) => isLatexCitingPath(file));
  let incomplete = texFiles.length > MAX_LATEX_FILES;
  const texts = new Map<string, string>();
  for (const file of texFiles.slice(0, MAX_LATEX_FILES)) {
    try {
      const { notebook: owner, pathParts } = splitFilePath(file);
      const text = await readFile(filePathFromParts(owner, pathParts), "utf8");
      if (text.length > MAX_LATEX_CHARACTERS) incomplete = true;
      texts.set(file, text.slice(0, MAX_LATEX_CHARACTERS));
    } catch { incomplete = true; }
  }
  const resolveFrom = (base: string, reference: string, extensions: string[] = []) => {
    const resolved = resolveRelativeNotebookPath(base, reference);
    // Outside the notebook (another notebook, `..` past its folder): not this check's to judge.
    if (!resolved || !resolved.startsWith(`${notebook}/`)) return [];
    return path.extname(resolved) ? [resolved] : [resolved, ...extensions.map((extension) => `${resolved}${extension}`)];
  };

  const dependencies = new Map<string, Set<string>>();
  const references = new Map<string, LatexReference[]>();
  const mainFiles = new Map<string, Set<string>>();
  const visit = (root: string, file: string, prefixes: string[], seen: Set<string>) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = texts.get(file);
    if (text === undefined) return;
    (mainFiles.get(file) ?? mainFiles.set(file, new Set()).get(file)!).add(root);
    const needs = dependencies.get(file) ?? new Set<string>();
    dependencies.set(file, needs);
    const written = references.get(file) ?? [];
    references.set(file, written);
    const note = (kind: LatexReference["kind"], reference: string, candidates: string[]) => {
      if (!candidates.length) return;
      if (!written.some((item) => item.kind === kind && item.written === reference)) written.push({ kind, written: reference, candidates });
      for (const candidate of candidates) if (visible.has(candidate)) needs.add(candidate);
    };
    for (const include of readLatexIncludes(text)) {
      const targets = resolveFrom(include.relativeToFile ? file : root, include.path);
      note("include", include.path, targets);
      for (const target of targets) if (texts.has(target)) visit(root, target, prefixes, seen);
    }
    for (const bibliography of readLatexBibliographyReferences(text)) {
      const fromRoot = resolveFrom(root, bibliography);
      note("bibliography", bibliography, [...fromRoot, ...resolveFrom(`${notebook}/main.tex`, bibliography).filter((candidate) => !fromRoot.includes(candidate))]);
    }
    for (const match of stripLatexComments(text).matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const reference = match[1].trim();
      note("graphics", reference, ["", ...prefixes].flatMap((prefix) => resolveFrom(root, `${prefix}${reference}`, GRAPHICS_EXTENSIONS)));
    }
  };
  const known = new Set(texts.keys());
  const roots = [...texts].filter(([file, text]) => hasDocumentClass(text) && resolveLatexRootPath(file, text, known) === file).map(([file]) => file);
  for (const root of roots) visit(root, root, graphicsPaths(texts.get(root)!), new Set());
  // Sources no main file includes are read on their own.
  for (const file of texts.keys()) if (!mainFiles.has(file)) visit(file, file, [], new Set());
  return { dependencies, references, mainFiles, incomplete };
}
