import assert from "node:assert/strict";
import test from "node:test";
import { createAgentT, englishAgentT } from "../../src/lib/agent/translate";
import { createServerT } from "../../src/lib/i18n/server-translator";

// What the user reads during an agent run is translated; the English wording is the source of truth.

test("English limit notices keep their wording and format numbers", () => {
  assert.equal(englishAgentT("runner.timeLimit", { minutes: 20 }), "Stopped after 20 minutes, the time limit for one run.");
  assert.equal(englishAgentT("runner.timeLimit", { minutes: 1 }), "Stopped after 1 minute, the time limit for one run.");
  assert.equal(englishAgentT("runner.inputTokenLimit", { tokens: 5_000_000 }), "Stopped after using 5,000,000 input tokens, the limit for one run.");
  assert.equal(englishAgentT("runner.calling", { name: "Mystery" }), "Calling Mystery");
});

test("French, Vietnamese and Chinese translate the same keys", async () => {
  const fr = await createAgentT("fr");
  assert.match(fr("runner.timeLimit", { minutes: 20 }), /20 minutes/);
  assert.notEqual(fr("runner.stuck"), englishAgentT("runner.stuck"));
  assert.notEqual((await createAgentT("vi"))("runner.stuck"), englishAgentT("runner.stuck"));
  assert.notEqual((await createAgentT("zh"))("runner.stuck"), englishAgentT("runner.stuck"));
});

test("the pseudo-locale marks translated text", async () => {
  assert.match((await createAgentT("en-XA"))("runner.finishingSkills"), /^\[.*\]$/);
});

test("route notices are translated under their own namespace", async () => {
  const fr = await createServerT("fr", "aiRoutes");
  assert.notEqual(fr("format.selectText"), "Select text to format.");
  assert.equal(fr("format.failed", { detail: "boom" }).endsWith("boom"), true);
});

test("a translated activity line longer than the stored limit is cut to fit, so chat history still saves", async () => {
  const { fitAgentEvent } = await import("../../src/lib/agent/types");
  const long = "x".repeat(1_008);
  const started = fitAgentEvent({ type: "tool_started", id: "1", name: "Skill", summary: long });
  assert.equal(started.type === "tool_started" && started.summary.length, 1_000);
  const short = { type: "tool_started" as const, id: "2", name: "Read", summary: "Reading a.md" };
  assert.equal(fitAgentEvent(short), short);
  const finished = fitAgentEvent({ type: "tool_finished", id: "1", status: "ok", result: "y".repeat(2_500) });
  assert.equal(finished.type === "tool_finished" && finished.result?.length, 2_000);
});
