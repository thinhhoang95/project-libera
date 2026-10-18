// Server compaction job (M1.10). PLACEHOLDER, implemented with the sync service.

import type { Job } from "./index.js";

export const compactionJob: Job = {
  name: "compaction",
  intervalMs: 5 * 60_000,
  async run() {},
};
