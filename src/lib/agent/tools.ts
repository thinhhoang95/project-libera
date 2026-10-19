import { notifySearchChanges } from "@/lib/storage/search-updates";
import { assertNotSharedItem, isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { canSuggestShared, readSharedText, requireSharedDoc, SharedWriteError, suggestSharedText } from "@/lib/collab/shared-writes";
import type { ResolvedDoc } from "@/lib/collab/local-api";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { getFileType } from "@/lib/storage/file-types";
import { readFreshPdfTextCache, readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { readTranscript } from "@/lib/storage/transcripts";
import { formatClock, speakerName, transcriptLine } from "@/lib/transcription/format";
import { isTextFileType, type PdfTextPage } from "@/lib/types";
import { globToRegExp } from "./glob";
import { resolveLibraryPath, statLibraryPath, suggestSimilarPath, walkLibraryFiles, type LibraryEntry, type ResolvedPath } from "./library";
import { hashContent, type RunSnapshots } from "./snapshots";
import type { AgentEvent, AgentPermission, AgentTask, AgentTaskStatus } from "./types";
import type { ModelProfile, ToolSchema } from "./model";
import type { TokenUsage } from "@/lib/chat-token-usage";
import { webSearchTool, WEB_SEARCH_TOOL } from "./web-search";
import { referencesTool } from "./references-tool";
import { readCommentsTool } from "./read-comments";

export type FileState = { hash: string; partial: boolean };

/**
 * Input tokens shared by a run and every child run it starts. Each model turn
 * (and each web search) adds to `inputTokens`; nothing new starts once it
 * passes `maxInputTokens`.
 */
export type RunBudget = { maxInputTokens: number; inputTokens: number };

/** How the run calls its model, so tools can start child runs and side requests with the same settings. */
export type AgentRunConfig = {
  model: string;
  profile: ModelProfile;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  promptCaching?: boolean;
};

export type ToolContext = {
  permission: AgentPermission;
  /** Skills the agent may load with the Skill tool; see skills/index.ts. */
  skills: AgentSkill[];
  /** Names of the skills loaded in this run; their tools are offered from the next reply on. */
  loadedSkills: Set<string>;
  /** Per-run working state of loaded skills, by skill name. */
  skillState: Map<string, unknown>;
  /** The notebook the user is working in: Glob and Grep search it by default, and "notebook" permission may write in it. */
  notebook: string | null;
  notebooks: string[];
  /** Library paths of text files open in editor tabs. */
  openFiles: Set<string>;
  /** Unsaved editor drafts by library path. Dropped once the agent writes the file. */
  drafts: Map<string, string>;
  fileState: Map<string, FileState>;
  tasks: AgentTask[];
  snapshots: RunSnapshots;
  changed: Map<string, { created: boolean }>;
  maxResultChars: number;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** The model running this agent, recorded in the provenance of edits to shared files. */
  model?: string;
  /** Shared documents resolved in this run, by library path. */
  sharedDocs?: Map<string, ResolvedDoc>;
  /** The user turned on "Allow web search": WebSearch is offered. */
  allowWebSearch?: boolean;
  /** The run's model settings, for child runs and web searches. */
  runConfig?: AgentRunConfig;
  /** Shared by the run and its child runs. */
  budget?: RunBudget;
  /** Tokens this run used, its own turns included; runAgent sets it, tools add theirs with recordUsage. */
  usage?: TokenUsage;
  /** Set by a tool whose call ends the run (a child's submit tool); the loop stops after the current calls. */
  finishRequested?: boolean;
};

export function addUsage(total: TokenUsage, usage: TokenUsage) {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.cachedTokens !== undefined) total.cachedTokens = (total.cachedTokens ?? 0) + usage.cachedTokens;
}

export function budgetExhausted(context: Pick<ToolContext, "budget">) {
  return !!context.budget && context.budget.inputTokens >= context.budget.maxInputTokens;
}

/**
 * Usage of a request a tool made (a web search, a child run): it counts
 * toward the run's total and budget, and the panel's token count.
 */
export function recordUsage(context: ToolContext, usage: TokenUsage) {
  if (context.usage) addUsage(context.usage, usage);
  if (context.budget) context.budget.inputTokens += usage.inputTokens;
  context.emit({ type: "usage", usage });
}

export type ToolResult = {
  text: string;
  isError: boolean;
  /** One line for the activity list. */
  result: string;
  detail?: string;
};

export type AgentTool = {
  name: string;
  /** "write" changes files; "comment" changes only Libera's review comments. Both run one at a time. */
  kind: "read" | "write" | "comment";
  description: string;
  parameters: Record<string, unknown>;
  /** Plain-language activity line for the UI. */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
};

/**
 * Instructions, and optionally tools, for one kind of job. Only the name and
 * description are in the system prompt; the rest loads when the model asks.
 */
export type AgentSkill = {
  /** Kebab-case name the model passes to the Skill tool. */
  name: string;
  /** When to use the skill, listed in the system prompt. */
  description: string;
  /** Markdown returned by the Skill tool. */
  instructions: string;
  /**
   * Why the skill cannot be used in this run, or null. An unavailable skill
   * is not loaded, so its tools are never offered; the Skill tool returns the
   * reason for the model to pass on.
   */
  unavailable?: (context: ToolContext) => string | null;
  /** Tools offered once the skill is loaded. */
  tools?: AgentTool[];
  /**
   * Runs when the model ends a reply without tool calls, and once more when the
   * run ends. Returns feedback to send back to the model, or null when there is
   * nothing to fix. With `final`, there is no further turn: settle and return null.
   */
  finishPass?: (context: ToolContext, options: { final: boolean }) => Promise<string | null>;
};

export class ToolError extends Error {}

const READ_LINE_LIMIT = 2_000;
const LONG_LINE_LIMIT = 2_000;
const GLOB_LIMIT = 200;
const GREP_DEFAULT_HEAD_LIMIT = 250;
const GREP_TIME_BUDGET_MS = 25_000;
const PDF_EXTRACTION_BUDGET_MS = 12_000;
const PDF_PAGES_PER_READ = 20;

export const ok = (text: string, result: string, detail?: string): ToolResult => ({ text, isError: false, result, ...(detail ? { detail } : {}) });

export function quoted(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ");
  return `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count.toLocaleString("en")} ${count === 1 ? singular : pluralForm}`;
}

function capText(text: string, limit: number, advice: string) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf("\n", limit);
  return `${text.slice(0, cut > limit / 2 ? cut : limit)}\n\n[Output truncated at ${limit.toLocaleString("en")} characters. ${advice}]`;
}

export function preview(text: string, limit = 1_500) {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

export function requireString(args: Record<string, unknown>, name: string, { allowEmpty = false } = {}) {
  const value = args[name];
  if (typeof value !== "string") throw new ToolError(`${name} is required and must be a string.`);
  if (!allowEmpty && !value.trim()) throw new ToolError(`${name} must not be empty.`);
  return value;
}

export function optionalString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`${name} must be a string.`);
  return value;
}

/** Accepts numbers and numeric strings ("10"), a common slip in weaker models. */
export function optionalInteger(args: Record<string, unknown>, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number)) throw new ToolError(`${name} must be a whole number.`);
  if (number < min || number > max) throw new ToolError(`${name} must be between ${min} and ${max}.`);
  return number;
}

function optionalBoolean(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value !== "boolean") throw new ToolError(`${name} must be true or false.`);
  return value;
}

export async function resolve(context: ToolContext, input: string) {
  try {
    return await resolveLibraryPath(input, { defaultNotebook: context.notebook ?? undefined, notebooks: context.notebooks });
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : "Path is invalid.");
  }
}

