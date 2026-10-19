// Shared notebooks on disk: share, join, the manifest, the materializer and
// watcher, blobs, file operations, reconciliation and revocation (M1.5).

import type { ControlDeps, NotebookService } from "../control/types";
import { NotebookServiceImpl, type NotebookServiceOptions } from "./service";

export { NotebookServiceImpl, folderNameFor, invitationToken } from "./service";
export type { JoinResult, NotebookServiceOptions, ShareResult } from "./service";
export { SHARED_MARKER_FILE } from "./fs-ops";
export { diffText, applyReplacements } from "./text-diff";
export { computeLayout } from "./layout";

export function createNotebookService(deps: Omit<ControlDeps, "notebooks">, options?: NotebookServiceOptions): NotebookService {
  return new NotebookServiceImpl(deps, options);
}
