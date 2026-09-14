import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { readSseData } from "../../src/lib/text-stream";
import { readChatResponse } from "../../src/components/libera/chat-stream-client";
import { POST } from "../../src/app/api/document-chat/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";

function byteStream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
}

test("SSE handles split UTF-8, CRLF, comments, multiline data and a trailing frame", async () => {
  const data = [];
  for await (const event of readSseData(byteStream(': heartbeat\r\ndata: Xin chào 👋\r\ndata: world\r\n\r\ndata: [DONE]'))) data.push(event);
  assert.deepEqual(data, ['Xin chào 👋\nworld', '[DONE]']);
});

test("client keeps emitted text and rejects truncated or failed streams", async () => {
  const signal = new AbortController().signal;
  let text = "";
  const response = (events: object[]) => new Response(byteStream(events.map((event) => JSON.stringify(event)).join("\n")), { headers: { "Content-Type": "application/x-ndjson" } });
  await assert.rejects(readChatResponse(response([{ type: "delta", text: "Partial 👋" }]), signal, (delta) => { text += delta; }), /before.*complete/);
  assert.equal(text, "Partial 👋");
  await assert.rejects(readChatResponse(response([{ type: "error", message: "Provider failed" }]), signal, () => {}), /Provider failed/);
  await assert.rejects(readChatResponse(Response.json({ error: "Unauthorized" }, { status: 401 }), signal, () => {}), /Unauthorized/);
});

test("chat route streams only answer text and carries model settings to OpenRouter", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const requests: Record<string, unknown>[] = [];
  let fail = false;
  globalThis.fetch = async (_input, init) => {
    if (String(_input).endsWith("/endpoints")) return Response.json({ data: { endpoints: [{ tag: "test-provider", supports_implicit_caching: true }] } });
    requests.push(JSON.parse(String(init?.body)));
    const events = [
      ': OPENROUTER PROCESSING\n\n',
      'data: {"choices":[{"delta":{"reasoning":"Private reasoning"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello 👋"}}]}\n\n',
      fail ? 'data: {"error":{"message":"Provider failed"}}\n\n' : 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    return new Response(byteStream(events.join('')), { headers: { "Content-Type": "text/event-stream" } });
  };
  const request = () => new NextRequest("http://localhost/api/document-chat", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify({ stream: true, reasoningEffort: "max", messages: [{ id: "1", role: "user", text: "Hello" }] }) });
  try {
    const response = await POST(request());
    assert.match(response.headers.get("Content-Type")!, /ndjson/);
    let text = "";
    await readChatResponse(response, new AbortController().signal, (delta) => { text += delta; });
    assert.equal(text, "Hello 👋 world");
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].reasoning, { effort: "max" });
    fail = true;
    let partial = "";
    await assert.rejects(readChatResponse(await POST(request()), new AbortController().signal, (delta) => { partial += delta; }), /Provider failed/);
    assert.equal(partial, "Hello 👋");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("aborting a stream cancels a pending read promptly", async () => {
  const cancellation = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const reading = readChatResponse(new Response(body), cancellation.signal, () => {});
  cancellation.abort();
  await assert.rejects(reading);
  assert.equal(canceled, true);
});
