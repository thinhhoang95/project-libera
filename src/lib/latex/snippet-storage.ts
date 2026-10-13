import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { latexSnippetNameError, MAX_LATEX_SNIPPET_LENGTH, MAX_LATEX_SNIPPETS, normalizeLatexSnippetName, normalizeLatexSnippets } from "../../../electron/latex-snippets.cjs";
import { getAdminRoot } from "@/lib/storage/paths";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import type { LatexSnippet } from "./snippets";

export class LatexSnippetError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The desktop app keeps snippets in its config so preferences backups carry
 * them; without one (web mode) they live in the notebook system folder. */
function storage() {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  return configPath
    ? { file: configPath, inConfig: true }
    : { file: path.join(getAdminRoot(), LIBERA_SYSTEM_DIR, "latex-snippets.json"), inConfig: false };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function readLatexSnippets(): Promise<LatexSnippet[]> {
  const { file } = storage();
  return normalizeLatexSnippets((await readJson(file).catch(() => ({} as Record<string, unknown>))).latexSnippets);
}

let queue: Promise<unknown> = Promise.resolve();

/** Read-modify-write under a queue, so concurrent requests never drop a change.
 * The config's other settings are kept as they are. */
function updateLatexSnippets(change: (snippets: LatexSnippet[]) => LatexSnippet[]) {
  const run = queue.then(async () => {
    const { file, inConfig } = storage();
    const stored = await readJson(file);
    const snippets = change(normalizeLatexSnippets(stored.latexSnippets));
    const next = inConfig ? { ...stored, latexSnippets: snippets } : { latexSnippets: snippets };
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return snippets;
  });
  queue = run.catch(() => undefined);
  return run;
}

function checkName(input: unknown, snippets: LatexSnippet[], exceptId?: string) {
  const name = normalizeLatexSnippetName(input);
  const error = latexSnippetNameError(name, snippets, exceptId);
  if (error) throw new LatexSnippetError(error, error.includes("already exists") ? 409 : 400);
  return name;
}

export async function createLatexSnippet(input: { name?: unknown; body?: unknown }) {
  const body = typeof input.body === "string" ? input.body : "";
  if (!body.trim()) throw new LatexSnippetError("Select some LaTeX to save as a snippet.", 400);
  if (body.length > MAX_LATEX_SNIPPET_LENGTH) throw new LatexSnippetError(`A snippet can hold at most ${MAX_LATEX_SNIPPET_LENGTH.toLocaleString("en-US")} characters.`, 400);
  return updateLatexSnippets((snippets) => {
    if (snippets.length >= MAX_LATEX_SNIPPETS) throw new LatexSnippetError(`You can keep at most ${MAX_LATEX_SNIPPETS} snippets. Delete one first.`, 400);
    return [...snippets, { id: randomUUID(), name: checkName(input.name, snippets), body }];
  });
}

export async function renameLatexSnippet(id: string, name: unknown) {
  return updateLatexSnippets((snippets) => {
    if (!snippets.some((snippet) => snippet.id === id)) throw new LatexSnippetError("This snippet no longer exists.", 404);
    const next = checkName(name, snippets, id);
    return snippets.map((snippet) => snippet.id === id ? { ...snippet, name: next } : snippet);
  });
}

export async function deleteLatexSnippet(id: string) {
  return updateLatexSnippets((snippets) => snippets.filter((snippet) => snippet.id !== id));
}
