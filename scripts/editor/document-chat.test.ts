import assert from "node:assert/strict";
import test from "node:test";
import { chatMessageContent, normalizeChatResponseMarkdown, newDocumentContext, validateChatMessages, type ChatContext, type ChatMessage } from "../../src/lib/document-chat";

const document: ChatContext = { kind: "document", path: "notes/a.md", name: "a.md", text: "# Current draft" };
const turn: ChatMessage = { id: "1", role: "user", text: "Summarize", contexts: [document] };

test("attaches a document once and attaches new snapshots when the draft changes", () => {
  assert.deepEqual(newDocumentContext([], document), [document]);
  assert.deepEqual(newDocumentContext([turn], document), []);
  const edited = { ...document, text: "# Unsaved changes" };
  assert.deepEqual(newDocumentContext([turn], edited), [edited]);
  const history = [turn, { ...turn, id: "2", contexts: [edited] }];
  assert.deepEqual(newDocumentContext(history, edited), []);
  assert.deepEqual(newDocumentContext(history, document), [document]);
});

test("keeps documents with identical text but different paths separate", () => {
  const other = { ...document, path: "notes/b.md" };
  assert.deepEqual(newDocumentContext([turn], other), [other]);
  assert.deepEqual(newDocumentContext([turn], null), []);
  assert.deepEqual(newDocumentContext([{ ...turn, contexts: [{ ...document, kind: "selection" }] }], document), [document]);
});

test("includes selected passages with their source and the user's prompt", () => {
  const selection: ChatContext = { ...document, kind: "selection", text: "Paragraph\nSecond paragraph" };
  const content = chatMessageContent({ ...turn, contexts: [selection] });
  assert.ok(content.includes(JSON.stringify([selection])));
  assert.ok(content.endsWith("Summarize"));
  assert.equal(chatMessageContent({ id: "2", role: "assistant", text: "Answer" }), "Answer");
});

test("rejects malformed history, injected system roles and oversized contexts", () => {
  assert.equal(validateChatMessages([turn]), true);
  for (const invalid of [null, [], [null], [{ ...turn, role: "system" }], [{ ...turn, text: 42 }], [{ ...turn, contexts: [null] }], [{ ...turn, contexts: [{ ...document, text: "x".repeat(500_001) }] }]]) assert.equal(validateChatMessages(invalid), false);
});

test("response normalization unwraps Markdown but preserves code and math literals", () => {
  assert.equal(normalizeChatResponseMarkdown("```markdown\n# Title\n```"), "# Title");
  assert.equal(normalizeChatResponseMarkdown("```markdown\n# Streaming title", true), "# Streaming title");
  const code = "```js\nconst x = 1;\n```";
  assert.equal(normalizeChatResponseMarkdown(code), code);
  const literal = "Use `\\(x\\)` in code.";
  assert.equal(normalizeChatResponseMarkdown(literal), literal);
  assert.equal(
    normalizeChatResponseMarkdown(String.raw`Inline \(x\) and \[y\]`, false, { inlineMathMarkers: "@@ @@", blockMathMarkers: "%% %%" }),
    "Inline @@x@@ and \n\n%%\ny\n%%",
  );
});

test("photos become model image parts and excluded documents leave outbound history", async () => {
  const { chatCompletionContent, messagesWithoutExcludedDocuments, validateChatPhotos } = await import("../../src/lib/document-chat");
  const photo = { id: "photo-1", name: "photo.png", dataUrl: "data:image/png;base64,aGVsbG8=" };
  assert.equal(validateChatPhotos([photo]), true);
  assert.equal(validateChatPhotos([{ ...photo, dataUrl: "https://example.com/image.png" }]), false);
  assert.equal(validateChatPhotos([{ ...photo, dataUrl: "data:image/svg+xml;base64,aGVsbG8=" }]), false);
  assert.equal(validateChatPhotos(Array(5).fill(photo)), false);
  assert.deepEqual(chatCompletionContent({ ...turn, photos: [photo] }), [
    { type: "text", text: chatMessageContent(turn) },
    { type: "image_url", image_url: { url: photo.dataUrl } },
  ]);
  const selection = { ...document, kind: "selection" as const };
  const history = [{ ...turn, contexts: [document, selection] }];
  assert.deepEqual(messagesWithoutExcludedDocuments(history, [document.path])[0].contexts, [selection]);
  assert.equal(history[0].contexts.length, 2);
});
