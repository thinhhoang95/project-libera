import { readTextLines } from "@/lib/text-stream";
import { isTokenUsage, type TokenUsage } from "@/lib/chat-token-usage";

export async function readChatResponse(response: Response, signal: AbortSignal, onDelta: (text: string) => void, onUsage?: (usage: TokenUsage) => void) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || "Chat request failed.");
  }
  // Supports an older local server during an app update as well as streamed replies.
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    const payload = await response.json();
    if (isTokenUsage(payload.usage)) onUsage?.(payload.usage);
    if (typeof payload.text !== "string" || !payload.text.trim()) throw new Error("The model returned an empty response.");
    onDelta(payload.text);
    return;
  }
  if (!response.body) throw new Error("The response stream is missing.");
  for await (const line of readTextLines(response.body, signal)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "usage" && isTokenUsage(event.usage)) onUsage?.(event.usage);
    if (event.type === "error") throw new Error(event.message || "Chat failed.");
    if (event.type === "done") return;
    if (event.type === "delta" && typeof event.text === "string") onDelta(event.text);
  }
  throw new Error("The connection ended before the response was complete.");
}
