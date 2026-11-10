/** LaTeX project helpers shared by the editor and the build. Pure functions. */
import { readGroup, readOptional, TEX_GROUPS } from "../macros/core";

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
  return readGroup(text, openIndex)?.content ?? null;
}

/** `\label{...}` keys defined in a document. */
export function readLatexLabels(source: string) {
  const labels = new Set<string>();
  for (const match of stripLatexComments(source).matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(match[1].trim());
  return [...labels];
}

/**
 * `citeAuthor`: the authors as a citation prints them ("Callaway and Sant'Anna", "Abadie et al."), when a compiled
 * bibliography gives them; `label`: the label a numeric or alphabetic style prints ("12", "Vas17").
 */
export type BibEntrySummary = { key: string; type: string; title?: string; author?: string; year?: string; citeAuthor?: string; label?: string };

/**
 * A BibTeX field's value, braces kept: `{…}` matched at any depth, `"…"` up to the closing quote outside braces
 * (an accent written `\"u` inside, as in `Fuchs-Sch\"undeln`, is part of it).
 */
function bibFieldValue(body: string, name: string) {
  const start = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, "i").exec(body);
  if (!start) return undefined;
  const at = start.index + start[0].length;
  if (body[at] === "{") return readGroup(body, at)?.content;
  if (body[at] !== "\"") return undefined;
  let depth = 0;
  for (let i = at + 1; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\"" && depth === 0) return body.slice(at + 1, i);
  }
  return undefined;
}

/** Entry keys and a short description from BibTeX sources, for `\cite` completion. */
export function readBibEntries(source: string): BibEntrySummary[] {
  const entries: BibEntrySummary[] = [];
  const pattern = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const body = source.slice(match.index + match[0].length, match.index + match[0].length + 4000);
    const field = (name: string) => bibFieldValue(body, name)?.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    entries.push({ key: match[2], type, title: field("title"), author: field("author"), year: field("year") ?? body.match(/\byear\s*=\s*(\d{4})/i)?.[1] });
  }
  return entries;
}