/** A search root: the current notebook by default, or every notebook for "/". */
async function resolveSearchRoot(context: ToolContext, input: string | undefined): Promise<ResolvedPath | null> {
  const trimmed = input?.trim();
  if (trimmed === "/" || trimmed === "." || trimmed === "*") return null;
  if (!trimmed) return context.notebook ? resolve(context, context.notebook) : null;
  return resolve(context, trimmed);
}

export async function missingFileError(context: ToolContext, resolved: ResolvedPath): Promise<never> {
  const suggestion = await suggestSimilarPath(resolved, context.signal).catch(() => null);
  throw new ToolError(`No file at ${resolved.path}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Use Glob to list files.`);
}

function hasNul(text: string) {
  return text.includes("\u0000");
}

/**
 * What a change to a shared file is (plan M3.4): a suggestion collaborators
 * see at once, attributed to "AI on behalf of" the user, that changes the
 * text only once someone who may decide accepts it.
 */
export const SHARED_SUGGEST_NOTE = "This file is in a shared notebook, so the change is a suggestion, pending review: collaborators see it at once as “AI on behalf of you”, and the file's text stays as it was until someone who can decide accepts it. Keep working from the current text; do not repeat the change.";

function sharedToolError(error: unknown): never {
  if (error instanceof SharedWriteError) throw new ToolError(error.message);
  throw error;
}

/**
 * The shared document behind a library path, or null when the path is not in
 * a shared notebook. Throws a ToolError when it is shared but the host cannot
 * resolve it (collaboration off, host down, file not a shared document).
 */
export async function sharedDocFor(context: ToolContext, resolved: ResolvedPath): Promise<ResolvedDoc | null> {
  if (!isSharedNotebookPath(resolved.path)) return null;
  const cached = context.sharedDocs?.get(resolved.path);
  if (cached) return cached;
  const doc = await requireSharedDoc(resolved.path).catch(sharedToolError);
  context.sharedDocs ??= new Map();
  context.sharedDocs.set(resolved.path, doc);
  return doc;
}

/** The current text of a shared document from the host; null when the host cannot serve it, so the caller reads the working copy. */
async function readSharedCurrent(context: ToolContext, resolved: ResolvedPath): Promise<{ content: string; fromDraft: false; shared: ResolvedDoc } | null> {
  let doc: ResolvedDoc | null;
  try { doc = await sharedDocFor(context, resolved); }
  catch { return null; }
  if (!doc) return null;
  try { return { content: (await readSharedText(resolved.path, { doc })).text, fromDraft: false, shared: doc }; }
  catch { return null; }
}

/**
 * The text the agent should see: an open editor's unsaved draft, else the file on disk.
 * Shared files come from the collab host: the document is newer than its
 * working copy, and editor drafts of shared tabs are only a mirror of it.
 * When the host cannot serve the document, reading falls back to the working
 * copy (a read is harmless); writing then fails with the host's error.
 */
export async function readCurrentText(context: ToolContext, resolved: ResolvedPath): Promise<{ content: string; fromDraft: boolean; shared?: ResolvedDoc } | null> {
  const inShared = isSharedNotebookPath(resolved.path);
  if (inShared && isTextFileType(getFileType(resolved.path) ?? undefined)) {
    const shared = await readSharedCurrent(context, resolved);
    if (shared) {
      if (hasNul(shared.content)) throw new ToolError(`${resolved.path} is a binary file and cannot be read as text.`);
      return shared;
    }
  }
  const draft = inShared ? undefined : context.drafts.get(resolved.path);
  if (draft !== undefined) return { content: draft, fromDraft: true };
  const stats = await statLibraryPath(resolved);
  if (!stats) return null;
  if (stats.isDirectory()) throw new ToolError(`${resolved.path} is a folder. Use Glob with path "${resolved.path}" to list its files.`);
  const fileType = getFileType(resolved.path);
  if (!isTextFileType(fileType ?? undefined)) throw new ToolError(`${resolved.path} is not a text file.`);
  if (stats.size > MAX_TEXT_FILE_BYTES) throw new ToolError(`${resolved.path} is too large to read (${(stats.size / 1024 / 1024).toFixed(1)} MB). Use Grep to search it instead.`);
  const content = await readFile(resolved.absolutePath, "utf8");
  if (hasNul(content)) throw new ToolError(`${resolved.path} is a binary file and cannot be read as text.`);
  return { content, fromDraft: false };
}

export function splitLines(content: string) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function numberLine(number: number, line: string) {
  const text = line.length > LONG_LINE_LIMIT ? `${line.slice(0, LONG_LINE_LIMIT)}… [line truncated]` : line;
  return `${String(number).padStart(6, " ")}\t${text}`;
}

function parsePages(value: string, pageCount: number) {
  const pages = new Set<number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new ToolError(`pages must look like "3", "1-5" or "1,3,5-7"; got "${value}".`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start) throw new ToolError(`Page range "${trimmed}" is invalid.`);
    if (start > pageCount) throw new ToolError(`The PDF has ${plural(pageCount, "page")}; page ${start} does not exist.`);
    for (let page = start; page <= Math.min(end, pageCount); page++) pages.add(page);
  }
  if (!pages.size) throw new ToolError("pages is empty.");
  if (pages.size > PDF_PAGES_PER_READ) throw new ToolError(`Read at most ${PDF_PAGES_PER_READ} PDF pages per call; you asked for ${pages.size}. Split the range.`);
  return [...pages].sort((left, right) => left - right);
}

function describePageRanges(pages: number[]) {
  const ranges: string[] = [];
  for (let index = 0; index < pages.length; index++) {
    const start = pages[index];
    while (pages[index + 1] === pages[index] + 1) index++;
    ranges.push(start === pages[index] ? `${start}` : `${start}-${pages[index]}`);
  }
  return ranges.join(", ");
}

/** A recording reads as its transcript: one line per segment, with its time and speaker. */
async function readAudioTranscript(context: ToolContext, resolved: ResolvedPath) {
  const stats = await statLibraryPath(resolved);
  if (!stats) return missingFileError(context, resolved);
  const { transcript, stale } = await readTranscript(resolved.path);
  if (!transcript) throw new ToolError(`${resolved.path} is a recording without a transcript. Ask the user to transcribe it in the voice memo viewer.`);
  const lines = transcript.segments.map((segment) => {
    const name = speakerName(transcript, segment.speaker);
    return `[${formatClock(segment.start)}]${name ? ` ${name}:` : ""} ${segment.text}`;
  });
  let body = lines.join("\n");
  if (body.length > context.maxResultChars) body = `${body.slice(0, body.lastIndexOf("\n", context.maxResultChars))}\n\n(Transcript cut short.)`;
  const speakers = transcript.speakers.map((speaker) => speaker.name).join(", ");
  const header = `Transcript of ${resolved.path} (${formatClock(transcript.audio.duration)}${speakers ? `; ${speakers}` : ""})${stale ? ". The recording changed after it was transcribed." : ""}. Link to a moment as [3:05](${resolved.path.split("/").map(encodeURIComponent).join("/")}#t=185), the time in seconds.`;
  return ok(`${header}\n\n${body}`, `${plural(lines.length, "segment")}`);
}

