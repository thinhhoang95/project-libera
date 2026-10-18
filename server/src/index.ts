import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = await buildServer({ config });
const url = await server.listen();
server.app.log.info(`Libera collab server listening on ${url}`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  server.app.log.info(`${signal} received, shutting down`);
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    server.app.log.error({ err: error }, "Shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
