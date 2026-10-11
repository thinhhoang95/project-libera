import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { StorageError } from "@/lib/storage/errors";
import { notebookPathForTexFile, readLatexSnapshot } from "./build";
import { findTexToolchain, texEnvironment, texExecutable } from "./toolchain";

const gunzipAsync = promisify(gunzip);

/** A box in the PDF, in PDF points from the page's top-left corner. */
export type SynctexPdfLocation = { page: number; x: number; y: number; left: number; top: number; width: number; height: number };
export type SynctexSourceLocation = { path: string; line: number; column: number };

function parseResultBlocks(output: string) {
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("SyncTeX result begin")) { current = {}; continue; }
    if (line.startsWith("SyncTeX result end")) break;
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    // Each "Output:" or "Page:" starts a new result record.
    if ((key === "Page" || key === "Output") && current[key] !== undefined) {
      blocks.push(current);
      current = {};
    }
    current[key] = line.slice(separator + 1);
  }
  if (current && Object.keys(current).length) blocks.push(current);
  return blocks;
}

async function runSynctex(args: string[], cwd: string) {
  const toolchain = await findTexToolchain();
  return new Promise<string>((resolve, reject) => {
    execFile(texExecutable(toolchain, "synctex"), args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: texEnvironment(toolchain), windowsHide: true }, (error, stdout) => {
      if (error && !stdout) {
        reject(new StorageError((error as NodeJS.ErrnoException).code === "ENOENT" ? "SyncTeX is not installed with this LaTeX distribution, so jumping between source and PDF is unavailable." : "SyncTeX could not read this build.", 500));
        return;
      }
      resolve(stdout);
    });
  });
}

/** The names SyncTeX recorded for every input file, keyed by notebook path. */
async function recordedInputs(synctexPath: string, meta: Parameters<typeof notebookPathForTexFile>[1]) {
  const data = (await gunzipAsync(await readFile(synctexPath).catch(() => {
    throw new StorageError("This build has no SyncTeX data. Compile again.", 404);
  }))).toString("utf8");
  const inputs = new Map<string, string>();
  for (const match of data.matchAll(/^Input:\d+:(.*)$/gm)) {
    const notebookPath = notebookPathForTexFile(match[1], meta);
    if (notebookPath && !inputs.has(notebookPath)) inputs.set(notebookPath, match[1]);
  }
  return inputs;
}

/** Source line → PDF boxes (forward search). */
export async function synctexForward(rootPath: string, buildId: string, filePath: string, line: number, column: number): Promise<SynctexPdfLocation[]> {
  const snapshot = await readLatexSnapshot(rootPath, buildId);
  const inputs = await recordedInputs(snapshot.synctexPath, snapshot.meta);
  const recorded = inputs.get(filePath);
  if (!recorded) return [];
  const output = await runSynctex(["view", "-i", `${Math.max(1, Math.floor(line))}:${Math.max(0, Math.floor(column))}:${recorded}`, "-o", snapshot.pdfPath], snapshot.directory);
  return parseResultBlocks(output).flatMap((block) => {
    const page = Number(block.Page);
    const values = ["x", "y", "h", "v", "W", "H"].map((key) => Number(block[key]));
    if (!Number.isInteger(page) || page < 1 || values.some((value) => !Number.isFinite(value))) return [];
    const [x, y, h, v, width, height] = values;
    return [{ page, x, y, left: h, top: v - height, width, height }];
  });
}

/** PDF point → source line (inverse search). */
export async function synctexInverse(rootPath: string, buildId: string, page: number, x: number, y: number): Promise<SynctexSourceLocation | null> {
  const snapshot = await readLatexSnapshot(rootPath, buildId);
  const output = await runSynctex(["edit", "-o", `${Math.max(1, Math.floor(page))}:${x.toFixed(2)}:${y.toFixed(2)}:${snapshot.pdfPath}`], snapshot.directory);
  for (const block of parseResultBlocks(output)) {
    const notebookPath = notebookPathForTexFile(block.Input, snapshot.meta);
    const line = Number(block.Line);
    if (notebookPath && Number.isInteger(line) && line > 0) {
      return { path: notebookPath, line, column: Math.max(0, Number(block.Column) || 0) };
    }
  }
  return null;
}
