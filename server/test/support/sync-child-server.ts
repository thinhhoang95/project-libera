// Runs a collab server in its own process for the kill test. Reads
// DATABASE_URL, JWT_SECRET and SYNC_FIXTURE ({accountId, projectId, docId})
// from the environment, creates the fixture rows if they are missing, and
// prints {"url": ...} on stdout once it listens.

import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createAccount, createDocument, createProject } from "./sync-fixtures.js";

const fixture = JSON.parse(process.env.SYNC_FIXTURE ?? "{}") as { accountId: string; projectId: string; docId: string };
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  PORT: "0",
  SYNC_CONNECTIONS_PER_MINUTE: "1000",
});
const server = await buildServer({ config, jobs: false });
const { db } = server.context;
await createAccount(db, config, { id: fixture.accountId });
await createProject(db, fixture.accountId, { id: fixture.projectId });
await createDocument(db, fixture.projectId, { id: fixture.docId });
const url = await server.listen();
process.stdout.write(`${JSON.stringify({ url })}\n`);