async function readPdf(context: ToolContext, resolved: ResolvedPath, pagesArgument: string | undefined) {
  let pages: PdfTextPage[];
  try { pages = (await readPdfTextCache(resolved.path)).pages; }
  catch (error) { throw new ToolError(`Could not extract text from ${resolved.path}: ${error instanceof Error ? error.message : "unknown error"}.`); }
  if (!pages.length) return ok(`${resolved.path} has no pages.`, "Empty PDF");
  if (!pages.some((page) => page.text.trim())) {
    return ok(`${resolved.path} has ${plural(pages.length, "page")} but no extractable text. It is probably scanned images; its content cannot be read as text.`, "No text layer");
  }
  let selected: number[];
  if (pagesArgument) selected = parsePages(pagesArgument, pages.length);
  else {
    // Without pages, show the opening pages that fit, and say how to get the rest.
    selected = [];
    let size = 0;
    const budget = Math.min(context.maxResultChars, 40_000) - 2_000;
    for (const page of pages) {
      if (selected.length >= PDF_PAGES_PER_READ || (selected.length && size + page.text.length > budget)) break;
      selected.push(page.pageNumber);
      size += page.text.length;
    }
  }
  const byNumber = new Map(pages.map((page) => [page.pageNumber, page.text]));
  const body = selected.map((number) => {
    const text = byNumber.get(number)?.trim();
    return `--- Page ${number} ---\n${text || "(No extractable text on this page; it may be an image.)"}`;
  }).join("\n\n");
  const next = selected.at(-1)! + 1;
  const footer = !pagesArgument && next <= pages.length
    ? `\n\n(Showing page${selected.length === 1 ? "" : "s"} ${describePageRanges(selected)} of ${pages.length}. Read other pages with pages, e.g. "${next}-${Math.min(pages.length, next + PDF_PAGES_PER_READ - 1)}", or Grep the PDF for a passage.)`
    : "";
  // Cap the pages, never the note on how to read the rest.
  const text = `${capText(`PDF ${resolved.path}: ${plural(pages.length, "page")}, text extracted from the PDF.\n\n${body}`, context.maxResultChars - footer.length, "Read fewer pages at a time.")}${footer}`;
  return ok(text, `Pages ${describePageRanges(selected)} of ${pages.length}`, preview(body));
}

const readTool: AgentTool = {
  name: "Read",
  kind: "read",
  description: `Reads a file from the user's library and returns its contents.

Usage:
- file_path is a library path such as "Research/notes/plan.md" (the first segment is the notebook or linked folder). A path without a notebook, such as "notes/plan.md", is read from the current notebook.
- Text files (Markdown, LaTeX, plain text, code) come back in cat -n format: line number, a tab, then the line. Line numbers are for reference only; they are not part of the file. Never include them in Edit's old_string.
- By default up to ${READ_LINE_LIMIT} lines are returned from the start of the file. For long files, use offset (1-based line number to start from) and limit (number of lines) to read a window. Lines longer than ${LONG_LINE_LIMIT} characters are truncated.
- If a file is open in the user's editor with unsaved changes, you see the unsaved version, which is what the user sees.
- PDFs: you get the PDF's extracted text, page by page; the PDF file itself is never loaded. Use pages to choose pages, e.g. "1-5" or "3,7", at most ${PDF_PAGES_PER_READ} pages per call. Without pages you get the opening pages that fit and a note on how many pages exist. To find where something is in a long PDF, Grep it first, then Read the matching pages.
- Images cannot be read.
- You must Read a text file before you Edit or overwrite it.
- To find files, use Glob or Grep instead of guessing paths. Read several files at once by making several Read calls in one reply.`,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Library path of the file, e.g. \"Research/notes/plan.md\"." },
      offset: { type: "integer", description: "1-based line number to start reading from. Only for long text files." },
      limit: { type: "integer", description: `Number of lines to read (default ${READ_LINE_LIMIT}).` },
      pages: { type: "string", description: `PDF only: pages to read, e.g. "1-5" or "2,4". At most ${PDF_PAGES_PER_READ} pages.` },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  describe: (args) => `Reading ${String(args.file_path ?? "a file")}${args.pages ? ` (pages ${String(args.pages)})` : ""}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "file_path"));
    const fileType = getFileType(resolved.path);
    if (fileType === "pdf") {
      const stats = await statLibraryPath(resolved);
      if (!stats) return missingFileError(context, resolved);
      return readPdf(context, resolved, optionalString(args, "pages"));
    }
    if (fileType === "image") throw new ToolError(`${resolved.path} is an image; Read cannot show images.`);
    if (fileType === "audio") return readAudioTranscript(context, resolved);
    const current = await readCurrentText(context, resolved);
    if (!current) return missingFileError(context, resolved);
    const lines = splitLines(current.content);
    if (!current.content.length) {
      context.fileState.set(resolved.path, { hash: hashContent(current.content), partial: false });
      return ok(`${resolved.path} exists but is empty.`, "Empty file");
    }
    const offset = optionalInteger(args, "offset", { min: 1 }) ?? 1;
    const limit = optionalInteger(args, "limit", { min: 1 }) ?? READ_LINE_LIMIT;
    if (offset > lines.length) throw new ToolError(`${resolved.path} has ${plural(lines.length, "line")}; offset ${offset} is past the end.`);
    const end = Math.min(lines.length, offset - 1 + limit);
    let body = lines.slice(offset - 1, end).map((line, index) => numberLine(offset + index, line)).join("\n");
    let shownEnd = end;
    if (body.length > context.maxResultChars) {
      // Cut on a line boundary and report the last full line shown.
      body = body.slice(0, body.lastIndexOf("\n", context.maxResultChars));
      shownEnd = offset - 1 + body.split("\n").length;
    }
    const partial = offset > 1 || shownEnd < lines.length;
    context.fileState.set(resolved.path, { hash: hashContent(current.content), partial });
    const notes = [
      partial ? `(Showing lines ${offset}-${shownEnd} of ${lines.length}. Use offset and limit to read more.)` : "",
      current.fromDraft ? "(This file is open in the editor with unsaved changes; you are reading the unsaved version.)" : "",
      current.shared ? `(This file is in a shared notebook; you are reading the live shared document. Collaborators may change it while you work.${canSuggestShared(current.shared) ? " Your Edit and Write become suggestions, attributed to “AI on behalf of” the user, that others accept or reject; the text changes only when one is accepted." : ` The user's role (${current.shared.role}) cannot change or suggest changes to it.`})` : "",
    ].filter(Boolean).join("\n");
    return ok(notes ? `${body}\n\n${notes}` : body, partial ? `Lines ${offset}-${shownEnd} of ${lines.length}` : plural(lines.length, "line"));
  },
};

const globTool: AgentTool = {
  name: "Glob",
  kind: "read",
  description: `Finds files by name pattern. Returns library paths, most recently modified first.

