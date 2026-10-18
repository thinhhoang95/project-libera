import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { ApiError, ApiErrorCode } from "../protocol.js";

const STATUS: Record<ApiErrorCode, number> = {
  "bad-request": 400,
  unauthorized: 401,
  "token-expired": 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "already-decided": 409,
  stale: 409,
  "ai-cannot-decide": 403,
  "rate-limited": 429,
  "too-large": 413,
  "invalid-invitation": 404,
  "email-taken": 409,
  "signup-disabled": 403,
  "client-too-old": 426,
  internal: 500,
};

export class HttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = STATUS[code];
  }
}

export function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError | ZodError | Error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send(errorBody(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return reply.status(400).send(errorBody("bad-request", "Invalid request.", details));
    }
    const statusCode = (error as FastifyError).statusCode;
    if (statusCode === 413) return reply.status(413).send(errorBody("too-large", "Request body is too large."));
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(errorBody("bad-request", error.message));
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send(errorBody("internal", "Internal server error."));
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send(errorBody("not-found", "Route not found.")));
}
