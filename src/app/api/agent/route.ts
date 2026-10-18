import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getAiChatCustomInstruction, getAiChatModels, getAiFunctionOptions } from "@/lib/ai-preferences";
import { isChatReasoningEffort, validateChatMessages } from "@/lib/document-chat";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { isCollabEnabled, listProjects } from "@/lib/collab/host-client";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { readSharedText } from "@/lib/collab/shared-writes";
import { mathMarkerSystemInstruction } from "@/lib/math-markers";
import { agentConversation } from "@/lib/agent/conversation";
import { listNotebookNames, resolveLibraryPath, statLibraryPath } from "@/lib/agent/library";
import { getModelProfile } from "@/lib/agent/model";
import { buildAgentEnvironment, buildAgentSystemPrompt } from "@/lib/agent/prompt";
import { DEFAULT_RUN_LIMITS, runAgent } from "@/lib/agent/runner";
import { RunSnapshots } from "@/lib/agent/snapshots";
import { AGENT_SKILLS } from "@/lib/agent/skills";
import { toolsForPermission, type ToolContext } from "@/lib/agent/tools";
import { isAgentPermission, type AgentEvent } from "@/lib/agent/types";

export const runtime = "nodejs";

const MAX_BODY_CHARS = 64_000_000;
const MAX_DRAFTS_CHARS = 30_000_000;
const CONVENTIONS_FILE = "AGENT_NOTES.md";
const MAX_CONVENTIONS_CHARS = 16_000;

type AgentRequestBody = {
  messages?: unknown;
  model?: unknown;
  sessionId?: unknown;
  reasoningEffort?: unknown;
  permission?: unknown;
  activeFile?: unknown;
  openFiles?: unknown;
  drafts?: unknown;
  notebook?: unknown;
  webSearch?: unknown;
};

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 500 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4_096);
}

function isDraftMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let total = 0;
  for (const [key, draft] of Object.entries(value)) {
    if (key.length > 4_096 || typeof draft !== "string") return false;
    total += draft.length;
  }
  return total <= MAX_DRAFTS_CHARS;
}

/** Normalize client paths; drop anything that is not a file in the library. */
async function libraryFiles(paths: string[], notebooks: string[]) {
  const files: string[] = [];
  for (const candidate of paths) {
    try {
      const resolved = await resolveLibraryPath(candidate, { notebooks });
      if (resolved.pathParts.length && !files.includes(resolved.path)) files.push(resolved.path);
    } catch { /* Untitled drafts and gallery photos have no library path. */ }
  }
  return files;
}

async function readConventions(notebook: string | null, notebooks: string[]) {
  if (!notebook) return undefined;
  try {
    const resolved = await resolveLibraryPath(`${notebook}/${CONVENTIONS_FILE}`, { notebooks });
    // In a shared notebook the file is a shared document written by
    // collaborators: read its live text when the host can serve it.
    const shared = isSharedNotebookPath(resolved.path);
    const text = shared
      ? await readSharedText(resolved.path).then((result) => result.text, () => readFile(resolved.absolutePath, "utf8"))
      : await readFile(resolved.absolutePath, "utf8");
    if (!text.trim()) return undefined;
    return { path: resolved.path, text: text.slice(0, MAX_CONVENTIONS_CHARS), truncated: text.length > MAX_CONVENTIONS_CHARS, ...(shared ? { shared: true } : {}) };
  } catch { return undefined; }
}