Usage:
- Patterns: "**/*.md" (all Markdown files), "projects/**/meeting-*.md", "*.{tex,bib}", "**/*budget*". A pattern without "/" matches file names in any folder, so "*.pdf" finds every PDF.
- path is the folder to search: a notebook name ("Research"), a folder ("Research/projects"), or "/" for every notebook in the library. Without path, the current notebook is searched.
- Hidden folders, the _assets folder and the _archive folder are skipped unless path points inside them.
- At most ${GLOB_LIMIT} paths are returned; narrow the pattern or path when there are more.
- Use Glob to discover what exists before reading. To search file contents, use Grep.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. \"**/*.md\"." },
      path: { type: "string", description: "Folder to search: a notebook, a folder in it, or \"/\" for the whole library. Defaults to the current notebook." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  describe: (args) => `Finding files matching ${quoted(args.pattern)}${args.path ? ` in ${String(args.path)}` : ""}`,
  async run(args, context) {
    let pattern = requireString(args, "pattern").trim();
    const root = await resolveSearchRoot(context, optionalString(args, "path"));
    if (root) {
      const stats = await statLibraryPath(root);
      if (!stats) return missingFileError(context, root);
      if (!stats.isDirectory()) throw new ToolError(`${root.path} is a file, not a folder. Use Read to read it.`);
      // Models often repeat the notebook in the pattern; match it relative to the root.
      if (pattern.toLowerCase().startsWith(`${root.path.toLowerCase()}/`)) pattern = pattern.slice(root.path.length + 1);
    }
    let matcher: RegExp;
    try { matcher = globToRegExp(pattern); }
    catch { throw new ToolError(`"${pattern}" is not a valid glob pattern.`); }
    const matches: LibraryEntry[] = [];
    for await (const entry of walkLibraryFiles(root, context.signal)) {
      const relative = root ? entry.path.slice(root.path.length + 1) : entry.path;
      if (matcher.test(relative)) matches.push(entry);
    }
    const where = root ? root.path : "the library";
    if (!matches.length) return ok(`No files matched "${pattern}" in ${where}.`, "No matches");
    matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const shown = matches.slice(0, GLOB_LIMIT).map((entry) => entry.path);
    const footer = matches.length > GLOB_LIMIT ? `\n\n(Showing ${GLOB_LIMIT} of ${matches.length.toLocaleString("en")} matches; narrow the pattern or path.)` : "";
    return ok(`${shown.join("\n")}${footer}`, plural(matches.length, "file"), preview(shown.join("\n")));
  },
};

type GrepOptions = {
  regex: RegExp;
  multiline: boolean;
  mode: "content" | "files_with_matches" | "count";
  lineNumbers: boolean;
  before: number;
  after: number;
};

type GrepHit = { path: string; mtimeMs: number; count: number; lines: string[] };

function clipLine(line: string, regex: RegExp) {
  if (line.length <= 500) return line;
  regex.lastIndex = 0;
  const match = regex.exec(line);
  const start = Math.max(0, (match?.index ?? 0) - 200);
  return `${start ? "…" : ""}${line.slice(start, start + 500)}…`;
}

/** Lines of one text (a file, or one PDF page) that match, with context. `label` prefixes each line. */
function grepText(text: string, label: string, options: GrepOptions): { count: number; lines: string[] } {
  const lines = text.split(/\r?\n/);
  const matched = new Set<number>();
  let count = 0;
  if (options.multiline) {
    const offsets = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === "\n") offsets.push(index + 1);
    const lineAt = (offset: number) => {
      let low = 0;
      let high = offsets.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (offsets[middle] <= offset) low = middle; else high = middle - 1;
      }
      return low;
    };
    const regex = new RegExp(options.regex.source, `${options.regex.flags.replace("g", "")}g`);
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      count++;
      const first = lineAt(match.index);
      const last = lineAt(match.index + Math.max(0, match[0].length - 1));
      for (let line = first; line <= last; line++) matched.add(line);
      if (!match[0].length) regex.lastIndex++;
      if (count > 10_000) break;
    }
  } else {
    lines.forEach((line, index) => {
      options.regex.lastIndex = 0;
      if (options.regex.test(line)) { matched.add(index); count++; }
    });
  }
  if (!count || options.mode !== "content") return { count, lines: [] };
  const shown = new Set<number>();
  for (const index of matched) {
    for (let line = Math.max(0, index - options.before); line <= Math.min(lines.length - 1, index + options.after); line++) shown.add(line);
  }
  const output: string[] = [];
  let previous = -2;
  for (const index of [...shown].sort((left, right) => left - right)) {
    if (previous >= 0 && index !== previous + 1 && (options.before || options.after)) output.push("--");
    const separator = matched.has(index) ? ":" : "-";
    output.push(`${label}${options.lineNumbers ? `${separator}${index + 1}` : ""}${separator}${clipLine(lines[index], options.regex)}`);
    previous = index;
  }
  return { count, lines: output };
}

