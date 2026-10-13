/** LaTeX project helpers shared by the editor and the build. Pure functions. */

export const LATEX_ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type LatexEngine = (typeof LATEX_ENGINES)[number];
export type LatexEngineSetting = LatexEngine | "auto";

export const LATEX_ENGINE_LABELS: Record<LatexEngine, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

export function isLatexEngine(value: unknown): value is LatexEngine {
  return typeof value === "string" && (LATEX_ENGINES as readonly string[]).includes(value);
}

/** Only `.tex` files are typeset; `.bib`, `.sty` and `.cls` are edited only. */
export function isCompilableLatexPath(filePath: string) {
  return /\.tex$/i.test(filePath);
}

/** TeXShop/TeXstudio style `% !TEX key = value` comments from the preamble. */
export function readLatexMagicComments(source: string) {
  const comments: { root?: string; program?: string } = {};
  const head = source.slice(0, 4000).split(/\r?\n/, 40);

  for (const line of head) {
    const match = line.match(/^\s*%\s*!\s*TeX\s+(TS-program|program|root)\s*=\s*(.+?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "root") comments.root ??= match[2];
    else comments.program ??= match[2].toLowerCase();
  }

  return comments;
}

/** The engine a document asks for: magic comment, then packages that need
 * a Unicode engine, then the user's choice. */
export function resolveLatexEngine(source: string, setting: LatexEngineSetting = "auto"): LatexEngine {
  const program = readLatexMagicComments(source).program?.replace(/^(pdf|xe|lua)tex$/, "$1latex");
  if (isLatexEngine(program)) return program;
  if (setting !== "auto") return setting;
  const preamble = stripLatexComments(source.slice(0, Math.max(0, source.search(/\\begin\s*\{document\}/)) || 20000));
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK)\b/.test(preamble)) return "xelatex";
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexja|lua-ul|luacolor)\b/.test(preamble) || /\\directlua\b/.test(preamble)) return "lualatex";
  return "pdflatex";
}

/** Whether a source is a complete document rather than a chapter fragment. */
export function hasDocumentClass(source: string) {
  return /\\documentclass\s*[[{]/.test(stripLatexComments(source.slice(0, 60_000)));
}

/** Remove `%` comments while keeping escaped `\%` and line structure. */
export function stripLatexComments(source: string) {
  return source.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
}

/** Notebook-relative path of a file referenced from `fromPath`'s folder. */
export function resolveRelativeNotebookPath(fromPath: string, reference: string) {
  const parts = fromPath.split("/").slice(0, -1);
  for (const segment of reference.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      // The notebook folder is the outermost directory a reference may reach.
      if (parts.length <= 1) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/** The main file to typeset when editing `filePath`, honoring `% !TEX root`. */
export function resolveLatexRootPath(filePath: string, source: string, knownPaths?: ReadonlySet<string>) {
  const root = readLatexMagicComments(source).root;
  if (!root) return filePath;
  const withExtension = /\.tex$/i.test(root) ? root : `${root}.tex`;
  const resolved = resolveRelativeNotebookPath(filePath, withExtension);
  if (!resolved || (knownPaths && !knownPaths.has(resolved))) return filePath;
  return resolved;
}

export type LatexOutlineEntry = { level: number; title: string; line: number; command: string };

const SECTION_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};

/** Sectioning commands in reading order, for the outline panel. */
export function readLatexOutline(source: string): LatexOutlineEntry[] {
  const entries: LatexOutlineEntry[] = [];
  const pattern = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = stripLatexComments(lines[index]);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const title = readBalancedGroup(line, match.index + match[0].length - 1) ?? line.slice(match.index + match[0].length);
      entries.push({
        level: SECTION_LEVELS[match[1]],
        title: title.replace(/\\[a-zA-Z@]+\*?\s*/g, (command) => (/^\\(?:textbf|textit|emph|texttt|textsc|mathrm|mbox)\b/.test(command) ? "" : command)).replace(/[{}]/g, "").replace(/\s+/g, " ").trim() || "(untitled)",
        line: index + 1,
        command: match[1],
      });
    }
  }

  return entries;
}

/** The contents of the `{...}` group opening at `openIndex`, if it closes. */
export function readBalancedGroup(text: string, openIndex: number) {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") { index++; continue; }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return text.slice(openIndex + 1, index);
  }
  return null;
}

/** `\label{...}` keys defined in a document. */
export function readLatexLabels(source: string) {
  const labels = new Set<string>();
  for (const match of stripLatexComments(source).matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(match[1].trim());
  return [...labels];
}

export type BibEntrySummary = { key: string; type: string; title?: string; author?: string; year?: string };

/** Entry keys and a short description from BibTeX sources, for `\cite` completion. */
export function readBibEntries(source: string): BibEntrySummary[] {
  const entries: BibEntrySummary[] = [];
  const pattern = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const body = source.slice(match.index + match[0].length, match.index + match[0].length + 2000);
    const field = (name: string) => body.match(new RegExp(`\\b${name}\\s*=\\s*[{"]((?:[^{}"]|\\{[^{}]*\\})*)[}"]`, "i"))?.[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    entries.push({ key: match[2], type, title: field("title"), author: field("author"), year: field("year") ?? body.match(/\byear\s*=\s*(\d{4})/i)?.[1] });
  }
  return entries;
}

/** Bibliography files a document names in `\bibliography{}` or `\addbibresource{}`. */
export function readLatexBibliographyReferences(source: string) {
  const references: string[] = [];
  const text = stripLatexComments(source);
  for (const match of text.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) {
    references.push(...match[1].split(",").map((name) => name.trim()).filter(Boolean).map((name) => (/\.bib$/i.test(name) ? name : `${name}.bib`)));
  }
  for (const match of text.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) references.push(match[1].trim());
  return references;
}

export function latexDocumentTemplate(title: string) {
  const safeTitle = title.replace(/[\\{}$&#^_%~]/g, "").trim() || "Untitled";
  return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{${safeTitle}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}

Start writing here.

\\end{document}
`;
}
