// Where citation formatting runs in the app: in a dedicated worker
// (format.worker.ts), so citeproc never blocks typing or scrolling. A 300-
// citation document takes from ~50 ms (numeric styles) to ~600 ms (APA,
// Chicago) in citeproc, far over a frame. The preview worker is not used: it
// re-parses the document on every keystroke, and formatting there would delay
// each preview update by the formatting time; the synchronous renderers
// (preview window, slides, PDF export) need formatting too.
//
// Results are cached by a caller-supplied signature (citations, library
// revision, style), so re-renders that do not change citations post nothing.
// Without Worker support (tests, server) or after a worker failure,
// formatting falls back to the main thread after the lazy citeproc import.

import { formatCitationDocument, loadCitationFormatter, type CitationFormatInput, type FormattedCitationDocument } from "./format";

export type CitationFormatRequest = { id: number; input: CitationFormatInput };
export type CitationFormatResponse =
  | { id: number; result: FormattedCitationDocument; error?: never }
  | { id: number; error: string; result?: never };

type Pending = { resolve: (result: FormattedCitationDocument) => void; reject: (error: Error) => void; input: CitationFormatInput };

let useWorker = true;
let worker: Worker | null = null;
let workerFailed = false;
let sequence = 0;
const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<FormattedCitationDocument>>();
const MAX_CACHED = 24;
let runs = 0;

/** How many formatting jobs ran (cache misses), for tests and diagnostics. */
export function citationFormatRunCount() {
  return runs;
}

/** Tests: force main-thread formatting, and drop cached results. */
export function configureCitationFormatting(options: { worker?: boolean; clearCache?: boolean }) {
  if (options.worker !== undefined) {
    useWorker = options.worker;
    worker?.terminate();
    worker = null;
  }
  if (options.clearCache) cache.clear();
}

async function formatOnMainThread(input: CitationFormatInput) {
  await loadCitationFormatter();
  return formatCitationDocument(input);
}

function failWorker() {
  workerFailed = true;
  worker?.terminate();
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const job of waiting) formatOnMainThread(job.input).then(job.resolve, job.reject);
}

function formatterWorker() {
  if (!useWorker || workerFailed || typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./format.worker.ts", import.meta.url), { type: "module" });
  } catch {
    workerFailed = true;
    return null;
  }
  worker.onerror = failWorker;
  worker.onmessage = (event: MessageEvent<CitationFormatResponse>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    if (event.data.result) job.resolve(event.data.result);
    else job.reject(new Error(event.data.error ?? "Could not format citations."));
  };
  return worker;
}

function run(input: CitationFormatInput): Promise<FormattedCitationDocument> {
  runs += 1;
  const target = formatterWorker();
  if (!target) return formatOnMainThread(input);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject, input });
    try {
      target.postMessage({ id, input } satisfies CitationFormatRequest);
    } catch {
      pending.delete(id);
      formatOnMainThread(input).then(resolve, reject);
    }
  });
}

/**
 * Format a document's citations off the main thread. `signature` identifies
 * the input (citations, library revision, style); the same signature returns
 * the cached result without formatting again.
 */
export function formatCitationDocumentAsync(signature: string, input: CitationFormatInput): Promise<FormattedCitationDocument> {
  const cached = cache.get(signature);
  if (cached) {
    cache.delete(signature);
    cache.set(signature, cached);
    return cached;
  }
  const result = run(input);
  cache.set(signature, result);
  result.catch(() => {
    if (cache.get(signature) === result) cache.delete(signature);
  });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return result;
}
