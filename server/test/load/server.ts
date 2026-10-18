// The collab server the load generator spawns in its own process, so the
// generator's CPU use does not distort the server's latencies. Production
// settings (jobs on, pino at warn) except the limits a single-IP load test
// would trip: sign-up, sockets per account and connections per minute.
// Prints {"url": ...} on stdout once it listens.

import { authLimits, RateLimiter } from "../../src/api/rate-limit.js";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: "0",
  ALLOW_OPEN_SIGNUP: "1",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  SYNC_CONNECTIONS_PER_MINUTE: "1000000",
  SYNC_MAX_SOCKETS_PER_ACCOUNT: "1000000",
  // Long enough that no token expires during a run.
  ACCESS_TOKEN_TTL_SECONDS: "86400",
});
const server = await buildServer({ config, jobs: true });
const limits = authLimits(server.context);
limits.registerPerIp = new RateLimiter(1_000_000, 60_000);
limits.loginPerIp = new RateLimiter(1_000_000, 60_000);
const url = await server.listen();
process.stdout.write(`${JSON.stringify({ url, database: server.context.database.kind })}\n`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// The parent closes stdin when it is done (works on Windows, where signals do not).
process.stdin.on("end", () => void stop());
process.stdin.resume();
