import assert from "node:assert/strict";
import test from "node:test";
import { chatUsageRequests, parseOpenRouterUsage, totalChatUsage } from "../../src/lib/chat-token-usage";
import { validateChatStore } from "../../src/lib/document-chat";

test("usage distinguishes unreported cache counts from zero and ignores malformed counts", () => {
  assert.equal(parseOpenRouterUsage(null), undefined);
  assert.equal(parseOpenRouterUsage({ prompt_tokens: -1, completion_tokens: 2 }), undefined);
  assert.equal(parseOpenRouterUsage({ prompt_tokens: 1, completion_tokens: 1.5 }), undefined);
  assert.deepEqual(parseOpenRouterUsage({ prompt_tokens: 10, completion_tokens: 2 }), { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(parseOpenRouterUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }), { inputTokens: 10, outputTokens: 2, cachedTokens: 0 });
});

test("legacy chats preserve unknown usage and validate saved usage independently from history", () => {
  const chat = { id: "chat", title: "Chat", messages: [{ id: "u", role: "user", text: "Hi" }, { id: "a", role: "assistant", text: "Hello" }], prompt: "", selections: [] };
  const legacy = chatUsageRequests(chat);
  assert.deepEqual(legacy, [{ id: "a", messageId: "u" }]);
  const usageRequests = [...legacy, { id: "retry", messageId: "u", usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 50 } }, { id: "later", messageId: "u2", usage: { inputTokens: 200, outputTokens: 20 } }];
  assert.deepEqual(totalChatUsage(usageRequests), { inputTokens: 300, outputTokens: 30, cachedTokens: 50, reported: 2, cacheReported: 1 });
  assert.ok(validateChatStore({ chats: [chat], activeId: "chat" }));
  assert.ok(validateChatStore({ chats: [{ ...chat, usageRequests }], activeId: "chat" }));
  assert.equal(validateChatStore({ chats: [{ ...chat, usageRequests: [{ id: "bad", messageId: "u", usage: { inputTokens: -1, outputTokens: 0 } }] }], activeId: "chat" }), false);
});
