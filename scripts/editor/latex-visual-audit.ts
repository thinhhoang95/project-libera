/* Headless Visual mode audit against real papers (the recipe is .claude/skills/latex-visual-audit/SKILL.md).
 *
 *   npm run audit:latex-visual -- fetch <papersDir> [--per 1] [--skip 60] [--cats quant-ph,hep-th,...] [--exclude <file of ids>]
 *     Downloads arXiv sources: per category, the first recent paper with at least 25 KB of .tex. Each paper goes in a
 *     folder `<category>-<id>` of its own. The sources are data: nothing in them is run.
 *   npm run audit:latex-visual -- audit <papersDir> <outDir> [filter]
 *     Opens every .tex as the editor does (the project's macro files, the main file's definitions for a chapter, the
 *     numbering start, the body's includes), builds every pending piece, mounts the view and numbers it. Writes per
 *     paper `<paper>.report.md` (commands and math left as source, with a sample line each; errors; build time), the
 *     visible text of each file (`<paper>__<file>.txt`), and `summary.txt`.
 *
 * "Left as source" is a command or formula in the body, outside comments, that no construct covers. Some of those are
 * fine (a `\noindent`, a `\vspace`), most are a missing feature or a parse that went wrong. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { disabledField, setMacroSources, setNumbering, setNumberingIncludes, setNumberingStart, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering, type NumberingStart } from "../../src/lib/latex/macros/numbering";
import { chapterNumberingStart } from "../../src/lib/latex/macros/project-numbering";
import { collectLatexDefinitions, isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { collectBodyIncludes, collectMacroSources } from "../../src/components/libera/latex/latex-dependencies";
import katex from "katex";
import { forKatex, KATEX_MACROS, katexForEnvironment } from "../../src/lib/latex/codemirror/visual/math-render";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { subfilesRootPath } from "../../src/lib/latex/project";

const DEFAULT_CATEGORIES = ["quant-ph", "hep-th", "astro-ph.GA", "math.AG", "math.CO", "stat.ME", "cs.LO", "cond-mat.str-el", "math.PR", "cs.CL", "cs.DS", "q-bio.NC"];
const MIN_TEX_BYTES = 25_000;

function option(args: string[], name: string, fallback: string) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function texFiles(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...texFiles(full, base));
    else found.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return found;
}

async function fetchPapers(args: string[]) {
  const papersDir = args[0];
  if (!papersDir) throw new Error("fetch <papersDir>");
  const per = Number(option(args, "per", "1"));
  const skip = Number(option(args, "skip", "60"));
  const categories = option(args, "cats", DEFAULT_CATEGORIES.join(",")).split(",").filter(Boolean);
  const excludeFile = option(args, "exclude", "");
  const exclude = new Set(excludeFile && existsSync(excludeFile) ? [...readFileSync(excludeFile, "utf8").matchAll(/\b(\d{4}\.\d{4,5})\b/g)].map((m) => m[1]) : []);
  mkdirSync(papersDir, { recursive: true });
  for (const category of categories) {
    const feed = await (await fetch(`https://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&start=${skip}&max_results=${per * 8}`)).text();
    const ids = [...feed.matchAll(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/g)].map((m) => m[1]).filter((id) => !exclude.has(id));
    let taken = 0;
    for (const id of ids) {
      if (taken >= per) break;
      await sleep(3000); // arXiv asks for a few seconds between requests
      const response = await fetch(`https://arxiv.org/src/${id}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const folder = path.join(papersDir, `${category}-${id.replace("/", "_")}`);
      const archive = `${folder}.src`;
      writeFileSync(archive, bytes);
      mkdirSync(folder, { recursive: true });
      const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
      try {
        if (!gzip) throw new Error("not a source archive (PDF only?)");
        const { gunzipSync } = await import("node:zlib");
        const raw = gunzipSync(bytes);
        if (raw.subarray(257, 262).toString("latin1") === "ustar") {
          // A tar. Run from inside the folder with a relative name: GNU tar reads `C:/…` as a remote host on Windows.
          const tarFile = path.join(folder, "source.tar");
          writeFileSync(tarFile, raw);
          try { execFileSync("tar", ["xf", "source.tar"], { cwd: folder, stdio: "ignore" }); } finally { rmSync(tarFile, { force: true }); }
        } else {
          // A single gzipped .tex, not a tar.
          writeFileSync(path.join(folder, "main.tex"), raw);
        }
        // arXiv compiles a `toplevel` file named in 00README.json from the archive's root; the editor resolves includes
        // from the main file's folder, so a main file in a subfolder is moved to the root, as arXiv reads it.
        const readme = path.join(folder, "00README.json");
        if (existsSync(readme)) {
          try {
            const top = (JSON.parse(readFileSync(readme, "utf8")) as { sources?: Array<{ usage?: string; filename?: string }> }).sources?.find((source) => source.usage === "toplevel")?.filename;
            if (top?.includes("/") && existsSync(path.join(folder, top)) && !existsSync(path.join(folder, path.basename(top)))) renameSync(path.join(folder, top), path.join(folder, path.basename(top)));
          } catch { /* a README that isn't JSON: left as it is */ }
        }
        const texs = texFiles(folder).filter((file) => /\.tex$/i.test(file));
        const size = texs.reduce((sum, file) => sum + statSync(path.join(folder, file)).size, 0);
        if (size < MIN_TEX_BYTES) throw new Error(`only ${size} bytes of .tex`);
        console.log(`${category} ${id}: ${texs.length} .tex, ${size} bytes`);
        taken++;
      } catch (error) {
        console.log(`${category} ${id}: skipped, ${(error as Error).message}`);
        rmSync(folder, { recursive: true, force: true });
      } finally {
        rmSync(archive, { force: true });
      }
    }
  }
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
  return dom;
}

