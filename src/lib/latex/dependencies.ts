import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLatexIncludes } from "@/lib/latex/root";
import { hasDocumentClass, readLatexBibliographyReferences, resolveLatexRootPath, resolveRelativeNotebookPath, stripLatexComments, subfilesRootPath } from "@/lib/latex/project";
import { isLatexCitingPath } from "@/lib/references/latex-cite-syntax";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";

// Which files a notebook's LaTeX sources need, resolved as TeX resolves them:
// from each source's main file's folder (`\subimport` from its own), through
// `\graphicspath`, with `\includegraphics*` and extension-less graphics, and
// bibliographies also from the notebook folder (BIBINPUTS, latex/build.ts).
// A name TeX can't be asked about without expanding macros (`#1`, `\figdir/a`)
// is not resolved: it is counted as `unresolved`, never reported missing.
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
  /** The build cannot open this spelling whatever is on disk (latexOpenable): the check reports it, a move never writes one. */
  uncompilable?: boolean;
};

/** A reference as one main file's build resolves it: the same chapter can name a different file in each. */
export type LatexBuildReference = LatexReference & { main: string };

const GRAPHICS_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps"];
const INCLUDE_EXTENSIONS = [".tex"];
const PDF_EXTENSIONS = [".pdf"];

/**
 * Whether the build (latex/build.ts) can open `written` as a name read from
 * the main file's folder. `openin_any=p` refuses a name that climbs out of the
 * folder (`../x`) or is absolute; and `\include` writes `<folder>/x.aux` into
 * a work folder whose mirror skips folders starting with `_` or `.`
 * (mirrorSourceFolders), so `\include{_archive/one}` stops the run. One rule
 * for the check (latexDependencies) and for a move's rewrite (storage/move-links.ts).
 */
export function latexOpenable(written: string, options: { include?: boolean } = {}) {
  const name = written.replace(/\\/g, "/");
  if (/^(\/|[a-z]:)/i.test(name)) return false;
  const segments = name.split("/");
  if (segments.includes("..")) return false;
  if (options.include && segments.slice(0, -1).some((segment) => segment !== "." && (segment.startsWith("_") || segment.startsWith(".")))) return false;
  return true;
}

/** A name that depends on a macro (`#1` in a definition, `\figdir`): TeX would only know it after expanding. */
export const needsExpansion = (reference: string) => /[#\\]/.test(reference);

/**
 * How a reference is read: `include` (`\input`, `\include`, `\subfile`; `.tex`
 * added to a name without an extension, as readLatexIncludes does),
 * `bibliography` (`\bibliography`; `.bib` added), `bibresource` (a name taken
 * as written), `pdf`, `listing`, `graphics` (also through `\graphicspath`).
 */
export type LatexCandidateKind = "include" | "bibliography" | "bibresource" | "pdf" | "listing" | "graphics";

/** A path from `base`'s folder, then with each extension TeX adds. None outside the notebook (another notebook, `..` past its folder): not the check's to judge. */
function resolveFrom(notebook: string, base: string, reference: string, extensions: string[] = []) {
  const resolved = resolveRelativeNotebookPath(base, reference);
  if (!resolved || !resolved.startsWith(`${notebook}/`)) return [];
  // TeX tries the name as written, then with each extension: a dot in
  // `plot.v2` is not an extension unless it is one of theirs.
  return extensions.includes(path.extname(resolved).toLowerCase()) ? [resolved] : [resolved, ...extensions.map((extension) => `${resolved}${extension}`)];
}

/**
 * The library paths TeX tries, in order, for `reference` in a build that
 * reads from `base`'s folder (its main file; the file itself for
 * `\subimport`). One rule for the check (latexDependencies) and for the
 * rewrite of a move (storage/move-links.ts).
 */
export function latexCandidates(notebook: string, base: string, kind: LatexCandidateKind, reference: string, prefixes: readonly string[] = []): string[] {
  switch (kind) {
    case "include": return resolveFrom(notebook, base, /\.[a-z]+$/i.test(reference) ? reference : `${reference}.tex`, INCLUDE_EXTENSIONS);
    case "bibliography":
    case "bibresource": {
      const name = kind === "bibliography" && !/\.bib$/i.test(reference) ? `${reference}.bib` : reference;
      const fromRoot = resolveFrom(notebook, base, name);
      // Also from the notebook folder (BIBINPUTS, latex/build.ts).
      return [...fromRoot, ...resolveFrom(notebook, `${notebook}/main.tex`, name).filter((candidate) => !fromRoot.includes(candidate))];
    }
    case "pdf": return resolveFrom(notebook, base, reference, PDF_EXTENSIONS);
    case "listing": return resolveFrom(notebook, base, reference);
    case "graphics": return ["", ...prefixes].flatMap((prefix) => resolveFrom(notebook, base, `${prefix}${reference}`, GRAPHICS_EXTENSIONS));
  }
}

/** A main file's `\graphicspath` folders, as written. */
export function graphicsPaths(text: string) {
  const match = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(stripLatexComments(text));
  return match ? [...match[1].matchAll(/\{([^}]*)\}/g)].map((group) => group[1].trim()) : [];
}

