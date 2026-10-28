import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import type { ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentPermission } from "../../src/lib/agent/types";
import type { ReviewDocument } from "../../src/lib/markdown-review";
import { updateReferenceLibrary } from "../../src/lib/storage/references";
import { readReviewDocuments } from "../../src/lib/storage/review-files";
import type { CslItem, ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

// Shared by the fact-check tests: a temporary library with a notebook
// "Research", PDFs whose text comes from a seeded text cache (so tests choose
// every page's text), reference entries, and a scripted model.

// A minimal valid PDF; its bytes only identify the file, the text comes from the cache.
export function pdfFixture(text: string) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

export type Library = { root: string; directory: string };

export async function withLibrary(run: (library: Library) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-factcheck-"));
  const saved = { data: process.env.LIBERA_DATA_DIR, key: process.env.OPENROUTER_API_KEY, model: process.env.LIBERA_OPENROUTER_MODEL, online: process.env.LIBERA_REFERENCES_LOOKUP_ONLINE, config: process.env.LIBERA_CONFIG_PATH };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "test/agent-model";
  delete process.env.LIBERA_CONFIG_PATH;
  const root = path.join(directory, "users", "admin");
  try {
    await mkdir(path.join(root, "Research", "papers"), { recursive: true });
    await run({ root, directory });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: saved.data, OPENROUTER_API_KEY: saved.key, LIBERA_OPENROUTER_MODEL: saved.model, LIBERA_REFERENCES_LOOKUP_ONLINE: saved.online, LIBERA_CONFIG_PATH: saved.config })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeText(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

/** A PDF at `file` (e.g. "Research/papers/smith.pdf") whose extracted pages are `pages`. */
export async function writePdf(root: string, file: string, pages: string[]) {
  const bytes = Buffer.from(pdfFixture(file));
  await writeText(root, file, "");
  await writeFile(path.join(root, file), bytes);
  const [notebook, ...rest] = file.split("/");
  const cache = path.join(root, notebook, ".libera", "pdf-text", ...rest.slice(0, -1), `${rest.at(-1)}.json`);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({
    version: 3, pdfContentHash: createHash("sha256").update(bytes).digest("hex"), pdfSize: bytes.length, pageCount: pages.length,
    path: file, pdfUpdatedAt: "", generatedAt: new Date().toISOString(), pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
  }));
}

export function work(key: string, title: string, family: string, year: number, extra: Omit<Partial<ReferenceEntryInput>, "csl"> & { csl?: Partial<CslItem> } = {}): ReferenceEntryInput {
  const { csl, ...rest } = extra;
  return { key, status: "confirmed", ...rest, csl: { type: "article-journal", title, author: [{ family, given: "A." }], issued: { "date-parts": [[year]] }, ...csl } };
}

export async function addWorks(inputs: ReferenceEntryInput[], more: (library: ReferenceLibrary) => ReferenceLibraryOp[] = () => []): Promise<ReferenceLibrary> {
  const library = await updateReferenceLibrary("Research", null, inputs.map((entry) => ({ op: "add" as const, entry })));
  const ops = more(library);
  return ops.length ? updateReferenceLibrary("Research", null, ops) : library;
}

export function entryId(library: ReferenceLibrary, key: string) {
  return Object.values(library.entries).find((entry) => entry.key === key)!.id;
}

export const profile = { contextLength: 200_000, supportsTools: true, known: true };

export function makeContext(permission: AgentPermission = "read-only", patch: Partial<ToolContext> = {}): { context: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission, skills: [], loadedSkills: new Set(), skillState: new Map(), notebook: "Research", notebooks: ["Research"],
    openFiles: new Set(), drafts: new Map(), fileState: new Map(), tasks: [], snapshots: new RunSnapshots("factcheck-run-0001"),
    changed: new Map(), maxResultChars: 60_000, signal: new AbortController().signal, emit: (event) => events.push(event),
    runConfig: { model: "test/agent-model", profile }, budget: { maxInputTokens: 5_000_000, inputTokens: 0 }, usage: { inputTokens: 0, outputTokens: 0 },
    ...patch,
  };
  return { context, events };
}

export async function reviews(root: string): Promise<ReviewDocument[]> {
  return readReviewDocuments<ReviewDocument>(root);
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

export type Call = { id: string; name: string; args: unknown };
export type ModelBody = { model: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

export function reply({ text = "", calls = [], input = 1000 }: { text?: string; calls?: Call[]; input?: number }) {
  const chunks: unknown[] = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  calls.forEach((call, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: input, completion_tokens: 50 } });
  return sse(chunks);
}

/**
 * A fetch that answers model requests with `script(prompt, turn, body)`,
 * where prompt is the run's first user message and turn counts that run's
 * requests; other URLs go to `other` (metadata sources), else 404.
 */
export function scriptedModel(script: (prompt: string, turn: number, body: ModelBody) => Response | Promise<Response>, other?: (url: URL) => Response | Promise<Response> | null) {
  const turns = new Map<string, number>();
  const bodies: ModelBody[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== "openrouter.ai") {
      const answer = other?.(url);
      if (answer) return answer;
      return new Response("{}", { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as ModelBody;
    bodies.push(body);
    const prompt = body.messages.find((message) => message.role === "user")!.content;
    const turn = turns.get(prompt) ?? 0;
    turns.set(prompt, turn + 1);
    return script(prompt, turn, body);
  };
  return bodies;
}

/** The latest tool result in a request, for a scripted model that reacts to it. */
export function lastToolResult(body: ModelBody) {
  return [...body.messages].reverse().find((message) => message.role === "tool")?.content ?? "";
}
