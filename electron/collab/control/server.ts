// The host's loopback control API (collaboration map §3, §10).
//
// node:http on 127.0.0.1 with a per-launch random bearer token. Next is the
// only intended client (it receives the URL and token as
// LIBERA_COLLAB_HOST_URL / LIBERA_COLLAB_HOST_TOKEN); the renderer reaches it
// through the authenticated /api/collab routes. JSON in and out; errors are
// `{ error: { code, message } }`.
//
// Hardening, because any local process and any web page can reach 127.0.0.1:
// - every request needs the bearer token (compared in constant time);
// - the Host header must name the loopback address, which defeats DNS
//   rebinding even if a token leaked into a page;
// - no CORS headers are ever sent, so browsers cannot read responses;
// - request bodies are capped.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { ApiClientError } from "../core/api-client";
import type { Logger } from "../core/clock";
import { consoleLogger } from "../core/clock";
import { Router } from "./router";
import { ControlError, type ControlRequest, type ControlResponse } from "./types";

/** Large enough for a whole document's text in one docEdits request. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface ControlServerOptions {
  /** Defaults to 32 random bytes, base64url. Main passes one so it survives host restarts. */
  token?: string;
  /** 0 (default) picks a free port. */
  port?: number;
  maxBodyBytes?: number;
  logger?: Logger;
}

export interface ControlAddress {
  url: string;
  port: number;
  token: string;
}

export function newControlToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Maps a failure from a handler to an HTTP status and error body.
 * 401 is reserved for a bad control token (Next and the renderer treat 401
 * as "the local session expired"), so an upstream 401 becomes 403 with the
 * server's code, and a missing collab session becomes 409 `needs-sign-in`.
 */
export function errorResponse(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof ControlError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ApiClientError) {
    if (error.code === "needs-sign-in") return { status: 409, code: "needs-sign-in", message: error.message };
    if (error.status === 0) return { status: 503, code: "offline", message: `The collaboration server is unreachable: ${error.message}` };
    const status = error.status === 401 ? 403 : error.status >= 400 && error.status < 600 ? error.status : 502;
    return { status, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { status: 500, code: "internal", message: error instanceof Error ? error.message : String(error) };
}

function tokensEqual(expected: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length).trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class ControlServer {
  readonly token: string;
  /** Core routes (account, projects, documents). */
  readonly routes = new Router();
  private readonly routers: Router[] = [this.routes];
  private readonly tokenBytes: Buffer;
  private readonly maxBodyBytes: number;
  private readonly requestedPort: number;
  private readonly logger: Logger;
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();

  constructor(options: ControlServerOptions = {}) {
    this.token = options.token ?? newControlToken();
    this.tokenBytes = Buffer.from(this.token);
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.requestedPort = options.port ?? 0;
    this.logger = options.logger ?? consoleLogger;
  }

  /** Adds another route table (the shared-notebook routes), consulted after the core routes. */
  mount(router: Router): void {
    if (!this.routers.includes(router)) this.routers.push(router);
  }

  get address(): ControlAddress {
    return { url: `http://127.0.0.1:${this.port}`, port: this.port, token: this.token };
  }

  async listen(): Promise<ControlAddress> {
    if (this.server) return this.address;
    const server = createServer((request, response) => void this.serve(request, response));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    // Keep-alive sockets from Next's fetch would otherwise hold close() open.
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.address;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
  }

  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.hostAllowed(request.headers.host)) {
        throw new ControlError(403, "forbidden-host", "The control API only answers loopback requests.");
      }
      if (!tokensEqual(this.tokenBytes, request.headers.authorization)) {
        throw new ControlError(401, "unauthorized", "A valid control token is required.");
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = (request.method ?? "GET").toUpperCase();
      const body = await this.readBody(request);
      const result = await this.dispatch({ method, path: url.pathname, params: {}, query: url.searchParams, body });
      this.send(response, result.status ?? (result.body === undefined ? 204 : 200), result.body);
    } catch (error) {
      const failure = errorResponse(error);
      if (failure.status >= 500) this.logger.warn(`Control API ${request.method} ${request.url} failed`, error);
      const { status, ...rest } = failure;
      this.send(response, status, { error: rest });
      // A body we refused to read must not be parsed as the next request.
      if (status === 413) request.socket.destroy();
    }
  }

  /** Routes a parsed request; also used by tests and in-process callers. */
  async dispatch(request: ControlRequest): Promise<ControlResponse> {
    let methodMismatch = false;
    for (const router of this.routers) {
      const match = router.match(request.method, request.path);
      if (match === "method-not-allowed") {
        methodMismatch = true;
        continue;
      }
      if (match) return match.handler({ ...request, params: match.params });
    }
    if (methodMismatch) throw new ControlError(405, "method-not-allowed", `${request.method} is not supported for ${request.path}.`);
    throw new ControlError(404, "not-found", `No control route for ${request.method} ${request.path}.`);
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > this.maxBodyBytes) throw new ControlError(413, "too-large", "The request body is too large.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > this.maxBodyBytes) throw new ControlError(413, "too-large", "The request body is too large.");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return undefined;
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ControlError(400, "bad-request", "The request body is not valid JSON.");
    }
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    if (status === 204 || body === undefined) {
      response.writeHead(status === 200 ? 204 : status, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    response.end(payload);
  }
}