/** `\begin{document}` outside comments (AASTeX's template mentions it in a comment above its macros). */
const firstBegin = (text: string) => [...text.matchAll(/\\begin\s*\{document\}/g)].find((match) => !isInLatexComment(text, match.index!)) ?? null;

/** A file of definitions only (a `macros.tex`, an `sty.tex`): it has no body to draw. */
function isMacroFile(text: string) {
  if (firstBegin(text)) return false;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("%"));
  const defining = lines.filter((line) => /^\\(?:(?:re)?newcommand|providecommand|(?:g|e|x)?def|let|newenvironment|renewenvironment|DeclareMathOperator|DeclareRobustCommand|NewDocumentCommand|usepackage|RequirePackage|newtheorem|theoremstyle|makeatletter|makeatother|newif|newcounter|setlength|definecolor|newcolumntype|crefname|Crefname|hypersetup)\b/.test(line));
  return lines.length > 0 && defining.length / lines.length > 0.4;
}

const MATH_NODES = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment"]);

const lineOf = (text: string, pos: number) => text.slice(0, pos).split("\n").length;
const lineAt = (text: string, pos: number) => {
  const start = text.lastIndexOf("\n", pos) + 1;
  const end = text.indexOf("\n", pos);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 160);
};

async function auditFile(filePath: string, rootPath: string, known: ReadonlySet<string>, read: (path: string) => string) {
  const doc = read(filePath);
  const readText = async (path: string) => read(path);
  const bodyMatch = firstBegin(doc);
  const ownPreamble = doc.slice(0, bodyMatch ? bodyMatch.index : 0);
  const { sources } = await collectMacroSources({ filePath, rootPath, ownPreamble, ownBody: doc.slice(ownPreamble.length), known, readText, version: () => "1" });
  let start: NumberingStart | null = null;
  if (rootPath !== filePath) {
    const rootSource = sources.find((source: MacroSource) => source.path === rootPath);
    const base = rootSource ? collectLatexDefinitions(sources.map((source: MacroSource) => {
      const body = source === rootSource ? source.text.search(/\\begin\s*\{document\}/) : -1;
      return body >= 0 ? { ...source, text: source.text.slice(0, body) } : source;
    })) : undefined;
    start = await chapterNumberingStart(filePath, rootPath, readText, base).catch(() => null);
  }
  const { includes } = await collectBodyIncludes({ filePath, rootPath, text: doc, known, readText });

  const parsed = EditorState.create({ doc, extensions: [latexLanguageSupport(filePath, "tree")] });
  ensureSyntaxTree(parsed, doc.length, 20_000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport(filePath, "tree"), latexVisualState(), latexVisualMode({ documentPath: filePath })] });
  state = state.update({ effects: [setMacroSources.of(sources), setNumberingStart.of(start), setNumberingIncludes.of(includes)] }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 5000; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";

  // Drawn: inside a range the view replaces (a widget or hidden markup). A container (a theorem, a list) only styles
  // its body, so a command in it that nothing replaces is still on screen as source.
  const shown = view.state.field(structuralField).shown;
  const covered = (pos: number) => {
    let inside = false;
    shown.between(pos, pos + 1, (from, to, decoration) => {
      if (decoration.point && from <= pos && to > pos) { inside = true; return false; }
    });
    return inside;
  };
  // Drawn wrong: a widget whose text still has LaTeX in it, or "undefined"/"NaN" (each widget drawn on its own, since
  // jsdom's view only draws the first screen). Code and verbatim widgets show backslashes on purpose.
  const junk: string[] = [];
  shown.between(0, doc.length, (from, to, decoration) => {
    const widget = decoration.spec.widget as { toDOM?: (view: EditorView) => HTMLElement } | undefined;
    if (!widget?.toDOM || junk.length >= 60) return;
    let shownText = "";
    try {
      const element = widget.toDOM(view);
      element.querySelectorAll(".katex-mathml, pre, code, .cm-vis-tt, .cm-vis-raw, [data-source-only]").forEach((node) => node.remove());
      shownText = element.textContent ?? "";
    } catch (error) {
      junk.push(`${lineOf(doc, from)}: widget threw ${(error as Error).message.slice(0, 80)}`);
      return;
    }
    const bad = /\\[a-zA-Z]{2,}|\bundefined\b|\bNaN\b|\[object Object\]/.exec(shownText);
    if (bad) junk.push(`${lineOf(doc, from)}: shows "${shownText.slice(Math.max(0, bad.index - 40), bad.index + 60).replace(/\s+/g, " ")}"  from  ${doc.slice(from, Math.min(to, from + 100)).replace(/\n/g, " ")}`);
  });
  // A branch TeX skips (`\iffalse…\fi`, a discarding macro's argument) is faded on purpose, not left as source.
  const disabled = view.state.field(disabledField);
  const faded = (pos: number) => disabled.some((region) => region.from <= pos && pos < region.to);
  const bodyFrom = bodyMatch ? bodyMatch.index + bodyMatch[0].length : 0;
  const endMatch = doc.search(/\\end\s*\{document\}/);
  const bodyTo = endMatch >= 0 ? endMatch : doc.length;
  const body = doc.slice(bodyFrom, bodyTo);
  const commands = new Map<string, { count: number; sample: string }>();
  // Code and drawings are one unit each: a verbatim or listing is drawn as code (its `$` and `\` are text), a TikZ picture
  // is source as a whole (its `$(60:\C)!0.5!(120:\C)$` and `\draw` are not LaTeX commands or formulas to report).
  const opaque: Array<{ from: number; to: number }> = [];
  syntaxTree(view.state).iterate({
    from: bodyFrom, to: bodyTo,
    enter: (node) => {
      if (node.name !== "VerbatimEnvironment" && node.name !== "VerbCommand" && node.name !== "LstInlineCommand") return;
      opaque.push({ from: node.from, to: node.to });
      const env = node.name === "VerbatimEnvironment" ? /^\\begin\s*\{([^}]*)\}/.exec(doc.slice(node.from, node.from + 60))?.[1] : null;
      if (env && /^(?:tikzpicture|pgfpicture|circuitikz)$/.test(env) && !covered(node.from) && !isInLatexComment(doc, node.from) && !faded(node.from)) {
        const name = `begin{${env}} (one unit)`;
        const entry = commands.get(name);
        if (entry) entry.count++;
        else commands.set(name, { count: 1, sample: `${lineOf(doc, node.from)}: ${lineAt(doc, node.from)}` });
      }
      return false;
    },
  });
  const inOpaque = (pos: number) => opaque.some((range) => range.from <= pos && pos < range.to);
  for (const match of body.matchAll(/\\(?:begin\s*\{([^}]*)\}|([a-zA-Z@]+))/g)) {
    const pos = bodyFrom + match.index!;
    if ((pos > 0 && doc[pos - 1] === "\\") || isInLatexComment(doc, pos) || covered(pos) || faded(pos) || inOpaque(pos)) continue;
    const name = match[1] !== undefined ? `begin{${match[1]}}` : match[2];
    const entry = commands.get(name);
    if (entry) entry.count++;
    else commands.set(name, { count: 1, sample: `${lineOf(doc, pos)}: ${lineAt(doc, pos)}` });
  }
  const math: string[] = [];
  for (const match of body.matchAll(/\$\$?|\\\[|\\\(/g)) {
    const pos = bodyFrom + match.index!;
    if ((pos > 0 && doc[pos - 1] === "\\") || isInLatexComment(doc, pos) || covered(pos) || faded(pos) || inOpaque(pos)) continue;
    math.push(`${lineOf(doc, pos)}: ${doc.slice(pos, pos + 140).replace(/\n/g, " ")}`);
  }
  // Why each formula left as source was not drawn: the macro expansion failed, or KaTeX's error.
  const why = new Map<string, { count: number; sample: string }>();
  const defs = visualDefinitions(view.state);
  syntaxTree(view.state).iterate({
    from: bodyFrom, to: bodyTo,
    enter: (node) => {
      if (!MATH_NODES.has(node.name)) return;
      if (isInLatexComment(doc, node.from) || covered(node.from) || faded(node.from)) return false;
      const whole = doc.slice(node.from, node.to);
      const inner = node.node.getChild("DisplayMath")?.getChild("Math") ?? node.node.getChild("InlineMath")?.getChild("Math") ?? node.node.getChild("Math");
      let latex = inner ? doc.slice(inner.from, inner.to) : "";
      let display = node.name === "BracketMath" || !!node.node.getChild("DisplayMath");
      if (node.name.endsWith("Environment")) {
        const env = /^\\begin\s*\{([^}]*)\}/.exec(whole)?.[1] ?? "";
        const source = katexForEnvironment(env, whole.replace(/^\\begin\s*\{[^}]*\}/, "").replace(/\\end\s*\{[^}]*\}\s*$/, ""));
        latex = source.latex;
        display = !source.inline;
      }
      let reason: string;
      if (!latex.trim()) reason = "parse: no math body (unbalanced, or an error node)";
      else {
        const expanded = expandLatexMacros(latex, defs, { mode: "math", pos: node.from });
        if (!expanded.ok) reason = "macro expansion failed";
        else {
          try {
            katex.renderToString(forKatex(expanded.text.replace(/\\label\s*\{[^}]*\}/g, "")), { displayMode: display, throwOnError: true, strict: "ignore", trust: false, maxExpand: 500, output: "html", macros: { ...KATEX_MACROS } });
            reason = "renders alone: the walk rejected it (structure, an error node, or its context)";
          } catch (error) {
            reason = `KaTeX: ${(error as Error).message.replace(/^KaTeX parse error: /, "").replace(/ at position \d+:[\s\S]*$/, "").slice(0, 120)}`;
          }
        }
      }
      const entry = why.get(reason);
      if (entry) entry.count++;
      else why.set(reason, { count: 1, sample: `${lineOf(doc, node.from)}: ${whole.slice(0, 160).replace(/\n/g, " ")}` });
      return false;
    },
  });
  view.destroy();
  parent.remove();
  return { doc, text, commands, math, why, junk, numbered: numbering.entries.length };
}

