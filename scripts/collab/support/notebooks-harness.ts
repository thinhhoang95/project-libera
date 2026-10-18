// Helpers for the shared-notebook tests: real CollabHosts against the real
// collab server (child process), temp library roots, and a router double
// that dispatches control routes the way the control server will.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ControlHandler, ControlRouter } from "../../../electron/collab/control/types";
import { CollabHost, type FetchLike } from "../../../electron/collab/core";
import { NotebookServiceImpl } from "../../../electron/collab/notebooks/service";
import type { HostEvent } from "../../../src/lib/collab/local-api";
import type { AuthResponse } from "../../../src/lib/collab/protocol/api";
import type { ServerProcess } from "./server-process";

export async function api<T>(server: ServerProcess, route: string, body?: unknown, token?: string, method?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${route}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export async function register(server: ServerProcess, name: string): Promise<AuthResponse> {
  const result = await api<AuthResponse>(server, "/v1/auth/register", {
    email: `${name.toLowerCase()}@example.test`,
    password: "correct horse battery",
    displayName: name,
  });
  if (result.status !== 201) throw new Error(`register ${name}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

export async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const quiet = { warn() {}, error() {} };
const debugLogger = (name: string) => ({
  warn: (message: string, detail?: unknown) => console.log(name, "warn", message, detail ?? ""),
  error: (message: string, detail?: unknown) => console.log(name, "error", message, detail ?? ""),
});

export class RouterDouble implements ControlRouter {
  private readonly routes: Array<{ method: string; pattern: string[]; handler: ControlHandler }> = [];

  add(method: "GET" | "POST" | "PATCH" | "DELETE", pattern: string, handler: ControlHandler): void {
    this.routes.push({ method, pattern: pattern.split("/").filter(Boolean), handler });
  }

  async call(method: string, route: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const segments = route.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
    for (const candidate of this.routes) {
      if (candidate.method !== method || candidate.pattern.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const match = candidate.pattern.every((part, index) => {
        if (part.startsWith(":")) {
          params[part.slice(1)] = segments[index];
          return true;
        }
        return part === segments[index];
      });
      if (!match) continue;
      try {
        const response = await candidate.handler({ method, path: route, params, query: new URLSearchParams(), body });
        return { status: response.status ?? 200, body: response.body };
      } catch (error) {
        const failure = error as { status?: number; code?: string; message?: string };
        if (typeof failure.status === "number") return { status: failure.status, body: { error: { code: failure.code, message: failure.message } } };
        throw error;
      }
    }
    return { status: 404, body: { error: { code: "no-route" } } };
  }
}

export interface Peer {
  name: string;
  auth: AuthResponse;
  host: CollabHost;
  service: NotebookServiceImpl;
  router: RouterDouble;
  library: string;
  events: HostEvent[];
}

export interface PeerOptions {
  fetch?: FetchLike;
  library?: string;
}

export async function makePeer(dir: string, name: string, server: ServerProcess, auth: AuthResponse, options: PeerOptions = {}): Promise<Peer> {
  const logger = process.env.LIBERA_IT_DEBUG ? debugLogger(name) : quiet;
  const host = new CollabHost({
    dbPath: path.join(dir, `${name}.sqlite`),
    appVersion: "test",
    installationId: `inst_${name}_notebooks`,
    logger,
    compaction: false,
    hubIdleMs: 60_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  host.start();
  let token = auth.accessToken;
  let refreshToken = auth.refreshToken;
  host.setAccount({
    accountId: auth.account.id,
    serverUrl: server.url,
    tokenProvider: {
      getAccessToken: async () => token,
      refresh: async () => {
        const refreshed = await api<AuthResponse>(server, "/v1/auth/refresh", { refreshToken });
        if (refreshed.status !== 200) return null;
        token = refreshed.body.accessToken;
        refreshToken = refreshed.body.refreshToken;
        return token;
      },
    },
  });
  const library = options.library ?? path.join(dir, `${name}-library`, "users", "admin");
  mkdirSync(library, { recursive: true });
  const events: HostEvent[] = [];
  const service = new NotebookServiceImpl(
    { host, libraryRoot: library, emit: (event) => events.push(event) },
    {
      logger,
      timings: { writeDebounceMs: 40, settleMs: 80, deleteGraceMs: 500, pollMs: 700, retryMs: 700 },
      joinTimeoutMs: 30_000,
      shareSyncTimeoutMs: 15_000,
    },
  );
  const router = new RouterDouble();
  service.registerRoutes(router);
  await service.start();
  return { name, auth, host, service, router, library, events };
}

export async function closePeer(peer: Peer): Promise<void> {
  await peer.service.stop();
  await peer.host.stop();
}

export function tempRoot(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold a WAL or a watcher handle for a moment.
      }
    },
  };
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    if (relative.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Every shared file under root (no .libera*, no _archive), as relative path → bytes; folders end with "/". */
export function snapshotTree(root: string): Map<string, Buffer | null> {
  const result = new Map<string, Buffer | null>();
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".")) continue;
      if (!prefix && name === "_archive") continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(absolute).isDirectory()) {
        result.set(`${relative}/`, null);
        visit(absolute, relative);
      } else {
        result.set(relative, readFileSync(absolute));
      }
    }
  };
  visit(root, "");
  return result;
}

export function sameTree(a: Map<string, Buffer | null>, b: Map<string, Buffer | null>): string | null {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of [...keys].sort()) {
    const left = a.get(key);
    const right = b.get(key);
    if (left === undefined || right === undefined) return `${key} exists only on one side`;
    if (left === null || right === null) {
      if (left !== right) return `${key} is a folder on one side only`;
      continue;
    }
    if (!left.equals(right)) return `${key} differs`;
  }
  return null;
}

export function readText(root: string, relative: string): string | null {
  try {
    return readFileSync(path.join(root, ...relative.split("/")), "utf8");
  } catch {
    return null;
  }
}

/** Invites `email` as `role` and returns the invitation link. */
export async function invite(server: ServerProcess, owner: AuthResponse, projectId: string, email: string, role = "editor"): Promise<string> {
  const created = await api<{ token: string; url?: string }>(server, `/v1/projects/${projectId}/invitations`, { email, role }, owner.accessToken);
  if (created.status !== 201) throw new Error(`invite: ${created.status} ${JSON.stringify(created.body)}`);
  return created.body.url ?? `${server.url}/invite/${encodeURIComponent(created.body.token)}`;
}
