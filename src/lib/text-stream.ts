/** Decode UTF-8 incrementally; network chunks need not align with lines or characters. */
export async function* readTextLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        yield line;
      }
      if (buffered.length > 2_000_000) throw new Error("Stream event exceeds the size limit.");
      if (done) break;
    }
    if (buffered) yield buffered.replace(/\r$/, "");
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* readSseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  let data: string[] = [];
  for await (const line of readTextLines(body, signal)) {
    if (!line) {
      if (data.length) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length) yield data.join("\n");
}
