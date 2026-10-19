// Shared setup for the Phase 4 desktop tests (p4d-*.test.ts): REST helpers
// against the real collab server, a two-account team with one shared
// document, and CollabHosts whose sockets can drop chosen server frames
// (a lost `remote` is how a real replica ends up missing an update).

import path from "node:path";

import type { SecretCodec } from "../../electron/collab/control/account";
import { CollabHost, type CollabHostOptions } from "../../electron/collab/core/host";
import type { WebSocketLike } from "../../electron/collab/core/sync-client";
import type { AuthResponse, ProjectSummary } from "../../src/lib/collab/protocol/api";
import { decodeMessage, type SyncMessage } from "../../src/lib/collab/protocol/messages";
import type { ServerProcess } from "./support/server-process";

export const quietLogger = { warn() {}, error() {} };

/** Reversible stand-in for safeStorage. */
export const fakeSecrets: SecretCodec = {
  encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString(),
};

export async function api<T>(
  server: ServerProcess,
  route: string,
  options: { body?: unknown; token?: string; method?: string } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${server.url}${route}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, headers: response.headers };
}

export async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface Team {
  alice: AuthResponse;
  bob: AuthResponse;
  projectId: string;
}

let teamCounter = 0;

/** Alice owns a project; Bob joins it as an editor. Emails are unique per call. */
export async function createTeam(server: ServerProcess): Promise<Team> {
  teamCounter += 1;
  const suffix = `${process.pid}-${teamCounter}`;
  const password = "correct horse battery";
  const alice = await api<AuthResponse>(server, "/v1/auth/register", {
    body: { email: `alice-${suffix}@example.test`, password, displayName: "Alice" },
  });
  if (alice.status !== 201) throw new Error(`register alice: ${alice.status}`);
  const project = await api<ProjectSummary>(server, "/v1/projects", { body: { name: `Shared ${suffix}` }, token: alice.body.accessToken });
  if (project.status !== 201) throw new Error(`create project: ${project.status}`);
  const invite = await api<{ token: string }>(server, `/v1/projects/${project.body.id}/invitations`, {
    body: { email: `bob-${suffix}@example.test`, role: "editor" },
    token: alice.body.accessToken,
  });
  const bob = await api<AuthResponse>(server, "/v1/auth/register", {
    body: { email: `bob-${suffix}@example.test`, password, displayName: "Bob", invitationToken: invite.body.token },
  });
  if (bob.status !== 201) throw new Error(`register bob: ${bob.status}`);
  return { alice: alice.body, bob: bob.body, projectId: project.body.id };
}

export async function createDocument(server: ServerProcess, team: Team, docId: string): Promise<void> {
  const created = await api(server, `/v1/projects/${team.projectId}/documents`, {
    body: { docId, fileId: `fil_${docId.slice(4)}`, kind: "markdown" },
    token: team.alice.accessToken,
  });
  if (created.status !== 201) throw new Error(`create document: ${created.status}`);
}

/** A socket factory whose sockets can drop server frames and be dropped from the test. */
export function filteringSockets() {
  const keepAll = (): boolean => false;
  const state: { drop: (message: SyncMessage) => boolean } = { drop: keepAll };
  const live: WebSocket[] = [];
  const factory = (url: string): WebSocketLike => {
    const socket = new WebSocket(url);
    live.push(socket);
    const like: WebSocketLike = {
      get binaryType() {
        return socket.binaryType;
      },
      set binaryType(value: string) {
        socket.binaryType = value as BinaryType;
      },
      get readyState() {
        return socket.readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };
    socket.onopen = (event) => like.onopen?.(event);
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        try {
          if (state.drop(decodeMessage(new Uint8Array(event.data)))) return;
        } catch {
          // Undecodable frames go to the client, which reports them.
        }
      }
      like.onmessage?.({ data: event.data });
    };
    socket.onclose = (event) => like.onclose?.({ code: event.code, reason: event.reason });
    socket.onerror = (event) => like.onerror?.(event);
    return like;
  };
  return {
    factory,
    state,
    /** Closes the newest socket from the outside, as a network drop would. */
    dropConnection() {
      live.at(-1)?.close(4000, "test drop");
    },
  };
}

export function makeHost(
  dir: string,
  name: string,
  server: ServerProcess,
  auth: AuthResponse,
  extra: Partial<CollabHostOptions> = {},
): CollabHost {
  const host = new CollabHost({
    dbPath: path.join(dir, `${name}.sqlite`),
    appVersion: "0.0.0-test",
    installationId: `inst_${name}_p4d`,
    logger: quietLogger,
    compaction: false,
    hubIdleMs: 50,
    random: () => 0,
    telemetry: false,
    divergence: false,
    ...extra,
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
        const refreshed = await api<AuthResponse>(server, "/v1/auth/refresh", { body: { refreshToken } });
        if (refreshed.status !== 200) return null;
        token = refreshed.body.accessToken;
        refreshToken = refreshed.body.refreshToken;
        return token;
      },
    },
  });
  return host;
}
