// Assembles the control API: runtime (account, host, notebook service),
// HTTP server and routes. Used by the utilityProcess entry and by tests,
// which run it under plain Node against the real collab server.

import { registerAccountRoutes } from "./routes-account";
import { registerDocRoutes, type DocRouteOptions } from "./routes-docs";
import { registerProjectRoutes } from "./routes-projects";
import { CollabRuntime, type CollabRuntimeOptions } from "./runtime";
import { ControlServer, type ControlAddress, type ControlServerOptions } from "./server";

export interface ControlAppOptions extends CollabRuntimeOptions {
  server?: ControlServerOptions;
  docs?: DocRouteOptions;
}

export interface ControlApp {
  runtime: CollabRuntime;
  server: ControlServer;
  address: ControlAddress;
  /** Stops accepting requests, then flushes and closes the host. */
  close(): Promise<void>;
}

export async function startControlApp(options: ControlAppOptions): Promise<ControlApp> {
  const runtime = new CollabRuntime(options);
  const server = new ControlServer({ logger: options.logger, ...options.server });
  registerAccountRoutes(server.routes, runtime);
  registerProjectRoutes(server.routes, runtime);
  registerDocRoutes(server.routes, runtime, options.docs);
  // Core routes first; shared-notebook routes (share, join, files,
  // reconciliations) come from the current NotebookService.
  server.mount(runtime.notebookRoutes);
  await runtime.start();
  let address: ControlAddress;
  try {
    address = await server.listen();
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    runtime,
    server,
    address,
    close() {
      closing ??= (async () => {
        await server.close();
        await runtime.stop();
      })();
      return closing;
    },
  };
}

export { ControlServer, CollabRuntime };
export type { ControlAddress };
