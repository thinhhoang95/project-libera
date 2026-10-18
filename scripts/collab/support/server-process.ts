// Starts the real collab server (server/) in a child process for desktop-side
// integration tests. The server has its own node_modules (and its own yjs), so
// it must not be imported into the test process.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const serverRoot = path.resolve(__dirname, "../../../server");

export interface ServerProcess {
  url: string;
  port: number;
  dataDir: string;
  child: ChildProcess;
  /** Graceful stop (SIGTERM). */
  stop(): Promise<void>;
  /** Abrupt kill, as in a crash. */
  kill(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "libera-collab-it-"));
}

export async function startServerProcess(options: { port?: number; dataDir?: string; env?: Record<string, string> } = {}): Promise<ServerProcess> {
  const port = options.port ?? (await freePort());
  const dataDir = options.dataDir ?? tempDataDir();
  const child = spawn(process.execPath, ["--import", "tsx", "test/support/dev-child-server.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: `pglite://${path.join(dataDir, "pglite")}`,
      BLOB_DIR: path.join(dataDir, "blobs"),
      JWT_SECRET: "integration-test-secret-integration-test",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start in time.\n${stderr}`)), 60_000);
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve((JSON.parse(line) as { url: string }).url);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}.\n${stderr}`));
    });
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    url,
    port,
    dataDir,
    child,
    async stop() {
      child.stdin?.end();
      child.kill("SIGTERM");
      await exited;
    },
    async kill() {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

export function removeDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
