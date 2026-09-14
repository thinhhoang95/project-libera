// A deliberately narrow fast path: a change within a non-indented prose
// line cannot alter block structure when both versions contain only letters,
// numbers and ordinary prose punctuation. All Markdown syntax uses the parser.
export function mapProseHeadingOffsets(before: string, after: string, offsets: number[]): number[] | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const lineStart = before.lastIndexOf("\n", start - 1) + 1;
  const end = before.indexOf("\n", start);
  const lineEnd = end < 0 ? before.length : end;
  if (oldEnd > lineEnd || after.slice(start, newEnd).includes("\n")) return null;
  const delta = after.length - before.length;
  const prose = /^[\p{L}][\p{L}\p{N} ,.!?]*$/u;
  if (!prose.test(before.slice(lineStart, lineEnd)) || !prose.test(after.slice(lineStart, lineEnd + delta))) return null;
  return offsets.map(offset => offset > lineStart ? offset + delta : offset);
}

export type HeadingIndexRequest = { id: number; markdown: string };
export type HeadingIndexResponse = { id: number; offsets: number[] };

type HeadingWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

// Keep at most one parse in flight and one (replaceable) pending snapshot.
// Responses from an older snapshot must never move the current outline.
export function createMarkdownHeadingIndex(
  createWorker: () => HeadingWorker,
  publish: (markdown: string, offsets: number[]) => void,
  fallback: (markdown: string) => Promise<number[]>,
) {
  let worker: HeadingWorker | null = null;
  let unavailable = false;
  let disposed = false;
  let sequence = 0;
  let latest: HeadingIndexRequest | null = null;
  let running: HeadingIndexRequest | null = null;
  let completed: { markdown: string; offsets: number[] } | null = null;

  function complete(request: HeadingIndexRequest, offsets: number[], reusable = true) {
    if (disposed || running !== request) return;
    running = null;
    if (reusable) completed = { markdown: request.markdown, offsets };
    if (latest === request) publish(request.markdown, offsets);
    else start();
  }

  function failWorker(cause?: unknown) {
    // Keep failures observable: otherwise a worker startup error silently
    // restores whole-document parsing on the UI thread.
    console.warn("Markdown heading worker failed; using the compatibility parser.", cause);
    worker?.terminate();
    worker = null;
    unavailable = true;
    running = null;
    start();
  }

  function start() {
    if (disposed || running || !latest) return;
    const request = latest;
    const mapped = completed && mapProseHeadingOffsets(completed.markdown, request.markdown, completed.offsets);
    if (mapped) {
      completed = { markdown: request.markdown, offsets: mapped };
      publish(request.markdown, mapped);
      return;
    }
    running = request;
    if (unavailable) {
      // Older browsers/test DOMs still work; production browsers use the worker.
      void fallback(request.markdown).then(
        (offsets) => complete(request, offsets),
        () => complete(request, [], false),
      );
      return;
    }
    try {
      if (!worker) {
        worker = createWorker();
        worker.onmessage = (event: MessageEvent<HeadingIndexResponse>) => {
          if (running && event.data.id === running.id) complete(running, event.data.offsets);
        };
        worker.onerror = failWorker;
      }
      worker.postMessage(request);
    } catch (cause) {
      failWorker(cause);
    }
  }

  return {
    request(markdown: string) {
      if (disposed || latest?.markdown === markdown) return;
      latest = { id: ++sequence, markdown };
      start();
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      latest = running = completed = null;
    },
  };
}
