// Phase 4 routes: client telemetry, the document digest, and two internal
// routes the admin CLI uses to talk to the running server.
//
// Internal routes (/internal/admin/...) answer only requests that come
// straight from the loopback interface without a proxy header, so they are
// reachable from `docker compose exec collab ...` but never through nginx
// (which always sets X-Forwarded-For) or Docker's published port (whose
// connections come from the bridge gateway). When METRICS_TOKEN is set they
// also need it as a bearer token.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { notifyRooms, pathId } from "../api/common.js";
import type { ServerContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { registerDigestRoutes } from "./digest.js";
import { registerTelemetryRoutes } from "./telemetry.js";

export const InternalRoutes = {
  room: (docId: string) => `/internal/admin/rooms/${encodeURIComponent(docId)}`,
  revokeAccount: (accountId: string) => `/internal/admin/accounts/${encodeURIComponent(accountId)}/revoke`,
} as const;

export interface RoomStatus {
  docId: string;
  loaded: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isInternalRequest(context: ServerContext, request: FastifyRequest): boolean {
  if (!LOOPBACK.has(request.socket.remoteAddress ?? "")) return false;
  if (request.headers["x-forwarded-for"] !== undefined || request.headers["forwarded"] !== undefined) return false;
  const token = context.config.METRICS_TOKEN;
  return !token || request.headers.authorization === `Bearer ${token}`;
}

function requireInternal(context: ServerContext, request: FastifyRequest): void {
  if (!isInternalRequest(context, request)) throw new HttpError("forbidden", "Internal route.");
}

const docParams = z.object({ docId: pathId });
const accountParams = z.object({ accountId: pathId });

export function registerAdminRoutes(app: FastifyInstance, context: ServerContext): void {
  registerTelemetryRoutes(app, context);
  registerDigestRoutes(app, context);

  app.get("/internal/admin/rooms/:docId", async (request): Promise<RoomStatus> => {
    requireInternal(context, request);
    const { docId } = docParams.parse(request.params);
    return { docId, loaded: context.rooms.isLoaded(docId) };
  });

  app.post("/internal/admin/accounts/:accountId/revoke", async (request, reply) => {
    requireInternal(context, request);
    const { accountId } = accountParams.parse(request.params);
    notifyRooms(context, "accountRevoked", (rooms) => rooms.accountRevoked(accountId));
    return reply.status(204).send();
  });
}