const grepTool: AgentTool = {
  name: "Grep",
  kind: "read",
  description: `Searches file contents with a regular expression, across Markdown, LaTeX, plain-text files, the extracted text of PDFs, and the transcripts of voice memos (recordings).

Usage:
- pattern is a JavaScript regular expression, e.g. "budget", "Q[34] (report|review)", "\\\\[\\\\[Project Atlas". Escape regex characters to match them literally. Set -i for case-insensitive search.
- path is a folder or a single file: a notebook name, a folder, a file, or "/" for every notebook in the library. Without path, the current notebook is searched.
- glob filters files by name, e.g. "*.md" or "**/meetings/*.md".
- output_mode:
  - "files_with_matches" (default): paths of files that match, most recently modified first.
  - "content": the matching lines as "path:line number:text" (PDF lines as "path:page N:text"; transcript lines as "path:[m:ss] Speaker: text"). Add context lines with -A (after), -B (before) or -C (both). -n (line numbers) is on by default.
  - "count": the number of matches per file.
- head_limit caps the output entries (default ${GREP_DEFAULT_HEAD_LIMIT}); use offset to page through more.
- multiline: true lets patterns span lines ("." also matches newlines).
- PDFs are searched through their extracted text. PDFs whose text has never been extracted are extracted on the fly within a time budget; any left out are reported.
- Recordings (.m4a, .mp3, .wav, …) are searched through their transcripts, one line per passage with its time and speaker, so a pattern like "Vy:.*budget" finds what Vy said about the budget. Recordings without a transcript are skipped.
- Prefer Grep over reading many files to find where something is mentioned. For a PDF hit, Read the PDF with pages set to that page; for a recording, Read it for the whole transcript.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or folder to search, or \"/\" for the whole library. Defaults to the current notebook." },
      glob: { type: "string", description: "Only search files whose path matches this glob, e.g. \"*.md\"." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Default \"files_with_matches\"." },
      "-i": { type: "boolean", description: "Case-insensitive search." },
      "-n": { type: "boolean", description: "Show line numbers in content mode (default true)." },
      "-A": { type: "integer", description: "Lines of context after each match (content mode)." },
      "-B": { type: "integer", description: "Lines of context before each match (content mode)." },
      "-C": { type: "integer", description: "Lines of context before and after each match (content mode)." },
      head_limit: { type: "integer", description: `Maximum entries to return (default ${GREP_DEFAULT_HEAD_LIMIT}).` },
      offset: { type: "integer", description: "Skip this many entries first, to page through results." },
      multiline: { type: "boolean", description: "Allow matches across lines." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  describe: (args) => `Searching for ${quoted(args.pattern)}${args.path ? ` in ${String(args.path)}` : ""}`,
  async run(args, context) {
    let pattern = requireString(args, "pattern");
    let caseInsensitive = optionalBoolean(args, "-i") ?? false;
    // ripgrep-style inline flag.
    if (pattern.startsWith("(?i)")) { pattern = pattern.slice(4); caseInsensitive = true; }
    const multiline = optionalBoolean(args, "multiline") ?? false;
    let regex: RegExp;
    try { regex = new RegExp(pattern, `${caseInsensitive ? "i" : ""}${multiline ? "ms" : ""}u`); }
    catch {
      try { regex = new RegExp(pattern, `${caseInsensitive ? "i" : ""}${multiline ? "ms" : ""}`); }
      catch (error) { throw new ToolError(`Invalid regular expression: ${error instanceof Error ? error.message : pattern}. Escape characters such as ( [ { . * + ? with a backslash to match them literally.`); }
    }
    const modeValue = optionalString(args, "output_mode") ?? "files_with_matches";
    if (modeValue !== "content" && modeValue !== "files_with_matches" && modeValue !== "count") throw new ToolError("output_mode must be \"content\", \"files_with_matches\" or \"count\".");
    const contextLines = optionalInteger(args, "-C", { max: 20 }) ?? 0;
    const options: GrepOptions = {
      regex, multiline, mode: modeValue,
      lineNumbers: optionalBoolean(args, "-n") ?? true,
      before: optionalInteger(args, "-B", { max: 20 }) ?? contextLines,
      after: optionalInteger(args, "-A", { max: 20 }) ?? contextLines,
    };
    const headLimit = optionalInteger(args, "head_limit", { min: 1, max: 5_000 }) ?? GREP_DEFAULT_HEAD_LIMIT;
    const offset = optionalInteger(args, "offset") ?? 0;
    const globPattern = optionalString(args, "glob");
    let globMatcher: RegExp | undefined;
    try { globMatcher = globPattern ? globToRegExp(globPattern) : undefined; }
    catch { throw new ToolError(`"${globPattern}" is not a valid glob.`); }

    const root = await resolveSearchRoot(context, optionalString(args, "path"));
    const stats = root ? await statLibraryPath(root) : null;
    if (root && !stats) return missingFileError(context, root);
    const files: LibraryEntry[] = [];
    if (root && stats?.isFile()) {
      const fileType = getFileType(root.path);
      if (!fileType) throw new ToolError(`${root.path} is not a supported file type.`);
      files.push({ path: root.path, absolutePath: root.absolutePath, fileType, size: stats.size, mtimeMs: stats.mtimeMs });
    } else {
      for await (const entry of walkLibraryFiles(root, context.signal)) {
        const relative = root ? entry.path.slice(root.path.length + 1) : entry.path;
        if (globMatcher && !globMatcher.test(relative)) continue;
        if (entry.fileType === "image") continue;
        files.push(entry);
      }
    }

    const started = Date.now();
    let extractionTime = 0;
    let unsearchedPdfs = 0;
    let unreadable = 0;
    let untranscribed = 0;
    let timedOut = false;
    const hits: GrepHit[] = [];
    const uncachedPdfs: LibraryEntry[] = [];
    const searchPdf = (entry: LibraryEntry, pages: PdfTextPage[]) => {
      const hit: GrepHit = { path: entry.path, mtimeMs: entry.mtimeMs, count: 0, lines: [] };
      for (const page of pages) {
        const result = grepText(page.text, `${entry.path}:page ${page.pageNumber}`, { ...options, lineNumbers: false });
        hit.count += result.count;
        hit.lines.push(...result.lines);
      }
      if (hit.count) hits.push(hit);
    };
    for (const entry of files) {
      context.signal.throwIfAborted();
      if (Date.now() - started > GREP_TIME_BUDGET_MS) { timedOut = true; break; }
      if (entry.fileType === "pdf") {
        const cached = await readFreshPdfTextCache(entry.path).catch(() => null);
        if (cached) searchPdf(entry, cached.pages); else uncachedPdfs.push(entry);
        continue;
      }
      // A recording is searched through its transcript, never its audio.
      if (entry.fileType === "audio") {
        const { transcript, stale } = await readTranscript(entry.path).catch(() => ({ transcript: null, stale: false }));
        if (!transcript || stale) { untranscribed++; continue; }
        const text = transcript.segments.map((segment) => transcriptLine(transcript, segment)).join("\n");
        const result = grepText(text, entry.path, { ...options, lineNumbers: false });
        if (result.count) hits.push({ path: entry.path, mtimeMs: entry.mtimeMs, count: result.count, lines: result.lines });
        continue;
      }
      let content = context.drafts.get(entry.path);
      if (content === undefined) {
        if (entry.size > MAX_TEXT_FILE_BYTES) { unreadable++; continue; }
        try { content = await readFile(entry.absolutePath, "utf8"); }
        catch { unreadable++; continue; }
        if (hasNul(content)) continue;
      }
      const result = grepText(content, entry.path, options);
      if (result.count) hits.push({ path: entry.path, mtimeMs: entry.mtimeMs, count: result.count, lines: result.lines });
    }
    for (const entry of uncachedPdfs) {
      if (timedOut || extractionTime > PDF_EXTRACTION_BUDGET_MS) { unsearchedPdfs++; continue; }
      context.signal.throwIfAborted();
      const extractionStarted = Date.now();
      try { searchPdf(entry, (await readPdfTextCache(entry.path)).pages); }
      catch { unreadable++; }
      extractionTime += Date.now() - extractionStarted;
    }

    hits.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const totalMatches = hits.reduce((sum, hit) => sum + hit.count, 0);
    const entries = options.mode === "files_with_matches" ? hits.map((hit) => hit.path)
      : options.mode === "count" ? hits.map((hit) => `${hit.path}:${hit.count}`)
      : hits.flatMap((hit) => hit.lines);
    const notes: string[] = [];
    if (unsearchedPdfs) notes.push(`${plural(unsearchedPdfs, "PDF")} were not searched because their text has not been extracted yet. Read one (or Grep it by path) to extract it.`);
    if (timedOut) notes.push("The search stopped early because it took too long; narrow the path or glob.");
    if (unreadable) notes.push(`${plural(unreadable, "file")} could not be read.`);
    if (untranscribed) notes.push(`${plural(untranscribed, "recording")} had no transcript to search.`);
    const where = root ? root.path : "the library";
    if (!entries.length) {
      return ok([`No matches for ${JSON.stringify(pattern)} in ${where}.`, ...notes].join("\n"), "No matches");
    }
    const page = entries.slice(offset, offset + headLimit);
    if (offset && !page.length) throw new ToolError(`offset ${offset} is past the end; there are ${entries.length} entries.`);
    if (offset + page.length < entries.length) notes.unshift(`(Showing entries ${offset + 1}-${offset + page.length} of ${entries.length.toLocaleString("en")}. Use offset to see more, or narrow the pattern, path or glob.)`);
    const text = capText([page.join("\n"), ...notes].join("\n\n"), context.maxResultChars, "Narrow the pattern, path or glob, or lower head_limit.");
    const result = options.mode === "files_with_matches" ? `${plural(hits.length, "file")}` : `${plural(totalMatches, "match", "matches")} in ${plural(hits.length, "file")}`;
    return ok(text, result, preview(page.join("\n")));
  },
};

export function lineOfOffset(content: string, offset: number) {
  let line = 1;
  for (let index = content.indexOf("\n"); index !== -1 && index < offset; index = content.indexOf("\n", index + 1)) line++;
  return line;
}

function snippetAround(content: string, start: number, end: number) {
  const lines = splitLines(content);
  const first = Math.max(1, lineOfOffset(content, start) - 3);
  const last = Math.min(lines.length, lineOfOffset(content, end) + 3, first + 40);
  return lines.slice(first - 1, last).map((line, index) => numberLine(first + index, line)).join("\n");
}

function countOccurrences(content: string, search: string) {
  const positions: number[] = [];
  for (let index = content.indexOf(search); index !== -1; index = content.indexOf(search, index + search.length)) {
    positions.push(index);
    if (positions.length > 1000) break;
  }
  return positions;
}

const LINE_NUMBER_PREFIX = /^\s*\d+\t/;

function stripLineNumbers(text: string) {
  const lines = text.split("\n");
  const numbered = lines.filter((line) => line.length);
  if (!numbered.length || !numbered.every((line) => LINE_NUMBER_PREFIX.test(line))) return null;
  return lines.map((line) => line.replace(LINE_NUMBER_PREFIX, "")).join("\n");
}

export function normalizeQuotes(text: string) {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, "\"");
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Match = { index: number; length: number };

/**
 * Find old_string in content, forgiving the usual model slips: pasted Read
 * line numbers, LF versus CRLF, curly versus straight quotes, and trailing
 * whitespace. Returns the matches and the strings to use.
 */
export function findEditTarget(content: string, oldString: string, newString: string): { matches: Match[]; oldString: string; newString: string; note?: string } {
  const exact = countOccurrences(content, oldString);
  if (exact.length) return { matches: exact.map((index) => ({ index, length: oldString.length })), oldString, newString };
  const crlf = content.includes("\r\n");
  const candidates: { old: string; next: string; note?: string }[] = [];
  const stripped = stripLineNumbers(oldString);
  if (stripped !== null) candidates.push({ old: stripped, next: stripLineNumbers(newString) ?? newString, note: "Removed Read line-number prefixes from old_string." });
  for (const candidate of [{ old: oldString, next: newString }, ...candidates]) {
    if (crlf && !candidate.old.includes("\r\n")) {
      candidates.push({ old: candidate.old.replace(/\n/g, "\r\n"), next: candidate.next.replace(/\r?\n/g, "\r\n"), note: candidate.note });
    }
  }
  for (const candidate of candidates) {
    const found = countOccurrences(content, candidate.old);
    if (found.length) return { matches: found.map((index) => ({ index, length: candidate.old.length })), oldString: candidate.old, newString: candidate.next, note: candidate.note };
  }
  // Quote normalization keeps offsets, so matches map straight back to the file.
  const normalizedContent = normalizeQuotes(content);
  for (const candidate of [{ old: oldString, next: newString }, ...candidates]) {
    const found = countOccurrences(normalizedContent, normalizeQuotes(candidate.old));
    if (found.length) return { matches: found.map((index) => ({ index, length: candidate.old.length })), oldString: candidate.old, newString: candidate.next, note: "Matched after treating curly and straight quotes alike." };
  }
  // Tolerate trailing whitespace differences at line ends.
  for (const candidate of [{ old: oldString, next: newString }, ...candidates]) {
    const lines = candidate.old.replace(/\r\n/g, "\n").split("\n");
    if (lines.length < 2 && !/[ \t]$/.test(candidate.old)) continue;
    const pattern = new RegExp(lines.map((line) => escapeRegex(line.replace(/[ \t]+$/, ""))).join("[ \\t]*\\r?\\n") + (lines.length > 1 ? "" : "[ \\t]*"), "g");
    const found: Match[] = [];
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      found.push({ index: match.index, length: match[0].length });
      if (!match[0].length) pattern.lastIndex++;
    }
    if (found.length) return { matches: found, oldString: candidate.old, newString: crlf ? candidate.next.replace(/\r?\n/g, "\r\n") : candidate.next, note: "Matched after ignoring trailing whitespace." };
  }
  return { matches: [], oldString, newString };
}

export function closestLines(content: string, oldString: string) {
  const firstLine = oldString.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "";
  const lines = splitLines(content);
  const needle = firstLine.toLowerCase();
  const scored = lines.map((line, index) => {
    const value = line.trim().toLowerCase();
    let prefix = 0;
    while (prefix < value.length && prefix < needle.length && value[prefix] === needle[prefix]) prefix++;
    const score = value.includes(needle) || (needle.includes(value) && value.length > 8) ? 1000 + value.length : prefix;
    return { index, score };
  }).filter((item) => item.score >= Math.min(12, needle.length)).sort((left, right) => right.score - left.score).slice(0, 3);
  if (!scored.length) return "";
  return `\nThe closest lines in the file are:\n${scored.map(({ index }) => numberLine(index + 1, lines[index])).join("\n")}`;
}

function assertWritable(context: ToolContext, resolved: ResolvedPath, { creating }: { creating: boolean }) {
  if (context.permission === "read-only") throw new ToolError("You are in Read Only mode and cannot change files. Describe the change to the user instead.");
  const fileType = getFileType(resolved.path);
  if (!isTextFileType(fileType ?? undefined)) {
    throw new ToolError(`${resolved.path} cannot be written: only Markdown (.md), LaTeX (.tex, .bib) and plain-text files can be edited.`);
  }
  if (resolved.pathParts[0] === ARCHIVE_DIR) throw new ToolError("Files in the _archive folder cannot be changed.");
  if (isSharedNotebookPath(resolved.path) && creating) {
    // Changes to shared files are suggestions on existing documents; a new
    // file would need a manifest suggestion, which does not exist yet.
    throw new ToolError(`${resolved.path} would be a new file in a shared notebook, and the agent cannot create files there: its changes to shared files are suggestions others review. Suggest the content in an existing file, or give it to the user in your reply.`);
  }
  if (context.permission === "open-files") {
    if (creating) throw new ToolError("You can only modify files that are open in the editor, so you cannot create new files. Tell the user what file you would create, or ask them to switch the permission to \"Modify all files in Notebook/Folder\".");
    if (!context.openFiles.has(resolved.path)) {
      const open = [...context.openFiles];
      throw new ToolError(`You can only modify files that are open in the editor${open.length ? `: ${open.join(", ")}` : " (none are open)"}. ${resolved.path} is not open. Ask the user to open it, or describe the change instead.`);
    }
  }
  if (context.permission === "notebook" && resolved.notebook !== context.notebook) {
    throw new ToolError(`You can only modify files in the notebook "${context.notebook}". ${resolved.path} is outside it.`);
  }
}

/**
 * Refuses a change the user's role in a shared notebook does not allow;
 * returns the document. Changes there are suggestions, so commenters may
 * use the agent too; viewers and revoked notebooks may not.
 */
async function assertSharedWritable(context: ToolContext, resolved: ResolvedPath): Promise<ResolvedDoc | null> {
  const doc = await sharedDocFor(context, resolved);
  if (!doc) return null;
  if (!canSuggestShared(doc)) {
    throw new ToolError(doc.revoked || doc.role !== "viewer"
      ? `${resolved.path} is read-only: access to its shared notebook was revoked. Describe the change to the user instead.`
      : `Your role in this shared notebook (${doc.role}) cannot change or suggest changes to ${resolved.path}, so the agent cannot either. Describe the change to the user instead.`);
  }
  return doc;
}

/** What suggesting a change to a shared file produced, for the tool's result text. */
export type SharedSuggestion = { suggestionIds: string[]; staleCount: number };

/**
 * A change to a shared document: overlay suggestions through the host,
 * acting for the user (plan M3.4). The edits are made on `previous`, the text
 * the agent read, so a collaborator's edit elsewhere only moves them, and a
 * passage changed meanwhile is suggested as stale (what the agent saw next
 * to what is there now). The document's text does not change.
 */
async function suggestSharedAgentFile(context: ToolContext, resolved: ResolvedPath, doc: ResolvedDoc, content: string, previous: { content: string | null }): Promise<SharedSuggestion> {
  const before = previous.content ?? "";
  const result = await suggestSharedText(resolved.path, before, content, {
    feature: "agent",
    ...(context.model ? { model: context.model } : {}),
    runId: context.snapshots.runId,
    title: "AI Agent",
  }, { doc }).catch(sharedToolError);
  if (!context.snapshots.has(resolved.path)) await context.snapshots.recordOriginal(resolved.path, before, undefined, { docId: doc.docId, mode: "suggest" });
  await context.snapshots.recordSuggestions(resolved.path, result.suggestionIds);
  // The text is what it was: the next Edit works on it without a new Read,
  // unless a collaborator's edit made part of this one stale.
  if (result.staleCount) context.fileState.delete(resolved.path);
  else context.fileState.set(resolved.path, { hash: hashContent(result.text), partial: false });
  context.changed.set(resolved.path, { created: false });
  context.emit({ type: "file_changed", path: resolved.path, created: false, shared: true, suggested: true });
  return { suggestionIds: result.suggestionIds, staleCount: result.staleCount };
}

/** The tool result's lines about a suggestion on a shared file. */
function suggestionNote(resolved: ResolvedPath, suggestion: SharedSuggestion): string {
  const ids = suggestion.suggestionIds;
  const stale = suggestion.staleCount ? ` ${plural(suggestion.staleCount, "part")} of it ${suggestion.staleCount === 1 ? "is" : "are"} stale because a collaborator changed that text since you read it; Read the file again before suggesting more there.` : "";
  return `Suggested a change to ${resolved.path}: suggested, pending review (${plural(ids.length, "suggestion")}: ${ids.join(", ")}).${stale}\n${SHARED_SUGGEST_NOTE}`;
}

async function writeAgentFile(context: ToolContext, resolved: ResolvedPath, content: string, previous: { content: string | null; fromDraft: boolean; shared?: ResolvedDoc }): Promise<SharedSuggestion | null> {
  const shared = previous.shared ?? await assertSharedWritable(context, resolved);
  if (shared) return suggestSharedAgentFile(context, resolved, shared, content, previous);
  // A notebook shared since the check: writing here would bypass the host
  // and lose attribution (SharedDocumentError, 409 shared-document).
  assertNotSharedItem(resolved.notebook, resolved.pathParts);
  if (!context.snapshots.has(resolved.path)) {
    // Keep what was on disk (and any unsaved draft the agent built on) for undo.
    let disk: string | null = previous.fromDraft ? null : previous.content;
    if (previous.fromDraft) {
      try { disk = await readFile(resolved.absolutePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await context.snapshots.recordOriginal(resolved.path, disk, previous.fromDraft ? previous.content ?? undefined : undefined);
  }
  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, content, "utf8");
  notifySearchChanges([resolved.path]);
  await context.snapshots.recordWritten(resolved.path, content);
  context.drafts.delete(resolved.path);
  context.fileState.set(resolved.path, { hash: hashContent(content), partial: false });
  const created = context.changed.get(resolved.path)?.created ?? previous.content === null;
  context.changed.set(resolved.path, { created });
  context.emit({ type: "file_changed", path: resolved.path, created });
  return null;
}

const editTool: AgentTool = {
  name: "Edit",
  kind: "write",
  description: `Replaces exact text in a file. This is the way to change existing notes.

Usage:
- You must Read the file in this conversation before editing it. If the file changed since you read it, Read it again.
- old_string must match the file exactly, including whitespace and indentation, and must not include Read's line-number prefixes (the number and tab at the start of each line).
- old_string must occur exactly once in the file. If it occurs several times, add surrounding lines to make it unique, or set replace_all to true to change every occurrence (useful for renaming a term or tag throughout a file).
- new_string replaces it and must differ from old_string. To delete text, use an empty new_string.
- Make the smallest edit that does the job; keep the note's existing formatting and style. To insert text, include a nearby line in old_string and repeat it in new_string with the new text added.
- The result shows the edited region with line numbers, so you can check it without reading the file again.`,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Library path of the file to edit." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_string (default false)." },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  describe: (args) => `Editing ${String(args.file_path ?? "a file")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "file_path"));
    const oldString = requireString(args, "old_string", { allowEmpty: true });
    const newString = requireString(args, "new_string", { allowEmpty: true });
    const replaceAll = optionalBoolean(args, "replace_all") ?? false;
    assertWritable(context, resolved, { creating: false });
    const sharedDoc = await assertSharedWritable(context, resolved);
    const current = await readCurrentText(context, resolved);
    if (!current) return missingFileError(context, resolved);
    // A shared file the host could not serve must not be edited from its working copy.
    if (sharedDoc && !current.shared) await readSharedText(resolved.path, { doc: sharedDoc }).catch(sharedToolError);
    const state = context.fileState.get(resolved.path);
    if (!state) throw new ToolError(`Read ${resolved.path} before editing it.`);
    if (hashContent(current.content) !== state.hash) throw new ToolError(`${resolved.path} changed since you read it. Read it again before editing.`);
    if (!oldString) throw new ToolError("old_string is empty. To add text, include a neighboring line in old_string and repeat it in new_string; to create a file, use Write.");
    if (oldString === newString) throw new ToolError("old_string and new_string are identical; there is nothing to change.");
    const target = findEditTarget(current.content, oldString, newString);
    if (!target.matches.length) {
      throw new ToolError(`old_string was not found in ${resolved.path}. Check whitespace and line breaks, and copy the text from your latest Read without line numbers.${closestLines(current.content, oldString)}`);
    }
    if (target.matches.length > 1 && !replaceAll) {
      const lines = target.matches.slice(0, 10).map((match) => lineOfOffset(current.content, match.index));
      throw new ToolError(`old_string matches ${target.matches.length} places in ${resolved.path} (lines ${lines.join(", ")}${target.matches.length > 10 ? ", …" : ""}). Add surrounding lines to make it unique, or set replace_all to true.`);
    }
    const replacement = current.content.includes("\r\n") ? target.newString.replace(/\r?\n/g, "\r\n") : target.newString;
    let next = "";
    let cursor = 0;
    for (const match of replaceAll ? target.matches : target.matches.slice(0, 1)) {
      next += current.content.slice(cursor, match.index) + replacement;
      cursor = match.index + match.length;
    }
    next += current.content.slice(cursor);
    const suggested = await writeAgentFile(context, resolved, next, current);
    const firstStart = target.matches[0].index;
    const count = replaceAll ? target.matches.length : 1;
    const snippet = snippetAround(next, firstStart, firstStart + replacement.length);
    if (suggested) {
      const text = [suggestionNote(resolved, suggested), target.note, `Proposed region (the file still reads as before):\n${snippet}`].filter(Boolean).join("\n");
      return ok(text, "Suggested, pending review", snippet);
    }
    const text = [`Edited ${resolved.path}${count > 1 ? ` (${count} replacements)` : ""}.`, target.note, `Edited region:\n${snippet}`].filter(Boolean).join("\n");
    return ok(text, count > 1 ? `${count} replacements` : "Edited", snippet);
  },
};

const writeTool: AgentTool = {
  name: "Write",
  kind: "write",
  description: `Creates a file, or replaces a file's entire content.

Usage:
- Prefer Edit for changes to existing notes: it is safer and shows exactly what changed. Use Write to create a new note, or when rewriting nearly all of a file.
- Overwriting an existing file requires that you Read the whole file first in this conversation.
- file_path is a library path; missing folders are created. New notes should be Markdown (.md) unless the user asks otherwise; .tex, .bib and plain-text extensions also work.
- Write the complete content. Never leave placeholders such as "rest of the note unchanged".`,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Library path of the file to create or overwrite." },
      content: { type: "string", description: "The complete file content." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  describe: (args) => `Writing ${String(args.file_path ?? "a file")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "file_path"));
    const content = requireString(args, "content", { allowEmpty: true });
    const stats = await statLibraryPath(resolved);
    if (stats?.isDirectory()) throw new ToolError(`${resolved.path} is a folder.`);
    const exists = !!stats || context.drafts.has(resolved.path);
    assertWritable(context, resolved, { creating: !exists });
    if (!exists && !path.extname(resolved.path)) throw new ToolError(`Add a file extension to ${resolved.path}, e.g. "${resolved.path}.md".`);
    const sharedDoc = await assertSharedWritable(context, resolved);
    let previous: { content: string | null; fromDraft: boolean; shared?: ResolvedDoc } = { content: null, fromDraft: false };
    if (exists) {
      const current = await readCurrentText(context, resolved);
      if (!current) return missingFileError(context, resolved);
      if (sharedDoc && !current.shared) await readSharedText(resolved.path, { doc: sharedDoc }).catch(sharedToolError);
      const state = context.fileState.get(resolved.path);
      if (!state || state.partial) throw new ToolError(`${resolved.path} already exists. Read the whole file before overwriting it, or use Edit to change part of it.`);
      if (hashContent(current.content) !== state.hash) throw new ToolError(`${resolved.path} changed since you read it. Read it again before overwriting it.`);
      if (current.content === content) return ok(`${resolved.path} already has this content; nothing changed.`, "Unchanged");
      previous = current;
    }
    const suggested = await writeAgentFile(context, resolved, content, previous);
    const lineCount = splitLines(content).length;
    if (suggested) return ok(suggestionNote(resolved, suggested), "Suggested, pending review", preview(content));
    return ok(`${exists ? "Overwrote" : "Created"} ${resolved.path} (${plural(lineCount, "line")}).`, `${exists ? "Overwrote" : "Created"}, ${plural(lineCount, "line")}`, preview(content));
  },
};

function formatTasks(tasks: AgentTask[]) {
  if (!tasks.length) return "The task list is empty.";
  return tasks.map((task) => `#${task.id} [${task.status}] ${task.subject}`).join("\n");
}

const taskCreateTool: AgentTool = {
  name: "TaskCreate",
  kind: "read",
  description: `Adds a task to your task list, which the user sees while you work.

Usage:
- For any job with three or more steps, create the tasks first, then work through them.
- Mark a task in_progress with TaskUpdate when you start it and completed as soon as it is done. Keep only one task in progress at a time.
- Do not use tasks for single, trivial steps.`,
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Short imperative title, e.g. \"Merge the two onboarding notes\"." },
      description: { type: "string", description: "Optional details." },
    },
    required: ["subject"],
    additionalProperties: false,
  },
  describe: (args) => `Adding task ${quoted(args.subject)}`,
  async run(args, context) {
    const subject = requireString(args, "subject").trim().slice(0, 300);
    if (context.tasks.length >= 50) throw new ToolError("The task list is full (50 tasks). Complete or delete tasks first.");
    const id = String(context.tasks.reduce((max, task) => Math.max(max, Number(task.id)), 0) + 1);
    context.tasks.push({ id, subject, status: "pending" });
    context.emit({ type: "tasks_updated", tasks: context.tasks.map((task) => ({ ...task })) });
    return ok(`Created task #${id}.\n\n${formatTasks(context.tasks)}`, `Task #${id}`);
  },
};

