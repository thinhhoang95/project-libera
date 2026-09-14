import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createMarkdownHeadingIndex, type HeadingIndexRequest, type HeadingIndexResponse } from "../../src/lib/markdown-heading-index";
import { markdownHeadingOffsets } from "../../src/lib/markdown-review";

function harness() {
  const requests: HeadingIndexRequest[] = [];
  const published: { markdown: string; offsets: number[] }[] = [];
  let terminated = 0;
  const worker = {
    onmessage: null as ((event: MessageEvent<HeadingIndexResponse>) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: (request: HeadingIndexRequest) => { requests.push(request); },
    terminate: () => { terminated++; },
  };
  const client = createMarkdownHeadingIndex(
    () => worker,
    (markdown, offsets) => published.push({ markdown, offsets }),
    async () => { throw new Error("Must not parse on the main thread while the worker works"); },
  );
  const reply = (id: number, offsets: number[]) => worker.onmessage?.({ data: { id, offsets } } as MessageEvent<HeadingIndexResponse>);
  return { client, requests, published, reply, worker, terminated: () => terminated };
}

test("heading worker coalesces edits and never publishes stale positions", () => {
  const h = harness();
  h.client.request("# Initial");
  h.client.request("# Intermediate");
  h.client.request("\n# Latest");
  assert.equal(h.requests.length, 1, "Only one parse may be in flight");
  h.reply(h.requests[0].id, [0]);
  assert.deepEqual(h.published, [], "Old positions must not move the current outline");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].markdown, "\n# Latest", "Skip all intermediate snapshots");
  h.reply(h.requests[0].id, [0]);
  assert.deepEqual(h.published, [], "Ignore duplicate/out-of-order replies");
  h.reply(h.requests[1].id, [1]);
  assert.deepEqual(h.published, [{ markdown: "\n# Latest", offsets: [1] }]);
  h.client.request("\n# Latest");
  assert.equal(h.requests.length, 2, "Reuse the current index for selection/scroll changes");
  h.client.dispose();
  assert.equal(h.terminated(), 1);
});

test("disposing an index ignores pending replies and future requests", () => {
  const h = harness();
  h.client.request("# Old tab");
  h.client.request("# Pending");
  h.client.dispose();
  h.reply(h.requests[0].id, [0]);
  h.client.request("# Closed");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.published, []);
});

test("worker construction and runtime failures fall back using only the latest snapshot", async () => {
  for (const constructionFailure of [true, false]) {
    let fail!: () => void;
    const parsed: string[] = [];
    const published: string[] = [];
    const client = createMarkdownHeadingIndex(
      () => {
        if (constructionFailure) throw new Error("Worker unavailable");
        const worker = { onmessage: null, onerror: null as (() => void) | null, postMessage: () => {}, terminate: () => {} };
        fail = () => worker.onerror?.();
        return worker;
      },
      (markdown) => published.push(markdown),
      async (markdown) => { parsed.push(markdown); return [0]; },
    );
    client.request("# First");
    client.request("# Last");
    if (!constructionFailure) fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(parsed.at(-1), "# Last");
    assert.deepEqual(published, ["# Last"]);
    client.dispose();
  }
});

test("the real worker entry preserves nested, setext, fenced-code and math heading semantics", async () => {
  // Run the browser entry in an actual thread with a small self/parentPort
  // adapter. This exercises its imports and message protocol without a DOM.
  const worker = new Worker(`
    require("tsx/cjs");
    const { parentPort, workerData } = require("node:worker_threads");
    globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
    require(workerData.entry);
    parentPort.on("message", (data) => self.onmessage({ data }));
  `, { eval: true, workerData: { entry: fileURLToPath(new URL("../../src/lib/markdown-headings.worker.ts", import.meta.url)) } });
  const markdown = "# First\r\n\r\n> ## Nested\r\n> Body\r\n\r\nSetext\r\n------\r\n\r\n```md\r\n# Hidden\r\n```\r\n\r\n$$\r\nx^2\r\n$$\r\n\r\n## Last";
  try {
    const result = new Promise<HeadingIndexResponse>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.postMessage({ id: 42, markdown });
    assert.deepEqual(await result, { id: 42, offsets: markdownHeadingOffsets(markdown) });
  } finally {
    await worker.terminate();
  }
});
