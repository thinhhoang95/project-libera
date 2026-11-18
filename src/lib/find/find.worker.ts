// Regex-mode searches of whole documents (worker-search.ts). The runner
// terminates this worker when a search passes its deadline.
import { compileFind } from "./index";
import type { FindWorkerRequest, FindWorkerResponse } from "./worker-search";

self.onmessage = (event: MessageEvent<FindWorkerRequest>) => {
  const { id, query, options, text, within, skipped } = event.data;
  let response: FindWorkerResponse;
  try {
    const compiled = compileFind(query, options);
    response = compiled.ok
      ? { id, result: compiled.finder.find(text, { ...(within ? { within } : {}), ...(skipped ? { skipped } : {}) }) }
      : { id, error: "invalid query" };
  } catch (cause) {
    response = { id, error: cause instanceof Error ? cause.message : String(cause) };
  }
  self.postMessage(response);
};
