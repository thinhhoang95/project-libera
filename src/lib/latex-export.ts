import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { prepareLatexImages, type LatexImage } from "./latex-images";
import os from "node:os";
import path from "node:path";
import { convertMarkdownToLatex } from "./latex-generation";
import { findTexToolchain, texEnvironment, texExecutable } from "./latex/toolchain";
import { notebookOfDocument, prepareLatexCitations, type LatexCitationPlan } from "./references/latex-citations";

export { buildLatexPrompt } from "./latex-generation";

import { DEFAULT_LATEX_OPTIONS, type LatexOptions } from "./latex-options";

const LATEX_ARGUMENTS = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "document.tex"];

/** Runs one TeX tool in the build folder and rejects when it fails. Tests replace it. */
export type LatexToolRunner = (executable: string, args: string[], directory: string, signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<void>;

/** Do not pass API keys or application secrets to the TeX process. */
function latexEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: directory, TMPDIR: directory, TEXMFOUTPUT: directory,
    openin_any: "p", openout_any: "p", shell_escape: "f",
  };
}

const runTool: LatexToolRunner = (executable, args, directory, signal, env) => new Promise<void>((resolve, reject) => {
  execFile(executable, args, {
    cwd: directory, signal, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, env,
  }, (error) => error ? reject(error) : resolve());
});

async function findExecutable(candidates: string[], signal: AbortSignal) {
  for (const executable of candidates) {
    signal.throwIfAborted();
    const found = await new Promise<boolean>((resolve) => {
      execFile(executable, ["--version"], { signal, timeout: 5000 }, (error) => resolve(!error));
    });
    if (found) return executable;
  }
  return null;
}

export async function findPdfLatex(signal: AbortSignal) {
  const candidates = [process.env.LIBERA_PDFLATEX_PATH, "pdflatex", ...(process.platform === "darwin" ? ["/Library/TeX/texbin/pdflatex"] : [])].filter(Boolean) as string[];
  const found = await findExecutable(candidates, signal);
  if (found) return found;
  throw new Error("pdflatex was not found. Install TeX Live or MiKTeX on the computer running Libera, or set LIBERA_PDFLATEX_PATH, then restart Libera.");
}

/** biber, for the biblatex citation option: LIBERA_BIBER_PATH, the TeX installation's, or the one on PATH. */
export async function findBiber(signal: AbortSignal) {
  const toolchain = await findTexToolchain();
  const candidates = [process.env.LIBERA_BIBER_PATH, toolchain.binDirectory ? texExecutable(toolchain, "biber") : null, "biber"].filter(Boolean) as string[];
  const found = await findExecutable([...new Set(candidates)], signal);
  if (found) return found;
  throw new Error("biber was not found. Install it with your TeX distribution (TeX Live: tlmgr install biber; MiKTeX installs it on demand), set LIBERA_BIBER_PATH, or export citations as formatted text.");
}

/** Whether the TeX installation has a file (kpsewhich), e.g. a biblatex style's `apa.bbx`. */
export async function texFileExists(fileName: string, signal: AbortSignal) {
  const toolchain = await findTexToolchain();
  return new Promise<boolean>((resolve) => {
    execFile(texExecutable(toolchain, "kpsewhich"), [fileName], { signal, timeout: 10_000, env: texEnvironment(toolchain) }, (error, stdout) => resolve(!error && String(stdout).trim().length > 0));
  });
}

/** The plan's biblatex style when it is installed, else its generic fallback (authoryear or numeric ship with biblatex). */
export async function chooseBiblatexStyle(plan: NonNullable<LatexCitationPlan["biblatex"]>, available: (style: string) => Promise<boolean>) {
  if (plan.style === plan.fallbackStyle || await available(plan.style)) return plan.style;
  return plan.fallbackStyle;
}

export type CompileLatexOptions = {
  /** biblatex: the `.bib` file to write next to document.tex, and the biber to run. */
  bibliography?: { fileName: string; content: string; biber: string };
  run?: LatexToolRunner;
};

/**
 * Compile document.tex in a temporary folder. Without a bibliography the
 * engine runs twice (numbering, references, table of contents); with one,
 * latex → biber → latex → latex.
 */
export async function compileLatex(source: string, executable: string, signal: AbortSignal, images: LatexImage[] = [], { bibliography, run = runTool }: CompileLatexOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-latex-"));
  try {
    for (const image of images) {
      if (!/^image-\d+\.png$/.test(image.fileName)) throw new Error("Invalid staged image filename.");
      await writeFile(path.join(directory, image.fileName), image.body);
    }
    await writeFile(path.join(directory, "document.tex"), source, "utf8");
    if (bibliography) {
      if (!/^[\w-]+\.bib$/.test(bibliography.fileName)) throw new Error("Invalid bibliography filename.");
      await writeFile(path.join(directory, bibliography.fileName), bibliography.content, "utf8");
    }
    const latex = () => run(executable, LATEX_ARGUMENTS, directory, signal, latexEnvironment(directory));
    let stage: "pdflatex" | "biber" = "pdflatex";
    try {
      await latex();
      if (bibliography) {
        stage = "biber";
        const toolchain = await findTexToolchain();
        await run(bibliography.biber, ["document"], directory, signal, texEnvironment(toolchain, { TEXMFOUTPUT: directory, openin_any: "p", openout_any: "p", shell_escape: "f" }));
        stage = "pdflatex";
        await latex();
      }
      // The last pass resolves numbering, references, citations and the table of contents.
      await latex();
    } catch (error) {
      signal.throwIfAborted();
      const log = await readFile(path.join(directory, stage === "biber" ? "document.blg" : "document.log"), "utf8").catch(() => "");
      throw new Error(log.slice(-12000) || (error instanceof Error ? error.message : `${stage} failed.`));
    }
    return await readFile(path.join(directory, "document.pdf"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exportLatexPdf(markdown: string, signal: AbortSignal, progress: (message: string) => void, options: LatexOptions = DEFAULT_LATEX_OPTIONS, documentPath = "") {
  progress("Checking pdflatex…");
  const executable = await findPdfLatex(signal);
  // Citations become placeholders the model copies; a document without any takes the plain path.
  const citations = await prepareLatexCitations(markdown, notebookOfDocument(documentPath), { mode: options.citations ?? "formatted" });
  if (citations) progress("Formatting citations…");
  let bibliography: CompileLatexOptions["bibliography"];
  if (citations?.biblatex) {
    progress("Checking biber…");
    const biber = await findBiber(signal);
    citations.biblatex.style = await chooseBiblatexStyle(citations.biblatex, (style) => texFileExists(`${style}.bbx`, signal));
    bibliography = { fileName: citations.biblatex.bibFileName, content: citations.biblatex.bib, biber };
  }
  progress("Preparing document images…");
  const prepared = await prepareLatexImages(citations?.markdown ?? markdown, documentPath, signal);
  const { source, pdf } = await convertMarkdownToLatex(prepared.markdown, signal, progress, {
    options, images: prepared.images, compile: (source) => compileLatex(source, executable, signal, prepared.images, { bibliography }), citations,
  });
  let archive: string | undefined;
  if (prepared.images.length || bibliography) {
    const zip = new JSZip();
    zip.file("document.tex", source);
    if (bibliography) zip.file(bibliography.fileName, bibliography.content);
    for (const image of prepared.images) zip.file(image.fileName, image.body);
    archive = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
  }
  return { source, pdf: pdf.toString("base64"), archive };
}