/** A source as the disk has it. */
async function readSourceFile(file: string) {
  const { notebook, pathParts } = splitFilePath(file);
  return readFile(filePathFromParts(notebook, pathParts), "utf8");
}

/**
 * `files`: the notebook's visible files (library paths). Returns, per LaTeX
 * source, the visible files it needs, its references (with every candidate,
 * found or not), its main files, and whether the sources were only partly read.
 * `builds` lists the references once per main file that reaches the source
 * (`references` keeps the first), so a chapter shared by two mains is checked
 * from each. `read` gives a source's text by its library path (the disk by
 * default); the rewrite of a move reads the layout before the move through it.
 */
export async function latexDependencies(notebook: string, files: readonly string[], read: (file: string) => Promise<string> = readSourceFile) {
  const visible = new Set(files);
  const texFiles = files.filter((file) => isLatexCitingPath(file));
  let incomplete = texFiles.length > MAX_LATEX_FILES;
  const texts = new Map<string, string>();
  for (const file of texFiles.slice(0, MAX_LATEX_FILES)) {
    try {
      const text = await read(file);
      if (text.length > MAX_LATEX_CHARACTERS) incomplete = true;
      texts.set(file, text.slice(0, MAX_LATEX_CHARACTERS));
    } catch { incomplete = true; }
  }

  const dependencies = new Map<string, Set<string>>();
  const references = new Map<string, LatexReference[]>();
  const builds = new Map<string, LatexBuildReference[]>();
  const mainFiles = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
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
    const built = builds.get(file) ?? [];
    builds.set(file, built);
    const note = (kind: LatexReference["kind"], reference: string, candidates: string[], include = false) => {
      if (!candidates.length) return;
      if (needsExpansion(reference)) { unresolved.add(`${file}\0${reference}`); return; }
      const flag = latexOpenable(reference, { include }) ? {} : { uncompilable: true };
      if (!written.some((item) => item.kind === kind && item.written === reference)) written.push({ kind, written: reference, candidates, ...flag });
      if (!built.some((item) => item.main === root && item.kind === kind && item.written === reference)) built.push({ kind, written: reference, candidates, main: root, ...flag });
      for (const candidate of candidates) if (visible.has(candidate)) needs.add(candidate);
    };
    for (const include of readLatexIncludes(text)) {
      if (needsExpansion(include.path)) { unresolved.add(`${file}\0${include.path}`); continue; }
      const targets = latexCandidates(notebook, include.relativeToFile ? file : root, "include", include.path);
      note("include", include.path, targets, include.command === "include");
      for (const target of targets) if (texts.has(target)) visit(root, target, prefixes, seen);
    }
    // Names come with `.bib` added where `\bibliography` adds it, so each is taken as written.
    for (const bibliography of readLatexBibliographyReferences(text)) note("bibliography", bibliography, latexCandidates(notebook, root, "bibresource", bibliography));
    const stripped = stripLatexComments(text);
    // pdfpages and listings read their file from the main file's folder too.
    for (const match of stripped.matchAll(/\\includepdf\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const reference = match[1].trim();
      note("include", reference, latexCandidates(notebook, root, "pdf", reference));
    }
    for (const match of stripped.matchAll(/\\lstinputlisting\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const reference = match[1].trim();
      note("include", reference, latexCandidates(notebook, root, "listing", reference));
    }
    for (const match of stripped.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const reference = match[1].trim();
      note("graphics", reference, latexCandidates(notebook, root, "graphics", reference, prefixes));
    }
  };
  const known = new Set(texts.keys());
  const roots = [...texts].filter(([file, text]) => hasDocumentClass(text) && resolveLatexRootPath(file, text, known) === file && !subfilesRootPath(file, text, known)).map(([file]) => file);
  for (const root of roots) visit(root, root, graphicsPaths(texts.get(root)!), new Set());
  // Sources no main file includes are read on their own.
  for (const file of texts.keys()) if (!mainFiles.has(file)) visit(file, file, [], new Set());
  return { dependencies, references, builds, mainFiles, roots, incomplete, unresolved: unresolved.size };
}