/** The shared notebooks in the library, with the user's role when the collab host answers. */
async function sharedNotebooks(notebooks: string[]) {
  const shared = notebooks.filter((name) => isSharedNotebookPath(name));
  if (!shared.length) return [];
  const roles = new Map<string, string>();
  if (isCollabEnabled()) {
    try { for (const project of await listProjects()) roles.set(project.notebook, project.revoked ? "access revoked" : project.role); }
    catch { /* The host is down; the tools report it if the agent tries to write. */ }
  }
  return shared.map((name) => ({ notebook: name, ...(roles.has(name) ? { role: roles.get(name) } : {}) }));
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return jsonError("This request is too large. Start a new chat, or close some unsaved documents.", 413);
  let body: AgentRequestBody | null;
  try { body = JSON.parse(raw); } catch { return jsonError("Invalid agent request.", 400); }
  if (!body || !validateChatMessages(body.messages) || body.messages.at(-1)?.role !== "user") return jsonError("Invalid chat messages.", 400);
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256)) return jsonError("Invalid chat session.", 400);
  if (body.reasoningEffort !== undefined && !isChatReasoningEffort(body.reasoningEffort)) return jsonError("Invalid reasoning effort.", 400);
  if (!isAgentPermission(body.permission)) return jsonError("Invalid agent permission.", 400);
  if (body.activeFile !== undefined && body.activeFile !== null && typeof body.activeFile !== "string") return jsonError("Invalid active file.", 400);
  if (body.notebook !== undefined && body.notebook !== null && typeof body.notebook !== "string") return jsonError("Invalid notebook.", 400);
  if (!isPathList(body.openFiles ?? [])) return jsonError("Invalid open files.", 400);
  if (!isDraftMap(body.drafts ?? {})) return jsonError("Unsaved drafts are invalid or too large.", 413);
  if (body.webSearch !== undefined && typeof body.webSearch !== "boolean") return jsonError("Invalid web search setting.", 400);
  const allowWebSearch = body.webSearch === true;

  const options = getAiFunctionOptions("chat");
  const model = body.model === undefined ? options.model : body.model;
  if (typeof model !== "string" || !getAiChatModels().includes(model)) return jsonError("Invalid chat model.", 400);

  const permission = body.permission;
  const notebooks = await listNotebookNames();
  const openFiles = await libraryFiles((body.openFiles ?? []) as string[], notebooks);
  const [activeFile] = body.activeFile ? await libraryFiles([body.activeFile as string], notebooks) : [];
  const requestedNotebook = typeof body.notebook === "string" && notebooks.includes(body.notebook) ? body.notebook : null;
  const notebook = activeFile ? activeFile.split("/")[0] : requestedNotebook;
  if (permission === "notebook" && !notebook) return jsonError("Open a file or select a notebook so the agent knows which notebook it may change.", 400);
  if (permission === "notebook" && notebook && isSharedNotebookPath(notebook)) {
    // Phase 1: agent edits to shared files apply directly as the user's
    // edits, so they are limited to files the user has open and can watch.
    return jsonError(`"${notebook}" is a shared notebook, where "Modify all files in Notebook/Folder" is not available yet. Switch Agent permission to "Modify opened files only" (the agent then edits the shared files you have open) or Read Only.`, 409);
  }

  // Only drafts of files that are open and differ from disk matter. A shared
  // tab's text is a mirror of the shared document, which the agent reads
  // from the collab host instead.
  const drafts = new Map<string, string>();
  for (const [draftPath, draft] of Object.entries((body.drafts ?? {}) as Record<string, string>)) {
    const [resolved] = await libraryFiles([draftPath], notebooks);
    if (resolved && openFiles.includes(resolved) && !isSharedNotebookPath(resolved)) drafts.set(resolved, draft);
  }

  const fileExists = new Map<string, boolean>();
  for (const message of body.messages) {
    for (const context of message.contexts ?? []) {
      if (context.kind !== "document" || fileExists.has(context.path)) continue;
      try {
        const resolved = await resolveLibraryPath(context.path, { notebooks });
        fileExists.set(context.path, !!(await statLibraryPath(resolved))?.isFile());
      } catch { fileExists.set(context.path, false); }
    }
  }

  const environment = buildAgentEnvironment({
    date: new Date().toISOString().slice(0, 10),
    permission,
    notebook,
    notebooks,
    activeFile: activeFile ?? null,
    openFiles,
    unsavedFiles: new Set(drafts.keys()),
    conventions: await readConventions(notebook, notebooks),
    sharedNotebooks: await sharedNotebooks(notebooks),
    webSearch: allowWebSearch,
  });
  const system = buildAgentSystemPrompt({
    permission,
    mathInstruction: mathMarkerSystemInstruction(getConfiguredMarkdownPreferences()),
    customInstruction: getAiChatCustomInstruction(),
    skills: AGENT_SKILLS,
  });
  const conversation = agentConversation(body.messages, environment, (filePath) => fileExists.get(filePath) === true);
  const reasoningEffort = body.reasoningEffort ?? options.reasoning.effort;
  const sessionId = body.sessionId as string | undefined;
  const runId = randomUUID();

  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent) => {
        if (!cancellation.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const profile = await getModelProfile(model, signal);
        if (profile.known && !profile.supportsTools) {
          send({ type: "error", message: `${model} cannot call tools on OpenRouter, so it cannot work in Agent mode. Choose another model, or switch to Chat.` });
          return;
        }
        send({ type: "run_started", runId, model });
        const tools = toolsForPermission(permission);
        const context: ToolContext = {
          permission,
          skills: AGENT_SKILLS,
          loadedSkills: new Set(),
          skillState: new Map(),
          notebook,
          notebooks,
          openFiles: new Set(openFiles),
          drafts,
          fileState: new Map(),
          tasks: [],
          snapshots: new RunSnapshots(runId),
          changed: new Map(),
          // Leave room in the window: roughly a tenth of it per tool result.
          maxResultChars: Math.round(Math.min(100_000, Math.max(20_000, profile.contextLength * 0.4))),
          signal,
          emit: send,
          model,
          allowWebSearch,
          runConfig: { model, profile, reasoningEffort, promptCaching: options.promptCaching },
          // One budget for the run and every child run it starts.
          budget: { maxInputTokens: DEFAULT_RUN_LIMITS.maxInputTokens, inputTokens: 0 },
        };
        const result = await runAgent({
          model, profile, reasoningEffort, sessionId,
          promptCaching: options.promptCaching,
          system, messages: conversation, tools, context, emit: send, signal,
        });
        send({ type: "done", outcome: result.outcome, ...(result.message ? { message: result.message } : {}) });
      } catch (error) {
        send({ type: "error", message: signal.aborted ? "The agent was stopped." : error instanceof Error ? error.message : "The agent run failed." });
      } finally {
        if (!cancellation.signal.aborted) controller.close();
        cancellation.abort();
      }
    },
    cancel() { cancellation.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