async function audit(args: string[]) {
  const [papersDir, outDir, filter] = args;
  if (!papersDir || !outDir) throw new Error("audit <papersDir> <outDir> [filter]");
  const dom = installDom();
  mkdirSync(outDir, { recursive: true });
  const summary: string[] = [];
  const papers = readdirSync(papersDir).filter((name) => statSync(path.join(papersDir, name)).isDirectory() && (!filter || name.includes(filter)));
  for (const paper of papers) {
    const root = path.join(papersDir, paper);
    const files = texFiles(root);
    const known = new Set(files.map((file) => `nb/${file}`));
    const cache = new Map<string, string>();
    const read = (nbPath: string) => {
      let text = cache.get(nbPath);
      if (text === undefined) {
        try { text = readFileSync(path.join(root, nbPath.replace(/^nb\//, "")), "utf8").replace(/\r\n/g, "\n"); } catch { text = ""; }
        cache.set(nbPath, text);
      }
      return text;
    };
    const texs = files.filter((file) => /\.tex$/i.test(file));
    const isMain = (file: string) => /^[^%\n]*\\documentclass/m.test(read(`nb/${file}`)) && !!firstBegin(read(`nb/${file}`));
    // The main file: one with \documentclass and a body; the biggest if there are several (a standalone figure has both too).
    const mains = texs.filter(isMain).sort((a, b) => read(`nb/${b}`).length - read(`nb/${a}`).length);
    const rootPath = `nb/${mains[0] ?? texs[0]}`;
    const report = [`# ${paper} (main ${rootPath.slice(3)})`];
    const totals = new Map<string, number>();
    for (const file of texs) {
      const filePath = `nb/${file}`;
      if (!read(filePath).trim() || isMacroFile(read(filePath))) continue;
      // A subfiles chapter has a \documentclass and a body of its own but is typeset as part of the main file it names (as the app resolves it).
      const fileRoot = subfilesRootPath(filePath, read(filePath), known) ?? (isMain(file) ? filePath : rootPath);
      const started = performance.now();
      try {
        const result = await auditFile(filePath, fileRoot, known, read);
        const ms = performance.now() - started;
        const left = [...result.commands.values()].reduce((sum, entry) => sum + entry.count, 0);
        for (const [name, entry] of result.commands) totals.set(name, (totals.get(name) ?? 0) + entry.count);
        report.push(`\n## ${file}  (${result.doc.length} chars, ${ms.toFixed(0)} ms, ${result.numbered} numbered, ${left} commands left, ${result.math.length} math left)`);
        for (const [name, entry] of [...result.commands].sort((a, b) => b[1].count - a[1].count).slice(0, 60)) report.push(`  ${String(entry.count).padStart(4)} \\${name}    e.g. ${entry.sample}`);
        if (result.junk.length) report.push(`  drawn with LaTeX or junk in it:\n    ${result.junk.join("\n    ")}`);
        if (result.why.size) report.push(`  why formulas stay source:\n${[...result.why].sort((a, b) => b[1].count - a[1].count).map(([reason, entry]) => `    ${String(entry.count).padStart(4)} ${reason}\n         e.g. ${entry.sample}`).join("\n")}`);
        if (result.math.length) report.push(`  math left as source:\n    ${result.math.slice(0, 15).join("\n    ")}`);
        writeFileSync(path.join(outDir, `${paper}__${file.replace(/[\\/]/g, "_")}.txt`), result.text);
        summary.push(`${paper.padEnd(30)} ${file.slice(-38).padEnd(38)} ${String(result.doc.length).padStart(7)}ch ${ms.toFixed(0).padStart(6)}ms numbered=${String(result.numbered).padStart(4)} left=${String(left).padStart(5)} math=${String(result.math.length).padStart(4)} junk=${String(result.junk.length).padStart(3)}`);
      } catch (error) {
        const stack = (error as Error).stack?.split("\n").slice(0, 8).join("\n    ") ?? String(error);
        report.push(`\n## ${file}\nERROR: ${stack}`);
        summary.push(`${paper.padEnd(30)} ${file.slice(-38).padEnd(38)} ERROR ${(error as Error).message.slice(0, 80)}`);
      }
    }
    report.push(`\n## Paper totals\n${[...totals].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name, count]) => `  ${String(count).padStart(5)} \\${name}`).join("\n")}`);
    writeFileSync(path.join(outDir, `${paper}.report.md`), report.join("\n"));
  }
  writeFileSync(path.join(outDir, "summary.txt"), summary.join("\n"));
  console.log(summary.join("\n"));
  dom.window.close();
}

const [command, ...rest] = process.argv.slice(2);
(command === "fetch" ? fetchPapers(rest) : command === "audit" ? audit(rest) : Promise.reject(new Error("usage: fetch <papersDir> … | audit <papersDir> <outDir> [filter]")))
  .catch((error) => { console.error(error); process.exit(1); });
