// Builds the collab server: Fastify for the REST API, plus the WebSocket sync
// service on the same HTTP server (path /sync).

import Fastify, { type FastifyInstance } from "fastify";
import { collectDefaultMetrics, Registry } from "prom-client";

import { registerApi } from "./api/index.js";
import type { Config } from "./config.js";
import type { RoomService, ServerContext } from "./context.js";
import { openDatabase, type Database } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { EventBus } from "./events.js";
import { installErrorHandler } from "./http/errors.js";
import { startJobs, type JobRunner } from "./jobs/index.js";
import { createSyncService, type SyncService } from "./sync/index.js";

export interface CollabServer {
  app: FastifyInstance;
  context: ServerContext;
  sync: SyncService;
  jobs: JobRunner;
  /** Listens on config.HOST:config.PORT (0 picks a free port). Returns the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface BuildOptions {
  config: Config;
  /** Use an already-open database (tests). */
  database?: Database;
  /** Skip running migrations at start. */
  skipMigrations?: boolean;
  /** Start background jobs (compaction, digests). Off in most tests. */
  jobs?: boolean;
}

export async function buildServer(options: BuildOptions): Promise<CollabServer> {
  const { config } = options;
  const database = options.database ?? (await openDatabase(config.DATABASE_URL));
  if (!options.skipMigrations) await migrate(database);

  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 8 * 1024 * 1024,
  });
  installErrorHandler(app);

  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics });

  const context: ServerContext = {
    config,
    database,
    db: database.db,
    log: app.log,
    events: new EventBus(),
    metrics,
    rooms: undefined as unknown as RoomService,
  };

  const sync = createSyncService(context);
  context.rooms = sync.rooms;
  sync.attach(app.server);

  await registerApi(app, context);
  const jobs = startJobs(context, { enabled: options.jobs ?? config.NODE_ENV !== "test" });

  let closed = false;
  return {
    app,
    context,
    sync,
    jobs,
    async listen() {
      const address = await app.listen({ host: config.HOST, port: config.PORT });
      return address.replace("[::1]", "127.0.0.1");
    },
    async close() {
      if (closed) return;
      closed = true;
      jobs.stop();
      await sync.close();
      await app.close();
      if (!options.database) await database.close();
    },
  };
}
