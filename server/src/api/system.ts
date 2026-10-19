import type { FastifyInstance } from "fastify";

import type { ServerContext } from "../context.js";
import { errorBody } from "../http/errors.js";
import {
  ApiRoutes,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type VersionResponse,
} from "../protocol.js";

export const SERVER_VERSION = "0.1.0";

export function minProtocolVersion(context: ServerContext): number {
  return Math.max(MIN_SUPPORTED_PROTOCOL_VERSION, context.config.MIN_PROTOCOL_VERSION ?? 0);
}

export function registerSystemRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get(ApiRoutes.health, async () => {
    await context.db.selectFrom("schema_migrations").select("name").limit(1).execute();
    return { ok: true };
  });

  app.get(ApiRoutes.version, async (): Promise<VersionResponse> => ({
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: minProtocolVersion(context),
    minAppVersion: context.config.MIN_APP_VERSION,
    serverVersion: SERVER_VERSION,
  }));

  app.get(ApiRoutes.metrics, async (request, reply) => {
    const token = context.config.METRICS_TOKEN;
    const authorized = token
      ? request.headers.authorization === `Bearer ${token}`
      : request.ip === "127.0.0.1" || request.ip === "::1";
    if (!authorized) return reply.status(403).send(errorBody("forbidden", "Metrics are not public."));
    reply.header("content-type", context.metrics.contentType);
    return context.metrics.metrics();
  });
}
