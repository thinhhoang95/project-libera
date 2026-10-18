// Test helpers: an in-memory PGlite server on a free port.

import { buildServer, type CollabServer } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export interface TestServer {
  server: CollabServer;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const config = loadConfig(
    { NODE_ENV: "test", DATABASE_URL: "pglite://memory", PORT: "0", ALLOW_OPEN_SIGNUP: "1" },
    overrides,
  );
  const server = await buildServer({ config, jobs: false });
  const url = await server.listen();
  return {
    server,
    url,
    wsUrl: `${url.replace(/^http/, "ws")}/sync`,
    close: () => server.close(),
  };
}

export async function json<T = unknown>(
  url: string,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}
