import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { runAgent } from "../../src/lib/agent/runner";
import { activeTools, toolsForPermission, type ToolContext } from "../../src/lib/agent/tools";
import { createFactCheckCitationsSkill, FACT_CHECK_SKILL } from "../../src/lib/agent/skills/fact-check-citations";
import { createCheckCitationsTool, VERIFIER_SYSTEM } from "../../src/lib/agent/fact-check/check-citations";
import { finishComments } from "../../src/lib/agent/skills/leave-review-comments";
import { finishSuggestedEdits } from "../../src/lib/agent/suggest-edit";
import type { AgentEvent } from "../../src/lib/agent/types";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { readAgentEvents } from "../../src/components/libera/chat-stream-client";
import { fixtureFetch, testHttpClient, testSettings } from "./references-resolve-helpers";
import { addWorks, lastToolResult, makeContext, profile, reply, reviews, scriptedModel, withLibrary, work, writePdf, writeText, type ModelBody } from "./references-factcheck-helpers";

const existence = { existence: { settings: testSettings(), http: testHttpClient(fixtureFetch()) } };
const offline = { existence: { settings: testSettings({ lookupOnline: false }) } };

async function seedTwoSources(root: string) {
  await writePdf(root, "Research/papers/smith.pdf", [
    "Sparse attention for long documents\nA. Smith",
    "Results. Memory use fell by 40% with sparse attention.",
    "Discussion.",
    "Appendix.",
  ]);
  await writePdf(root, "Research/papers/lee.pdf", [
    "Dense retrieval at scale\nA. Lee\nDense retrieval improved recall by 12% on two of five benchmarks.",
    "Precision was unchanged in our experiments.",
  ]);
  return addWorks([
    work("smith2020", "Sparse attention for long documents", "Smith", 2020, { attachments: [{ kind: "pdf", path: "Research/papers/smith.pdf" }] }),
    work("lee2021", "Dense retrieval at scale", "Lee", 2021, { attachments: [{ kind: "pdf", path: "Research/papers/lee.pdf" }] }),
  ]);
}

function isBatch(prompt: string) {
  return prompt.startsWith("Document: ") && prompt.includes("\nClaims:");
}

function isUncited(prompt: string) {
  return prompt.includes("Works with files in this notebook");
}

