// Test harness for the REST API: a server with a temp blob directory, a
// recording mailer and a recording RoomService (the real one belongs to the
// sync service and is not under test here).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config.js";
import type { RoomService, ServerContext } from "../../src/context.js";
import type { BusEvent } from "../../src/events.js";
import { authLimits, RateLimiter } from "../../src/api/rate-limit.js";
import { setMailer, type MailMessage } from "../../src/mail/index.js";
import type { AuthResponse, ProjectSummary, Role } from "../../src/protocol.js";
import { json, startTestServer, type TestServer } from "../helpers.js";

export interface RoomCall {
  method: "membershipChanged" | "documentDeleted" | "accountRevoked";
  args: unknown[];
}

export interface RecordingRooms extends RoomService {
  calls: RoomCall[];
  /** Makes every notification method throw, like a broken sync service. */
  failing: boolean;
}

export function recordingRooms(): RecordingRooms {
  const rooms: RecordingRooms = {
    calls: [],
    failing: false,
    transact: () => Promise.reject(new Error("transact is not stubbed")),
    withDocs: () => Promise.reject(new Error("withDocs is not stubbed")),
    currentServerSeq: () => Promise.reject(new Error("currentServerSeq is not stubbed")),
    membershipChanged(...args) {
      rooms.calls.push({ method: "membershipChanged", args });
      if (rooms.failing) throw new Error("rooms down");
    },
    documentDeleted(...args) {
      rooms.calls.push({ method: "documentDeleted", args });
      if (rooms.failing) throw new Error("rooms down");
    },
    accountRevoked(...args) {
      rooms.calls.push({ method: "accountRevoked", args });
      if (rooms.failing) throw new Error("rooms down");
    },
  };
  return rooms;
}

export interface ApiHarness extends TestServer {
  context: ServerContext;
  mail: MailMessage[];
  rooms: RecordingRooms;
  events: BusEvent[];
  blobDir: string;
}

export async function startApi(overrides: Partial<Config> = {}): Promise<ApiHarness> {
  const blobDir = await mkdtemp(join(tmpdir(), "libera-blobs-"));
  const server = await startTestServer({ BLOB_DIR: blobDir, PUBLIC_URL: "https://collab.test", ...overrides });
  const context = server.server.context;
  const mail: MailMessage[] = [];
  setMailer(context, { send: async (message) => void mail.push(message) });
  const rooms = recordingRooms();
  context.rooms = rooms;
  // Every test signs up several accounts from 127.0.0.1.
  authLimits(context).registerPerIp = new RateLimiter(10_000, 60_000);
  const events: BusEvent[] = [];
  context.events.subscribe((event) => events.push(event));
  return {
    ...server,
    context,
    mail,
    rooms,
    events,
    blobDir,
    async close() {
      await server.close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: AuthResponse;
}

let counter = 0;

export async function register(h: TestServer, name = "user", extra: Record<string, unknown> = {}): Promise<TestUser> {
  counter += 1;
  const email = `${name}-${counter}@example.test`;
  const response = await json<AuthResponse>(h.url, "/v1/auth/register", {
    body: { email, password: "correct horse battery", displayName: name, ...extra },
  });
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  return { id: response.body.account.id, email, token: response.body.accessToken, auth: response.body };
}

export async function createProject(h: TestServer, owner: TestUser, name = "Notebook"): Promise<ProjectSummary> {
  const response = await json<ProjectSummary>(h.url, "/v1/projects", { body: { name }, token: owner.token });
  if (response.status !== 201) throw new Error(`create project failed: ${response.status}`);
  return response.body;
}

/** Adds a member straight in the database (role tests don't need the invitation flow). */
export async function addMember(h: ApiHarness, projectId: string, user: TestUser, role: Exclude<Role, "owner">): Promise<void> {
  await h.context.db.insertInto("memberships").values({ project_id: projectId, account_id: user.id, role }).execute();
}

/** A project with one member of every role. */
export async function team(h: ApiHarness) {
  const owner = await register(h, "owner");
  const editor = await register(h, "editor");
  const commenter = await register(h, "commenter");
  const viewer = await register(h, "viewer");
  const outsider = await register(h, "outsider");
  const project = await createProject(h, owner);
  await addMember(h, project.id, editor, "editor");
  await addMember(h, project.id, commenter, "commenter");
  await addMember(h, project.id, viewer, "viewer");
  return { owner, editor, commenter, viewer, outsider, project };
}

export async function request(
  h: TestServer,
  method: string,
  path: string,
  user?: TestUser | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return json(h.url, path, { method, body, token: user?.token });
}

export function errorCode(response: { body: any }): string | undefined {
  return response.body?.error?.code;
}
