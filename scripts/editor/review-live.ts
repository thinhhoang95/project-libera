// Opt-in, paid integration check: node --import tsx scripts/editor/review-live.ts
// Uses local AI credentials, synthetic content, and an isolated temporary data directory.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { NextRequest } from "next/server";
import { POST as review } from "../../src/app/api/markdown-reviews/route";
import { POST as agent } from "../../src/app/api/document-review/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { getAiFunctionOptions } from "../../src/lib/ai-preferences";
import { getOpenRouterApiKey } from "../../src/lib/openrouter";
import { readReview } from "../../src/lib/storage/markdown-reviews";
import type { ReviewDocument } from "../../src/lib/markdown-review";

async function main() {
  loadEnvConfig(process.cwd());
  const configArgument = process.argv.indexOf("--config");
  if (configArgument !== -1) {
    const configPath = process.argv[configArgument + 1];
    assert.ok(configPath, "Provide the desktop config path after --config.");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.ok(typeof config.openaiApiKey === "string" && config.openaiApiKey.trim(), "Desktop settings have no API key.");
    process.env.OPENROUTER_API_KEY = config.openaiApiKey.trim();
    process.env.LIBERA_AI_CHAT_MODEL = config.aiFunctions?.chat?.model || config.openRouterModel || "google/gemini-3.5-flash";
    process.env.LIBERA_AI_CHAT_REASONING_EFFORT = config.aiFunctions?.chat?.reasoningEffort || "medium";
  }
  assert.ok(getOpenRouterApiKey(), "No compatible OpenRouter key is configured.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-live-"));
  const previousDirectory = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const usage: unknown[] = [];
  const original = "The workshop starts at 9 am.\n\nBring a laptop to the workshop.\n\nRegistration closes on Friday.";
  const references = [{ kind: "document", name: "schedule.md", path: "Fixtures/schedule.md", text: "The workshop starts at 10 am in the Cypress room. Participants should bring a laptop and its charger." }];
  let doc!: ReviewDocument;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      calls++;
      const payload = JSON.parse(String(init?.body));
      const context = JSON.parse(payload.messages[1].content);
      assert.equal(context.target.markdown, doc.snapshot, "Send the complete current draft.");
      assert.deepEqual(context.references, references, "Send complete @ references.");
      assert.equal(context.comments.length, 2);
    }
    const response = await originalFetch(input, init);
    if (url.endsWith("/chat/completions") && !response.ok) {
      console.log(JSON.stringify({ stage: "Provider response", status: response.status }));
    }
    if (url.endsWith("/chat/completions") && response.ok) {
      const result = await response.clone().json();
      usage.push({ model: result.model, usage: result.usage, finishReason: result.choices?.[0]?.finish_reason });
    }
    return response;
  };
  function request(body: unknown) {
    return new NextRequest("http://localhost/api/review", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
  }
  async function result(response: Response) {
    const body = await response.json();
    assert.equal(response.status, 200, body.error || `HTTP ${response.status}`);
    doc = body;
  }
  async function mutate(action: string, fields = {}) {
    await result(await review(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, ...fields })));
  }
  async function run(stage: string, action: string, prompt: string, fields = {}) {
    const started = Date.now();
    console.log(JSON.stringify({ stage, status: "running" }));
    await result(await agent(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, planVersion: doc.session?.plan.version, prompt, ids: doc.threads.map(t => t.id), references, ...fields })));
    assert.equal(doc.snapshot, original, "Planning and generation must not modify the draft.");
    console.log(JSON.stringify({ stage, status: "passed", seconds: Math.round((Date.now() - started) / 1000), version: doc.session?.plan.version, pending: doc.session?.suggestions.filter(s => s.status === "pending").length }));
  }
  try {
    console.log(JSON.stringify({ model: getAiFunctionOptions("chat").model, syntheticContentOnly: true }));
    await result(await review(request({ action: "load", key: "Fixtures/workshop.md", snapshot: original })));
    await mutate("comment", { range: { start: 0, end: original.indexOf("\n\n") }, text: "Correct the start time using @schedule.md." });
    const secondStart = original.indexOf("Bring");
    await mutate("comment", { range: { start: secondStart, end: original.indexOf("\n\n", secondStart) }, text: "Include the charger from @schedule.md in the packing instructions." });
    await run("Initial plan", "plan", "Plan how to address both comments. These are two independent paragraph changes; keep their proposals separate. Preserve the registration paragraph.");
    assert.equal(doc.session?.phase, "awaiting_confirmation");
    assert.equal(doc.session?.plan.version, 1);
    await run("Plan revision", "plan", "Revise the plan: also name the Cypress room from @schedule.md in the first paragraph. Keep the two changes independent. No questions are needed; use the reference facts.");
    assert.equal(doc.session?.plan.version, 2);
    assert.equal(doc.session?.plan.blockingQuestions.length, 0);
    assert.match(JSON.stringify(doc.session?.plan), /Cypress/i);
    await run("Confirmed generation", "generate", "I confirm this plan. Generate two separate proposals, one for each commented paragraph, using the confirmed plan.");
    const pending = doc.session!.suggestions.filter(s => s.status === "pending");
    assert.equal(pending.length, 2, "Independent comments should produce individually decidable proposals.");
    const first = pending.find(s => s.commentIds.includes(doc.threads[0].id))!;
    const second = pending.find(s => s.commentIds.includes(doc.threads[1].id))!;
    assert.ok(first && second && first.id !== second.id);
    assert.match(first.edits.map(e => e.after).join(" "), /10/);
    assert.match(first.edits.map(e => e.after).join(" "), /Cypress/i);
    assert.match(second.edits.map(e => e.after).join(" "), /charger/i);
    await run("Individual proposal revision", "revise", "Revise only this packing proposal to say explicitly: Bring a laptop, its charger, and a spare charger to the workshop. Keep the time/room proposal unchanged.", { suggestionId: second.id });
    assert.equal(doc.session!.suggestions.find(s => s.id === second.id)?.status, "superseded");
    assert.deepEqual(doc.session!.suggestions.find(s => s.id === first.id), first);
    const revised = doc.session!.suggestions.find(s => s.status === "pending" && s.id !== first.id)!;
    assert.ok(revised);
    assert.match(revised.edits.map(e => e.after).join(" "), /spare charger/i);
    await mutate("decision", { ids: [first.id], decision: "accept" });
    const accepted = doc.snapshot;
    assert.notEqual(accepted, original);
    assert.match(accepted, /Cypress/);
    assert.ok(accepted.includes("Bring a laptop to the workshop."));
    assert.ok(accepted.endsWith("Registration closes on Friday."));
    assert.equal(doc.session!.suggestions.find(s => s.id === revised.id)?.status, "pending");
    await mutate("decision", { ids: [revised.id], decision: "reject" });
    assert.equal(doc.snapshot, accepted);
    assert.equal(doc.session!.phase, "completed");
    assert.equal(doc.threads[0].status, "addressed");
    assert.equal(doc.threads[1].status, "open");
    await mutate("undo");
    assert.equal(doc.snapshot, original);
    assert.equal(doc.session!.suggestions.find(s => s.id === revised.id)?.status, "rejected");
    await mutate("redo");
    assert.equal(doc.snapshot, accepted);
    assert.deepEqual(await readReview(doc.id), doc);
    console.log(JSON.stringify({ stage: "Accept, reject, undo, redo, and persistence", status: "passed", completionCalls: calls, usage }));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  const key = getOpenRouterApiKey();
  const message = error instanceof Error ? error.message : String(error);
  console.error(key ? message.replaceAll(key, "[redacted]") : message);
  process.exitCode = 1;
});
