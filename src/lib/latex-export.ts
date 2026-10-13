import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { prepareLatexImages, type LatexImage } from "./latex-images";
import os from "node:os";
import path from "node:path";
import { convertMarkdownToLatex } from "./latex-generation";

export { buildLatexPrompt } from "./latex-generation";

import { DEFAULT_LATEX_OPTIONS, type LatexOptions } from "./latex-options";

function runLatex(executable: string, directory: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "document.tex"], {
      cwd: directory, signal, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      // Do not pass API keys or application secrets to the TeX process.
      env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: directory, TMPDIR: directory, TEXMFOUTPUT: directory,
        openin_any: "p", openout_any: "p", shell_escape: "f" },
    }, (error) => error ? reject(error) : resolve());
  });
}

export async function findPdfLatex(signal: AbortSignal) {
  const candidates = [process.env.LIBERA_PDFLATEX_PATH, "pdflatex", ...(process.platform === "darwin" ? ["/Library/TeX/texbin/pdflatex"] : [])].filter(Boolean) as string[];
  for (const executable of candidates) {
    signal.throwIfAborted();
    const found = await new Promise<boolean>((resolve) => {
      execFile(executable, ["--version"], { signal, timeout: 5000 }, (error) => resolve(!error));
    });
    if (found) return executable;
  }
  throw new Error("pdflatex was not found. Install TeX Live or MiKTeX on the computer running Libera, or set LIBERA_PDFLATEX_PATH, then restart Libera.");
}

export async function compileLatex(source: string, executable: string, signal: AbortSignal, images: LatexImage[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-latex-"));
  try {
    for (const image of images) {
      if (!/^image-\d+\.png$/.test(image.fileName)) throw new Error("Invalid staged image filename.");
      await writeFile(path.join(directory, image.fileName), image.body);
    }
    await writeFile(path.join(directory, "document.tex"), source, "utf8");
    try {
      // A second pass resolves numbering, references and the table of contents.
      await runLatex(executable, directory, signal);
      await runLatex(executable, directory, signal);
    } catch (error) {
      signal.throwIfAborted();
      const log = await readFile(path.join(directory, "document.log"), "utf8").catch(() => "");
      throw new Error(log.slice(-12000) || (error instanceof Error ? error.message : "pdflatex failed."));
    }
    return await readFile(path.join(directory, "document.pdf"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exportLatexPdf(markdown: string, signal: AbortSignal, progress: (message: string) => void, options: LatexOptions = DEFAULT_LATEX_OPTIONS, documentPath = "") {
  progress("Checking pdflatex…");
  const executable = await findPdfLatex(signal);
  progress("Preparing document images…");
  const prepared = await prepareLatexImages(markdown, documentPath, signal);
  const { source, pdf } = await convertMarkdownToLatex(prepared.markdown, signal, progress, {
    options, images: prepared.images, compile: (source) => compileLatex(source, executable, signal, prepared.images),
  });
  let archive: string | undefined;
  if (prepared.images.length) {
    const zip = new JSZip();
    zip.file("document.tex", source);
    for (const image of prepared.images) zip.file(image.fileName, image.body);
    archive = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
  }
  return { source, pdf: pdf.toString("base64"), archive };
}
