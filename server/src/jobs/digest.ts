// Daily notification email digest (M2.3). PLACEHOLDER, implemented with the API.

import type { Job } from "./index.js";

export const digestJob: Job = {
  name: "digest",
  intervalMs: 60 * 60_000,
  async run() {},
};