const taskUpdateTool: AgentTool = {
  name: "TaskUpdate",
  kind: "read",
  description: `Updates a task in your task list.

Usage:
- status: "in_progress" when you start a task, "completed" when it is done, "pending" to put it back, or "deleted" to remove a task that is no longer needed.
- subject optionally renames the task.`,
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task number, e.g. \"2\"." },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      subject: { type: "string", description: "Optional new title." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
  describe: (args) => `Updating task #${String(args.taskId ?? "?").replace(/^#/, "")}${args.status ? ` (${String(args.status).replace("_", " ")})` : ""}`,
  async run(args, context) {
    const raw = args.taskId;
    const taskId = String(typeof raw === "number" ? raw : requireString(args, "taskId")).replace(/^#/, "").trim();
    const index = context.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new ToolError(`There is no task #${taskId}.\n\n${formatTasks(context.tasks)}`);
    const status = optionalString(args, "status");
    const subject = optionalString(args, "subject");
    if (status === "deleted") context.tasks.splice(index, 1);
    else {
      if (status !== undefined && status !== "pending" && status !== "in_progress" && status !== "completed") throw new ToolError("status must be pending, in_progress, completed or deleted.");
      const task = context.tasks[index];
      if (status) task.status = status as AgentTaskStatus;
      if (subject?.trim()) task.subject = subject.trim().slice(0, 300);
    }
    context.emit({ type: "tasks_updated", tasks: context.tasks.map((task) => ({ ...task })) });
    return ok(formatTasks(context.tasks), status ? `#${taskId} ${status.replace("_", " ")}` : `#${taskId} updated`);
  },
};

const skillTool: AgentTool = {
  name: "Skill",
  kind: "read",
  description: `Loads a skill: instructions, and sometimes extra tools, for a particular kind of job. The skills you can load are listed in the system prompt under "Skills".

Usage:
- Load a skill when the user's request is that skill's job, before you start the job. Do not load skills the request does not need.
- The skill's instructions come back as the result; follow them. Tools the skill provides are available from your next reply on.
- A loaded skill stays loaded for the rest of this turn; do not load it twice.`,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, e.g. \"leave-review-comments\"." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  describe: (args) => `Loading the ${String(args.name ?? "requested")} skill`,
  async run(args, context) {
    const name = requireString(args, "name").trim().replace(/^\//, "");
    const skill = context.skills.find((candidate) => candidate.name === name) ?? context.skills.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      throw new ToolError(context.skills.length ? `There is no skill named "${name}". Available skills: ${context.skills.map((candidate) => candidate.name).join(", ")}.` : "No skills are available.");
    }
    const unavailable = skill.unavailable?.(context);
    if (unavailable) return ok(unavailable, "Not available here");
    const tools = skill.tools?.map((tool) => tool.name) ?? [];
    if (context.loadedSkills.has(skill.name)) {
      return ok(`The ${skill.name} skill is already loaded; follow its instructions from earlier in this turn.${tools.length ? ` Its tools: ${tools.join(", ")}.` : ""}`, "Already loaded");
    }
    context.loadedSkills.add(skill.name);
    const footer = tools.length ? `\n\n(Tools now available: ${tools.join(", ")}.)` : "";
    return ok(`<skill name="${skill.name}">\n${skill.instructions.trim()}\n</skill>${footer}`, "Loaded", preview(skill.instructions));
  },
};

// References and ReadComments are read-only, so every permission gets them.
export const ALL_TOOLS: AgentTool[] = [globTool, grepTool, readTool, readCommentsTool, editTool, writeTool, taskCreateTool, taskUpdateTool, skillTool, referencesTool];

export function toolsForPermission(permission: AgentPermission) {
  return ALL_TOOLS.filter((tool) => tool.kind === "read" || permission !== "read-only");
}

/**
 * The base tools plus the tools of every skill loaded so far in this run.
 * WebSearch is offered exactly when the user allowed web search.
 */
export function activeTools(tools: AgentTool[], context: ToolContext): AgentTool[] {
  const active = tools.filter((tool) => tool.name !== WEB_SEARCH_TOOL || context.allowWebSearch);
  if (context.allowWebSearch && !active.some((tool) => tool.name === WEB_SEARCH_TOOL)) active.push(webSearchTool);
  for (const skill of context.skills) {
    if (!context.loadedSkills.has(skill.name)) continue;
    for (const tool of skill.tools ?? []) {
      if (tool.name === WEB_SEARCH_TOOL && !context.allowWebSearch) continue;
      if (!active.some((candidate) => candidate.name === tool.name)) active.push(tool);
    }
  }
  return active;
}

export function toolSchemas(tools: AgentTool[]): ToolSchema[] {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export function hasOpenTasks(context: ToolContext) {
  return context.tasks.some((task) => task.status !== "completed");
}
