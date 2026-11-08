// Deletes blob objects no project has referenced for the grace period (blobs/gc.ts).

import { collectOrphanedBlobs } from "../blobs/gc.js";
import type { Job } from "./index.js";

export const blobGcJob: Job = {
  name: "blob-gc",
  intervalMs: 60 * 60_000,
  async run(context) {
    const removed = await collectOrphanedBlobs(context);
    if (removed) context.log.info({ removed }, "Orphaned blobs deleted");
  },
};
