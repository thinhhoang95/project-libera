// Shared notebooks on disk. PLACEHOLDER until M1.5 lands: no notebook is
// shared, so every path resolves to null and no routes are registered.

import type { ControlDeps, NotebookService } from "../control/types";

export function createNotebookService(_deps: Omit<ControlDeps, "notebooks">): NotebookService {
  return {
    async start() {},
    async stop() {},
    resolvePath: () => null,
    async accountChanged() {},
    registerRoutes() {},
  };
}
