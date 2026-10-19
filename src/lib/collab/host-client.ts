// Server-side client for the collab host's control API (local-api.ts).
//
// Used by the /api/collab proxy route and by other Next code (the agent, AI
// routes) that needs shared documents. The host's URL and per-launch token
// come from LIBERA_COLLAB_HOST_URL / LIBERA_COLLAB_HOST_TOKEN, which Electron
// sets only when collaboration is enabled. They are read on every call
// because the in-process production server sees main's process.env, which
// main updates if a restarted host had to move to another port.
//
// Never import this from client components: the token must stay on the
// server.

import type { LocalProject, AnchoredThreadsResponse, ApplyEditsRequest, ApplyEditsResponse, CreateSuggestionsRequest, CreateSuggestionsResponse, CreateThreadAtRangeRequest, CreateThreadAtRangeResponse, DocText, FileOpRequest, HostStatus, ResolvedDoc, WithdrawSuggestionsRequest, WithdrawSuggestionsResponse } from "./local-api";
import { ControlRoutes } from "./local-api";

export interface HostClientConfig {
  url: string;
  token: string;
}

export class CollabHostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CollabHostError";
  }
}

/** The host's address, or null when collaboration is disabled for this launch. */
export function collabHostConfig(env: NodeJS.ProcessEnv = process.env): HostClientConfig | null {
  const url = env.LIBERA_COLLAB_HOST_URL?.trim();
  const token = env.LIBERA_COLLAB_HOST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function isCollabEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return collabHostConfig(env) !== null;
}

function requireConfig(config?: HostClientConfig | null): HostClientConfig {
  const resolved = config ?? collabHostConfig();
  if (!resolved) throw new CollabHostError(503, "collab-disabled", "Collaboration is not enabled in this Libera.");
  return resolved;
}

export interface HostFetchOptions {
  method?: string;
  /** Raw JSON text, passed through unchanged (the proxy route). */
  bodyText?: string;
  body?: unknown;
  config?: HostClientConfig | null;
  signal?: AbortSignal;
}

/**
 * Sends one request to the control API. Rejects with CollabHostError 503
 * `collab-unavailable` when the host cannot be reached (it restarts with
 * backoff after a crash); otherwise resolves with the host's Response.
 */
export async function fetchCollabHost(pathAndQuery: string, options: HostFetchOptions = {}): Promise<Response> {
  const config = requireConfig(options.config);
  const headers: Record<string, string> = { authorization: `Bearer ${config.token}`, accept: "application/json" };
  let body: string | undefined;
  if (options.bodyText !== undefined && options.bodyText !== "") body = options.bodyText;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetch(`${config.url}${pathAndQuery}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    throw new CollabHostError(503, "collab-unavailable", "The collaboration service is not running. It restarts automatically; try again shortly.");
  }
}

async function hostJson<T>(pathAndQuery: string, options: HostFetchOptions = {}): Promise<T> {
  const response = await fetchCollabHost(pathAndQuery, options);
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CollabHostError(502, "invalid-response", "The collaboration service returned invalid JSON.");
    }
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new CollabHostError(response.status, error?.code ?? "collab-error", error?.message ?? `HTTP ${response.status}`);
  }
  return parsed as T;
}

export function getHostStatus(config?: HostClientConfig | null): Promise<HostStatus> {
  return hostJson(ControlRoutes.status, { config });
}

/** The shared document for a Libera path ("Notebook/sub/file.md"), or null when the file is not shared. */
export async function resolveSharedPath(liberaPath: string, config?: HostClientConfig | null): Promise<ResolvedDoc | null> {
  if (!(config ?? collabHostConfig())) return null;
  const query = new URLSearchParams({ path: liberaPath });
  return hostJson<ResolvedDoc | null>(`${ControlRoutes.resolve}?${query}`, { config });
}

/** The shared file a docId belongs to (CollabHostError 404 when unknown). */
export function getSharedDoc(docId: string, config?: HostClientConfig | null): Promise<ResolvedDoc> {
  return hostJson(ControlRoutes.doc(docId), { config });
}

export function getDocText(docId: string, config?: HostClientConfig | null): Promise<DocText> {
  return hostJson(ControlRoutes.docText(docId), { config });
}

/** Applies edits atomically; `applied: false` with `conflictAt` when a `before` no longer matches. */
export function applyEdits(docId: string, request: ApplyEditsRequest, config?: HostClientConfig | null): Promise<ApplyEditsResponse> {
  return hostJson(ControlRoutes.docEdits(docId), { method: "POST", body: request, config });
}

export function createSuggestions(docId: string, request: CreateSuggestionsRequest, config?: HostClientConfig | null): Promise<CreateSuggestionsResponse> {
  return hostJson(ControlRoutes.docSuggestions(docId), { method: "POST", body: request, config });
}

/** Withdraws the account's own pending suggestions (an agent run's, on undo). */
export function withdrawSuggestions(docId: string, request: WithdrawSuggestionsRequest, config?: HostClientConfig | null): Promise<WithdrawSuggestionsResponse> {
  return hostJson(ControlRoutes.docSuggestionsWithdraw(docId), { method: "POST", body: request, config });
}

/** A comment thread on a range of text; the host writes its anchor (queued offline). */
export function createThreadAtRange(docId: string, request: CreateThreadAtRangeRequest, config?: HostClientConfig | null): Promise<CreateThreadAtRangeResponse> {
  return hostJson(ControlRoutes.threadsAtRange(docId), { method: "POST", body: request, config });
}

/** A document's comment threads, each with its anchor resolved against the live text. */
export function listAnchoredThreads(docId: string, config?: HostClientConfig | null): Promise<AnchoredThreadsResponse> {
  return hostJson(ControlRoutes.threadsAnchored(docId), { config });
}

/** The projects joined on this machine, refreshed from the server when it can be reached. */
export function listProjects(config?: HostClientConfig | null): Promise<LocalProject[]> {
  return hostJson(ControlRoutes.projects, { config });
}

/** A file operation in a shared notebook (create, write-blob, rename, delete); resolves with the Libera paths it touched. */
export function fileOp(projectId: string, request: FileOpRequest, config?: HostClientConfig | null): Promise<{ paths: string[] }> {
  return hostJson(ControlRoutes.files(projectId), { method: "POST", body: request, config });
}
