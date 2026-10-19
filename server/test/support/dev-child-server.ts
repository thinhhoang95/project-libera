// Runs a collab server in its own process for desktop-side integration tests
// (scripts/collab/integration-*.test.ts). Configuration comes from the
// environment (DATABASE_URL, PORT, JWT_SECRET, ...); open sign-up is on.
// Prints {"url": ...} on stdout once it listens, and exits on SIGTERM/stdin end.

import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  ALLOW_OPEN_SIGNUP: "1",
  SYNC_CONNECTIONS_PER_MINUTE: process.env.SYNC_CONNECTIONS_PER_MINUTE ?? "10000",
});
const server = await buildServer({ config, jobs: false });
const url = await server.listen();
process.stdout.write(`${JSON.stringify({ url })}\n`);

const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
process.stdin.resume();