async function check(context: ToolContext, args: Record<string, unknown>, deps = offline) {
  return createCheckCitationsTool(deps).run(args, context);
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

test("checker children get a scoped toolset, submit structured verdicts, and get one repair round", async () => {
  await withLibrary(async ({ root }) => {
    await seedTwoSources(root);
    await writeText(root, "Research/draft.md", "Memory use fell by 40% [@smith2020, p. 2].\n\nRecall improved [@lee2021, p. 1].\n");
    const bodies = scriptedModel((prompt, turn, body) => {
      assert.ok(isBatch(prompt), prompt);
      return [
        () => reply({ calls: [{ id: "r1", name: "Read", args: { file_path: "Research/secret.md" } }, { id: "r2", name: "Read", args: { file_path: "Research/papers/smith.pdf", pages: "2" } }] }),
        () => reply({ calls: [{ id: "s1", name: "SubmitVerdicts", args: { verdicts: [{ occurrence: "c1", key: "smith2020", verdict: "supported", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention." }], webSources: [], confidence: 0.9, note: "Page 2 says so." }] } }] }),
        () => {
          assert.match(lastToolResult(body), /SubmitVerdicts was not accepted:\n- Missing verdicts for: c2 \/ @lee2021\./);
          return reply({ calls: [{ id: "s2", name: "SubmitVerdicts", args: { verdicts: [
            { occurrence: "c1", key: "smith2020", verdict: "supported", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention." }], webSources: [], confidence: 0.9, note: "Page 2 says so." },
            { occurrence: "c2", key: "lee2021", verdict: "supported", evidence: [{ path: "Research/papers/lee.pdf", page: 1, quote: "Dense retrieval improved recall by 12%" }], webSources: [], confidence: 0.8, note: "Page 1." },
          ] } }] });
        },
      ][turn]();
    });
    const { context, events } = makeContext("read-only");
    const result = await check(context, { path: "Research/draft.md", missingReferences: false });

    const child = bodies[0];
    assert.equal(child.messages[0].content, VERIFIER_SYSTEM);
    assert.deepEqual(child.tools!.map((tool) => tool.function.name), ["Read", "Grep", "Glob", "SubmitVerdicts"], "no References, no edits, no web search unless allowed");
    assert.match(child.messages[1].content, /Sources:\n- @smith2020: Smith, A\. \(2020\)\. Sparse attention for long documents\.\n  Files: Research\/papers\/smith\.pdf \(4 pages\)/);
    assert.match(child.messages[1].content, /Submit one verdict for each of these 2 pairs: c1\/@smith2020, c2\/@lee2021\./);
    assert.match(bodies[1].messages.find((message) => message.tool_call_id === "r1")!.content, /Research\/secret\.md is outside this check/);
    assert.match(bodies[1].messages.find((message) => message.tool_call_id === "r2")!.content, /--- Page 2 ---\nResults\. Memory use fell/);

    assert.match(result.text, /^Ran 1 subagent \(1 batch for 2 sources\), estimated ~[\d,]+ input tokens of the 5,000,000 left in this run's budget\./);
    assert.match(result.text, /- \*\*Verdicts:\*\* supported 2/);
    assert.match(result.text, /0 review comments and 0 suggested edits/);
    const steps = events.filter((event) => event.type === "subagent_started" || event.type === "subagent_finished");
    assert.deepEqual(steps.map((event) => event.type === "subagent_finished" ? event.outcome : event.label), ["Checking smith2020, lee2021 (2 claims)", "completed"]);
    assert.ok(events.some((event) => event.type === "tool_finished" && /1 subagent/.test(event.result)), "the plan is shown as a step before the children start");
    assert.equal(context.usage!.inputTokens, 3000, "the child's tokens count toward the run");
  });
});

test("batches that cannot start for the budget come back as not checked, and Continue checks only those", async () => {
  await withLibrary(async ({ root }) => {
    await seedTwoSources(root);
    await writeText(root, "Research/draft.md", "Memory use fell by 40% [@smith2020, p. 2].\n\nRecall improved [@lee2021, p. 1].\n");
    scriptedModel(() => { throw new Error("no child should start"); });
    const { context } = makeContext("read-only", { budget: { maxInputTokens: 1_000, inputTokens: 1_000 } });
    const result = await check(context, { path: "Research/draft.md" });
    assert.match(result.text, /of the 0 left in this run's budget/);
    assert.match(result.text, /- \*\*Not checked:\*\* c1 \[@smith2020, p\. 2\], c2 \[@lee2021, p\. 1\] \(the run's token budget was used up\)\. Say “Continue” to check only these\./);
    assert.match(result.text, /- \*\*Uncited claims:\*\* not checked \(the run's token budget was used up\)/);
    assert.equal(await finishComments(context, { final: true }), null);
    assert.deepEqual(await reviews(root), [], "nothing is written for unchecked occurrences");

    // "Continue": a later turn checks only the listed occurrences.
    const prompts: string[] = [];
    scriptedModel((prompt) => {
      prompts.push(prompt);
      return reply({ calls: [{ id: "s", name: "SubmitVerdicts", args: { verdicts: [{ occurrence: "c2", key: "lee2021", verdict: "not-supported", evidence: [], webSources: [], confidence: 0.7, note: "Lee reports recall, not this." }] } }] });
    });
    const next = makeContext("read-only");
    const continued = await check(next.context, { path: "Research/draft.md", occurrences: ["c2"] });
    assert.equal(prompts.length, 1, "no missing-references check when continuing");
    assert.doesNotMatch(prompts[0], /c1/);
    assert.match(continued.text, /Checked 1 citation in 1 occurrence \(of 2\)\./);
    assert.match((await check(next.context, { path: "Research/draft.md", occurrences: ["c2"] })).text, /c2 was already checked in this turn/);
    await assert.rejects(check(next.context, { path: "Research/draft.md", occurrences: ["c7"] }), /c7 is not an occurrence of Research\/draft\.md, which has c1–c2/);
  });
});

// ---------------------------------------------------------------------------
// Missing references
// ---------------------------------------------------------------------------

test("missing references: a verified passage becomes a suggested citation; otherwise an uncited-claim comment", async () => {
  await withLibrary(async ({ root }) => {
    await seedTwoSources(root);
    await writeText(root, "Research/draft.md", [
      "# Notes",
      "Memory use fell by 40% [@smith2020, p. 2].",
      "Sparse attention reduces memory use by 40 percent.",
      "Dense methods improved recall by twelve points.",
      "Quantum computers solve this instantly.",
    ].join("\n\n") + "\n");
    scriptedModel((prompt) => {
      if (isBatch(prompt)) return reply({ calls: [{ id: "v", name: "SubmitVerdicts", args: { verdicts: [{ occurrence: "c1", key: "smith2020", verdict: "supported", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention." }], webSources: [], confidence: 0.9, note: "Yes." }] } }] });
      assert.ok(isUncited(prompt));
      assert.match(prompt, /- @lee2021: Dense retrieval at scale — Research\/papers\/lee\.pdf/);
      return reply({ calls: [{ id: "u", name: "SubmitUncitedClaims", args: { claims: [
        { sentence: "Sparse attention reduces memory use by 40 percent.", found: true, key: "smith2020", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention." }], note: "Smith p. 2." },
        { sentence: "Dense methods improved recall by twelve points.", found: true, key: "lee2021", evidence: [{ path: "Research/papers/lee.pdf", page: 1, quote: "Recall improved by twelve points on all benchmarks." }], note: "Invented quote." },
        { sentence: "Quantum computers solve this instantly.", found: false, evidence: [], note: "Nothing in the notebook." },
      ] } }] });
    });
    const { context } = makeContext("read-only");
    const result = await check(context, { path: "Research/draft.md" });
    assert.match(result.text, /- \*\*Uncited claims:\*\* 3 \(1 with a suggested citation\)/);
    assert.equal(await finishComments(context, { final: false }), null);
    await finishSuggestedEdits(context);
    const [doc] = await reviews(root);
    assert.deepEqual(doc.agentSuggestions!.map((suggestion) => [suggestion.edits[0].before, suggestion.edits[0].after]), [
      ["Sparse attention reduces memory use by 40 percent.", "Sparse attention reduces memory use by 40 percent [@smith2020, p. 2]."],
    ]);
    const texts = doc.threads.map((thread) => thread.messages[0].text);
    assert.equal(texts.filter((text) => text === "uncited claim — no source found in this notebook").length, 2, "the unverifiable proposal is not suggested");
    assert.ok(texts.some((text) => text.startsWith("Uncited claim. A source in this notebook supports it:\n  > “Memory use fell by 40% with sparse attention.” (Research/papers/smith.pdf, p. 2)")));
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const PLANTED = `# Findings

Sparse attention cut memory use by 40% [@smith2020, p. 3].

Dense retrieval always doubles recall [@lee2021, p. 1].

Lee reported a 50% gain in precision [@lee2021, p. 2].

Quantum heads improve attention [@ghost2021].

Sparse models train faster [@smth2020].

Transformers use three times more energy than recurrent networks.
`;

test("end to end in Read Only: planted errors become comments, suggestions and a report", async () => {
  await withLibrary(async ({ root }) => {
    await seedTwoSources(root);
    await addWorks([work("ghost2021", "Quantum gravitational heads for sparse transformer attention", "Ghost", 2021)]);
    await writeText(root, "Research/draft.md", PLANTED);
    let finalReport = "";
    const bodies = scriptedModel((prompt, turn, body: ModelBody) => {
      if (isBatch(prompt)) {
        return [
          () => reply({ calls: [{ id: "g", name: "Grep", args: { pattern: "memory|recall|precision", "-i": true, output_mode: "content" } }] }),
          () => reply({ calls: [{ id: "v", name: "SubmitVerdicts", args: { verdicts: [
            { occurrence: "c1", key: "smith2020", verdict: "supported", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention." }], webSources: [], confidence: 0.9, note: "Stated on page 2." },
            { occurrence: "c2", key: "lee2021", verdict: "partially-supported", evidence: [{ path: "Research/papers/lee.pdf", page: 1, quote: "Dense retrieval improved recall by 12% on two of five benchmarks." }], webSources: [], confidence: 0.85, note: "Lee reports a 12% gain on two of five benchmarks, not a doubling.", suggestedText: "Dense retrieval improved recall by 12% on two of five benchmarks [@lee2021, p. 1]." },
            { occurrence: "c3", key: "lee2021", verdict: "supported", evidence: [{ path: "Research/papers/lee.pdf", page: 2, quote: "Precision rose by 50% in every experiment we ran." }], webSources: [], confidence: 0.7, note: "Page 2." },
          ] } }] }),
        ][turn]();
      }
      if (isUncited(prompt)) {
        return reply({ calls: [{ id: "u", name: "SubmitUncitedClaims", args: { claims: [{ sentence: "Transformers use three times more energy than recurrent networks.", found: false, evidence: [], note: "No source covers energy." }] } }] });
      }
      return [
        () => reply({ text: "I'll fact-check it.", calls: [{ id: "p1", name: "Skill", args: { name: FACT_CHECK_SKILL } }] }),
        () => reply({ calls: [{ id: "p2", name: "ListCitations", args: { path: "Research/draft.md" } }] }),
        () => {
          assert.match(lastToolResult(body), /5 occurrences citing 4 works/);
          return reply({ calls: [{ id: "p3", name: "CheckCitations", args: { path: "Research/draft.md" } }] });
        },
        () => {
          finalReport = /<report>\n([\s\S]*)\n<\/report>/.exec(lastToolResult(body))![1];
          return reply({ text: finalReport });
        },
      ][turn]();
    });

    const skill = createFactCheckCitationsSkill(existence);
    const events: AgentEvent[] = [];
    const { context } = makeContext("read-only", { skills: [skill], emit: (event) => events.push(event) });
    const result = await runAgent({
      model: "test/agent-model", profile, system: "System.", messages: [{ role: "user", content: "Fact-check the citations in Research/draft.md." }],
      tools: toolsForPermission("read-only"), context, emit: (event) => events.push(event), signal: context.signal,
    });
    assert.equal(result.outcome, "completed");
    const parentTools = bodies.filter((body) => !isBatch(body.messages[1].content) && !isUncited(body.messages[1].content))[2].tools!.map((tool) => tool.function.name);
    assert.ok(["ListCitations", "CheckCitations", "LeaveComment", "SuggestEdit", "References"].every((name) => parentTools.includes(name)), "the skill's tools in Read Only");
    assert.ok(!parentTools.includes("Edit") && !parentTools.includes("Write"));
    assert.equal(await readFile(path.join(root, "Research/draft.md"), "utf8"), PLANTED, "the document never changes");
    assert.equal(context.changed.size, 0);

    // The report.
    assert.equal(result.finalText, finalReport);
    assert.match(finalReport, /^\*\*Fact-check of Research\/draft\.md\*\*\n\nChecked 5 citations in 5 occurrences \(of 5\)\./);
    assert.match(finalReport, /- \*\*Verdicts:\*\* supported 1 · partially supported 1 · cannot verify 1 · source missing 2/);
    assert.match(finalReport, /- \*\*Sources not found locally:\*\* @ghost2021 \(no readable attached file\), @smth2020 \(not in the library\)/);
    assert.match(finalReport, /- \*\*Possibly hallucinated references:\*\* @ghost2021 \(no matching work at Crossref or OpenAlex, and no file is attached\.\)/);
    assert.match(finalReport, /- \*\*Metadata\/attachment mismatches:\*\* none/);
    assert.match(finalReport, /- \*\*Uncited claims:\*\* 1 \(0 with a suggested citation\)/);
    assert.match(finalReport, /- \*\*Evidence discarded:\*\* 1 quote could not be found in the cited source\./);
    assert.match(finalReport, /- \*\*Written:\*\* 3 review comments and 3 suggested edits in Research\/draft\.md\./);
    assert.doesNotMatch(finalReport, /Not checked/);

    // Comments and suggestions, saved by the skill's finish pass.
    const [doc] = await reviews(root);
    assert.equal(doc.key, "Research/draft.md");
    assert.equal(doc.enabled, true);
    const suggestions = doc.agentSuggestions!.map((suggestion) => [suggestion.edits[0].before, suggestion.edits[0].after, suggestion.reason]);
    assert.deepEqual(suggestions, [
      ["[@smith2020, p. 3]", "[@smith2020, p. 2]", "The cited passage is on p. 2, not p. 3."],
      ["Dense retrieval always doubles recall [@lee2021, p. 1].", "Dense retrieval improved recall by 12% on two of five benchmarks [@lee2021, p. 1].", "Reworded to match what the cited source says."],
      ["[@smth2020]", "[@smith2020]", "@smth2020 is not in the library; @smith2020 is."],
    ]);
    const threads = doc.threads.map((thread) => [PLANTED.slice(thread.anchor.start, thread.anchor.end), thread.messages[0].text]);
    const comment = (quote: string) => threads.find(([anchor]) => anchor.includes(quote))?.[1] ?? "";
    assert.match(comment("50% gain"), /^Citation check: \[@lee2021, p\. 2\]\n- @lee2021: cannot verify\. evidence not found in source$/);
    assert.match(comment("Quantum heads"), /- @ghost2021 has no attached PDF or Markdown file to check against\.\n- @ghost2021: Possibly hallucinated reference: no matching work at Crossref or OpenAlex, and no file is attached\./);
    assert.match(comment("three times more energy"), /^uncited claim — no source found in this notebook$/);
    assert.match(comment("[@smith2020, p. 3]"), /- @smith2020: the passage is on p\. 2, not p\. 3\.\n  > “Memory use fell by 40% with sparse attention\.” \(Research\/papers\/smith\.pdf, p\. 2\)/);
    assert.match(comment("always doubles"), /- @lee2021: partially supported\. Lee reports a 12% gain on two of five benchmarks, not a doubling\.\n  > “Dense retrieval improved recall by 12% on two of five benchmarks\.” \(Research\/papers\/lee\.pdf, p\. 1\)/);
    assert.match(comment("[@smth2020]"), /@smth2020 is not in the notebook's References library\. Did you mean @smith2020\?/);
    assert.equal(threads.length, 6, "three comments, and one linked to each suggestion");
    assert.ok(events.some((event) => event.type === "suggestions_added" && event.count === 3));
    assert.ok(events.some((event) => event.type === "comments_added" && event.count === 3));
  });
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function request(body: unknown) {
  return new NextRequest("http://localhost/api/agent", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
}

test("the agent route preloads a requested skill: its instructions go with the request and its tools are offered", async () => {
  await withLibrary(async ({ root }) => {
    await writeText(root, "Research/draft.md", "No citations here.\n");
    const { POST } = await import("../../src/app/api/agent/route");
    const bodies: ModelBody[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/endpoints")) return Response.json({ data: { context_length: 200_000, endpoints: [{ tag: "t", supports_implicit_caching: true, context_length: 200_000, supported_parameters: ["tools"] }] } });
      bodies.push(JSON.parse(String(init?.body)));
      return reply({ text: "There are no citations." });
    };
    const message = { id: "1", role: "user", text: "Fact-check the citations in Research/draft.md." };
    assert.equal((await POST(request({ permission: "read-only", notebook: "Research", skill: "made-up", messages: [message] }))).status, 400);
    const response = await POST(request({ permission: "read-only", notebook: "Research", activeFile: "Research/draft.md", skill: FACT_CHECK_SKILL, messages: [message] }));
    assert.equal(response.status, 200);
    const events: AgentEvent[] = [];
    await readAgentEvents(response, new AbortController().signal, (event) => events.push(event));
    assert.equal(events.at(-1)!.type, "done", JSON.stringify(events));
    const [first] = bodies;
    assert.ok(first, JSON.stringify(events));
    assert.ok(["ListCitations", "CheckCitations", "LeaveComment", "SuggestEdit"].every((name) => first.tools!.some((tool) => tool.function.name === name)), "the skill's tools from the first turn");
    const user = first.messages.at(-1)!.content;
    assert.match(user, /<skill name="fact-check-citations" loaded="true">[\s\S]*# Fact-checking citations[\s\S]*<\/skill>\n\nFact-check the citations in Research\/draft\.md\.$/);
    assert.doesNotMatch(first.messages[0].content, /# Fact-checking citations/, "the system prompt stays the same");
  });
});

test("activeTools offers the skill's tools once loaded, WebSearch only when allowed", () => {
  const skill = createFactCheckCitationsSkill();
  const { context } = makeContext("read-only", { skills: [skill], loadedSkills: new Set([FACT_CHECK_SKILL]) });
  assert.deepEqual(activeTools(toolsForPermission("read-only"), context).map((tool) => tool.name).slice(-4), ["ListCitations", "CheckCitations", "LeaveComment", "SuggestEdit"]);
  assert.ok(activeTools(toolsForPermission("read-only"), { ...context, allowWebSearch: true }).some((tool) => tool.name === "WebSearch"));
});
