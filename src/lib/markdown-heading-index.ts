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

  function complete(request: HeadingIndexRequest, offsets: number[]) {
    if (disposed || running !== request) return;
    running = null;
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
    running = request;
    if (unavailable) {
      // Older browsers/test DOMs still work; production browsers use the worker.
      void fallback(request.markdown).then(
        (offsets) => complete(request, offsets),
        () => complete(request, []),
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
      latest = running = null;
    },
  };
}