/** A TeX group's text without its braces and spacing (`{Sant'Anna}` → Sant'Anna). */
function bibText(text: string) {
  // natbib's `\natexlab{a}` is the year's letter (1975a).
  return text.replace(/\\natexlab\s*\{([^{}]*)\}/g, "$1").replace(/\\bibinitperiod|\\bibinithyphendelim|\\bibnamedelim[a-z]/g, (match) => (match === "\\bibinitperiod" ? "." : match === "\\bibinithyphendelim" ? "-" : " ")).replace(/~/g, " ").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** The authors a citation prints, from surnames: "Sun", "Sun and Abraham", "Sun et al.". */
function citeAuthors(surnames: string[]) {
  if (!surnames.length) return undefined;
  if (surnames.length === 1) return surnames[0];
  if (surnames.length === 2) return `${surnames[0]} and ${surnames[1]}`;
  return `${surnames[0]} et al.`;
}

/**
 * What a compiled bibliography says about each entry, for documents that ship one without the `.bib` (arXiv sources,
 * a `.bbl` from the last compile): BibTeX's `thebibliography` (in a `.bbl` or written into the document) and
 * biblatex's `.bbl` (`\entry{key}{type}{}` … `\endentry`).
 * - natbib's `\bibitem[Callaway and Sant'Anna(2020)]{key}` gives the cited authors and year;
 * - `\bibitem{key}` in a numeric style is numbered in order, `\bibitem[Vas17]{key}` has that label;
 * - biblatex's entries give the authors' family names, the year (with its extra letter) and the title.
 */
export function readCompiledBibliography(source: string): BibEntrySummary[] {
  const entries: BibEntrySummary[] = [];
  const text = stripLatexComments(source);
  if (text.includes("\\entry")) {
    const seen = new Set<string>();
    for (const match of text.matchAll(/\\entry\s*\{([^{}]+)\}\s*\{([^{}]*)\}[\s\S]*?\\endentry/g)) {
      // An entry cited in several reference sections is written in each.
      if (seen.has(match[1].trim())) continue;
      seen.add(match[1].trim());
      const body = match[0];
      const field = (name: string) => {
        const at = body.search(new RegExp(`\\\\field\\s*\\{${name}\\}\\s*\\{`));
        if (at < 0) return undefined;
        const group = readGroup(body, body.indexOf("{", body.indexOf(`{${name}}`, at) + name.length + 2));
        return group ? bibText(group.content) : undefined;
      };
      const names = (role: string) => {
        const at = body.search(new RegExp(`\\\\name\\s*\\{${role}\\}`));
        if (at < 0) return [];
        // \name{author}{2}{}{…}: the fourth group holds the names.
        let index = at + body.slice(at).indexOf("}") + 1;
        let group = null;
        for (let n = 0; n < 3; n++) {
          const open = body.indexOf("{", index);
          group = open >= 0 ? readGroup(body, open) : null;
          if (!group) return [];
          index = group.end;
        }
        const list = group!.content;
        const families = [...list.matchAll(/family=\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((family) => bibText(family[1]));
        if (families.length) return families;
        // biber before 2.x: {{hash}{Family}{F.}{Given}{G.}…} per name.
        return [...list.matchAll(/\{\{[^{}]*\}\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((name) => bibText(name[1]));
      };
      const surnames = names("author").length ? names("author") : names("editor");
      const year = field("labelyear") ?? field("year") ?? field("labeldatesource");
      const extra = field("extradate") ?? field("extrayear");
      const extraLetter = extra && /^\d+$/.test(extra) ? String.fromCharCode(96 + Number(extra)) : "";
      entries.push({
        key: match[1].trim(), type: match[2].trim() || "misc", title: field("title"), author: surnames.join(" and ") || undefined,
        year: year ? `${year}${extraLetter}` : undefined, citeAuthor: citeAuthors(surnames),
        ...(field("labelnumber") ? { label: field("labelnumber") } : field("labelalpha") ? { label: field("labelalpha") } : {}),
      });
    }
    return entries;
  }
  const start = text.search(/\\begin\s*\{thebibliography\}/);
  if (start < 0) return entries;
  const end = text.indexOf("\\end{thebibliography}", start);
  const list = text.slice(start, end < 0 ? text.length : end);
  // The harvard package's `\harvarditem[Abadie et al.]{Abadie, Diamond \harvardand\ Hainmueller}{2010}{key}`.
  if (list.includes("\\harvarditem")) {
    const group = (at: number) => { const open = /^\s*\{/.exec(list.slice(at, at + 20)); return open ? readGroup(list, at + open[0].length - 1) : null; };
    for (const match of list.matchAll(/\\harvarditem\s*(?:\[([^\]]*)\])?/g)) {
      const names = group((match.index ?? 0) + match[0].length);
      const year = names && group(names.end);
      const key = year && group(year.end);
      if (!names || !year || !key) continue;
      const cited = bibText((match[1] ?? names.content).replace(/\\harvardand\\?\s*/g, "and "));
      entries.push({ key: key.content.trim(), type: "bibitem", citeAuthor: cited, year: bibText(year.content) });
    }
    return entries;
  }
  // Each `\bibitem[label]{key}`, the label read with its braces at any depth (natbib's `{…(1975{\natexlab{a}})}`).
  const items: Array<{ index: number; end: number; 1: string | undefined; 2: string }> = [];
  for (const match of list.matchAll(/\\bibitem(?![A-Za-z@])\s*/g)) {
    let at = (match.index ?? 0) + match[0].length;
    const optional = list[at] === "[" ? readOptional(list, at, TEX_GROUPS) : null;
    if (optional) at = optional.end;
    while (/\s/.test(list[at] ?? "")) at++;
    const key = list[at] === "{" ? readGroup(list, at) : null;
    if (key && !/[{}]/.test(key.content)) items.push({ index: match.index ?? 0, end: key.end, 1: optional?.content, 2: key.content });
  }
  items.forEach((item, index) => {
    const following = list.slice(item.end, items[index + 1]?.index ?? list.length);
    // The title: the block after the first \newblock, when the style writes them.
    const blocks = following.split(/\\newblock\b/);
    // ACM's style marks the title (`\showarticletitle{…}`) and its fields (`\bibinfo{booktitle}{…}`).
    const marked = /\\showarticletitle\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(following)?.[1];
    const block = marked ?? (blocks.length > 1 ? blocks[1] : null);
    const title = block ? bibText(block.replace(/\\bibinfo\s*\{[^{}]*\}/g, "").replace(/\\(?:em|it|bf|textit|emph|textbf|bibfield|showarticletitle)\b\s*/g, "")).replace(/[.,]\s*$/, "") || undefined : undefined;
    const optional = item[1]?.trim().replace(/^\{([\s\S]*)\}$/, "$1");
    const entry: BibEntrySummary = { key: item[2].trim(), type: "bibitem", title };
    // ACM's `\protect\citeauthoryear{Full names}{Short names}{Year}`.
    const acm = optional ? /\\citeauthoryear\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(optional) : null;
    // natbib: `Short authors(Year)Full authors`.
    const natbib = optional && !acm ? /^([\s\S]*?)\s*\(\s*([^()]*?)\s*\)\s*([\s\S]*)$/.exec(optional) : null;
    if (acm) {
      entry.citeAuthor = bibText(acm[2].replace(/\\mbox\s*/g, ""));
      entry.year = bibText(acm[3]);
    } else if (natbib && natbib[1].trim()) {
      entry.citeAuthor = bibText(natbib[1]);
      entry.year = bibText(natbib[2]);
    } else entry.label = optional ? bibText(optional) : String(index + 1);
    entries.push(entry);
  });
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
