import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILD_ROOT, latexBuildPaths, runProcess } from "./build";
import { assemblePreviewDocument, previewErrorSummary, type PreviewClass } from "./drawing-preview";
import { resolveLatexEngine, type LatexEngineSetting } from "./project";
import { findTexToolchain, texEnvironment, texExecutable, texLineLengthArguments, texMissingMessage } from "./toolchain";

/* Compiles one drawing for the Visual mode's preview (drawing-preview.ts):
 * the same toolchain, engine choice and sandbox as a normal build (no shell
 * escape, reads and writes kept to the project's and the preview's folders, a
 * minimal environment, arguments passed without a shell), run from the main
 * file's folder so `\input` and `\includegraphics` resolve as they do there.
 * Each document is compiled once: its PDF is kept under the hash of the
 * engine and the document, so an unchanged picture never compiles again. */

export type DrawingPreviewResult =
  | { status: "success"; pdf: Buffer }
  | { status: "error"; message: string }
  | { status: "unavailable"; message: string };

const PREVIEW_ROOT = path.join(BUILD_ROOT, "previews");
const PREVIEW_TIMEOUT_MS = 60_000;
const MAX_PREVIEWS = 120;
export const MAX_PREVIEW_PREAMBLE_CHARACTERS = 1_000_000;
export const MAX_PREVIEW_PICTURE_CHARACTERS = 400_000;

/** One preview compiles at a time, so clicking several does not start a TeX for each at once. */
let queue: Promise<unknown> = Promise.resolve();
function queued<T>(task: () => Promise<T>) {
  const next = queue.catch(() => undefined).then(task);
  queue = next;
  return next;
}

async function prune() {
  const entries = await readdir(PREVIEW_ROOT, { withFileTypes: true }).catch(() => []);
  if (entries.length <= MAX_PREVIEWS) return;
  const dated = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
    name: entry.name, at: (await stat(path.join(PREVIEW_ROOT, entry.name)).catch(() => null))?.mtimeMs ?? 0,
  })));
  dated.sort((left, right) => left.at - right.at);
  for (const old of dated.slice(0, Math.max(0, dated.length - MAX_PREVIEWS))) await rm(path.join(PREVIEW_ROOT, old.name), { recursive: true, force: true });
}

export function compileDrawingPreview(request: { rootPath: string; engine: LatexEngineSetting; preamble: string; picture: string }, signal: AbortSignal): Promise<DrawingPreviewResult> {
  // Validates the path (a .tex file inside the notebooks) before anything runs.
  const paths = latexBuildPaths(request.rootPath);
  return queued(async () => {
    signal.throwIfAborted();
    const toolchain = await findTexToolchain();
    if (!toolchain.binDirectory) return { status: "unavailable", message: texMissingMessage() };
    const engine = resolveLatexEngine(request.preamble, request.engine);
    let firstError: string | null = null;
    // The project's own class first; plain article when that class cannot set a lone picture.
    const attempts: PreviewClass[] = ["own", "article"];
    for (const documentClass of attempts) {
      const document = assemblePreviewDocument(request.preamble, request.picture, documentClass);
      if (documentClass === "article" && document === assemblePreviewDocument(request.preamble, request.picture, "own")) break;
      const key = createHash("sha256").update(`${engine}\u0000${paths.sourceDirectory}\u0000${document}`).digest("hex").slice(0, 32);
      const directory = path.join(PREVIEW_ROOT, key);
      const pdfPath = path.join(directory, "preview.pdf");
      const cached = await readFile(pdfPath).catch(() => null);
      if (cached) return { status: "success", pdf: cached };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const texPath = path.join(directory, "preview.tex");
      await writeFile(texPath, document, "utf8");
      const env = texEnvironment(toolchain, {
        TEXMFOUTPUT: directory,
        openin_any: "p",
        openout_any: "p",
        shell_escape: "f",
      });
      let timedOut = false;
      try {
        const result = await runProcess(texExecutable(toolchain, engine), [
          ...texLineLengthArguments(toolchain), "-interaction=nonstopmode", "-file-line-error", `-output-directory=${directory}`, texPath,
        ], { cwd: paths.sourceDirectory, env, signal, timeoutMs: PREVIEW_TIMEOUT_MS });
        timedOut = result.timedOut;
      } catch (error) {
        signal.throwIfAborted();
        await rm(directory, { recursive: true, force: true });
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        return { status: "unavailable", message: missing ? texMissingMessage() : "The LaTeX compiler could not be started." };
      }
      // A PDF with errors in the log is still the picture as far as TeX could draw it; a timed-out one is not kept.
      const pdf = timedOut ? null : await readFile(pdfPath).catch(() => null);
      const log = await readFile(path.join(directory, "preview.log"), "utf8").catch(() => "");
      if (pdf) { void prune(); return { status: "success", pdf }; }
      firstError ??= timedOut ? "The picture took too long to compile." : previewErrorSummary(log);
      await rm(directory, { recursive: true, force: true });
    }
    return { status: "error", message: firstError ?? "The picture could not be compiled." };
  });
}
