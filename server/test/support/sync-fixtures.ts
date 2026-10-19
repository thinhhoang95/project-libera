// Fixture rows for sync tests, inserted straight into the database (the REST
// API that would normally create them is built separately).

import type { Kysely } from "kysely";

import type { Config } from "../../src/config.js";
import { signAccessToken } from "../../src/auth/tokens.js";
import type { DB } from "../../src/db/types.js";
import { newId } from "../../src/ids.js";
import type { DocKind, Role } from "../../src/protocol.js";
import { startTestServer, type TestServer } from "../helpers.js";
import { SyncTestClient, type ConnectOptions } from "./sync-client.js";

export interface AccountFixture {
  id: string;
  familyId: string;
  token: string;
}

export async function createAccount(
  db: Kysely<DB>,
  config: Config,
  options: { id?: string; disabled?: boolean } = {},
): Promise<AccountFixture> {
  const id = options.id ?? newId("acc");
  await db
    .insertInto("accounts")
    .values({
      id,
      email: `${id}@example.test`,
      display_name: id,
      color: "#3366ff",
      password_hash: "not-a-real-hash",
      disabled_at: options.disabled ? new Date() : null,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  const familyId = newId("fam");
  const { token } = await signAccessToken(config, id, familyId);
  return { id, familyId, token };
}

export interface ProjectFixture {
  id: string;
  manifestDocId: string;
}

export async function createProject(db: Kysely<DB>, ownerId: string, options: { id?: string } = {}): Promise<ProjectFixture> {
  const id = options.id ?? newId("prj");
  const manifestDocId = `${id}_manifest`;
  await db
    .insertInto("projects")
    .values({ id, name: `Project ${id}`, owner_id: ownerId, manifest_doc_id: manifestDocId })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("documents")
    .values({ id: manifestDocId, project_id: id, kind: "manifest", created_by: ownerId })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await addMember(db, id, ownerId, "owner");
  return { id, manifestDocId };
}

export async function addMember(db: Kysely<DB>, projectId: string, accountId: string, role: Role): Promise<void> {
  await db
    .insertInto("memberships")
    .values({ project_id: projectId, account_id: accountId, role })
    .onConflict((oc) => oc.columns(["project_id", "account_id"]).doUpdateSet({ role }))
    .execute();
}

export async function createDocument(
  db: Kysely<DB>,
  projectId: string,
  options: { id?: string; kind?: DocKind; createdBy?: string } = {},
): Promise<string> {
  const id = options.id ?? newId("doc");
  await db
    .insertInto("documents")
    .values({ id, project_id: projectId, kind: options.kind ?? "markdown", file_id: newId("fil"), created_by: options.createdBy ?? null })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  return id;
}

export interface SyncEnv {
  server: TestServer;
  db: Kysely<DB>;
  config: Config;
  owner: AccountFixture;
  project: ProjectFixture;
  docId: string;
  /** Connects a client with this account's token (default: the owner). */
  connect(account?: AccountFixture, options?: Partial<ConnectOptions>): Promise<SyncTestClient>;
  /** Creates an account and adds it to the project with `role`. */
  member(role: Role): Promise<AccountFixture>;
  close(): Promise<void>;
}

/** A test server with one project, its owner, and one markdown document. */
export async function startSyncEnv(overrides: Partial<Config> = {}): Promise<SyncEnv> {
  const server = await startTestServer(overrides);
  const { db, config } = server.server.context;
  const owner = await createAccount(db, config);
  const project = await createProject(db, owner.id);
  const docId = await createDocument(db, project.id, { createdBy: owner.id });
  const clients: SyncTestClient[] = [];
  return {
    server,
    db,
    config,
    owner,
    project,
    docId,
    async connect(account = owner, options = {}) {
      const client = await SyncTestClient.connect(server.wsUrl, { token: account.token, ...options });
      clients.push(client);
      return client;
    },
    async member(role) {
      const account = await createAccount(db, config);
      await addMember(db, project.id, account.id, role);
      return account;
    },
    async close() {
      for (const client of clients) client.ws.terminate();
      await server.close();
    },
  };
}
