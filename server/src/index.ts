import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { getErrorReporter, reportError } from "./observability/reporter.js";

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
    await getErrorReporter(server.context).flush(2000);
    process.exit(0);
  } catch (error) {
    server.app.log.error({ err: error }, "Shutdown failed");
    process.exit(1);
  }
}

// Report what escapes every handler. An unhandled rejection is logged and
// reported; an uncaught exception leaves the process in an unknown state, so
// it is reported and the process exits (Docker restarts it).
process.on("unhandledRejection", (reason) => {
  server.app.log.error({ err: reason }, "Unhandled promise rejection");
  reportError(server.context, reason, { area: "process", reason: "unhandledRejection" });
});
process.on("uncaughtException", (error) => {
  server.app.log.fatal({ err: error }, "Uncaught exception");
  reportError(server.context, error, { area: "process", reason: "uncaughtException", fatal: true });
  void getErrorReporter(server.context)
    .flush(2000)
    .finally(() => process.exit(1));
});

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
