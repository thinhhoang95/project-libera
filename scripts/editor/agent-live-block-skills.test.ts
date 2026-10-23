import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAgentSystemPrompt } from "../../src/lib/agent/prompt";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { finishLiveBlocks, markdownLiveBlockProblems } from "../../src/lib/agent/skills/live-blocks";
import { slideDeckSkill } from "../../src/lib/agent/skills/slide-deck";
import { visualizationInteractivitySkill } from "../../src/lib/agent/skills/visualization-interactivity-in-markdown";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { activeTools, ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";

const GOOD_DECK = "$title = Talk\n$theme = night\n---\n## Revenue\n\n```chart\ntype: bar\nlabels: [Q1, Q2]\nseries: [1, 2]\n```\n\n|||\n\n```mermaid\nflowchart LR\n  a --> b\n```\n";
const BAD_DECK = "$title = Talk\n$theme = neon\n---\n## Revenue\n\n```chart\ntype: sparkle\nlabels: [Q1, Q2]\nseries: [1, 2]\n```\n\n````markdown\n```chart\nnot: [checked\n```\n````\n";
// A note: `$theme = neon` is text, not a setting; only its chart is checked.
const BAD_NOTE = "$theme = neon\n\n# Sales\n\n~~~chart\ntype: line\nseries: [1, 2\n~~~\n";

async function withLibrary(run: (context: ToolContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-live-block-skills-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const notebook = path.join(directory, "users", "admin", "Talks");
    await mkdir(notebook, { recursive: true });
    await writeFile(path.join(notebook, "Q3.slides.md"), BAD_DECK);
    await writeFile(path.join(notebook, "sales.md"), BAD_NOTE);
    await writeFile(path.join(notebook, "data.csv"), "a,b\n1,2\n");
    const context: ToolContext = {
      permission: "notebook", skills: AGENT_SKILLS, loadedSkills: new Set(), skillState: new Map(),
      notebook: "Talks", notebooks: ["Talks"], openFiles: new Set(), drafts: new Map(), fileState: new Map(), tasks: [],
      snapshots: new RunSnapshots("run-live-block-skills"),
      changed: new Map([["Talks/Q3.slides.md", { created: true }], ["Talks/sales.md", { created: false }], ["Talks/data.csv", { created: false }]]),
      maxResultChars: 40_000, signal: new AbortController().signal, emit: () => {},
    };
    await run(context);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function load(context: ToolContext, name: string) {
  return activeTools(ALL_TOOLS, context).find((tool) => tool.name === "Skill")!.run({ name }, context);
}

test("both skills are listed, and their instructions load on demand", async () => {
  const system = buildAgentSystemPrompt({ permission: "notebook", mathInstruction: "Use $.", skills: AGENT_SKILLS });
  assert.match(system, /\n- slide-deck: Make or edit a Markdown Slides deck/);
  assert.match(system, /\n- visualization-interactivity-in-markdown: Add or edit charts/);
  assert.ok(!system.includes("libera.colors"), "instructions stay out of the system prompt");

  await withLibrary(async (context) => {
    const slides = (await load(context, "slide-deck")).text;
    for (const topic of ["$layout", "|||", "???", "$columns", "```chart", "```mermaid", "```html live", "libera.colors", "## The check when you finish"]) {
      assert.ok(slides.includes(topic), `slide-deck mentions ${topic}`);
    }
    const visuals = (await load(context, "visualization-interactivity-in-markdown")).text;
    for (const topic of ["# Charts, diagrams and interactive HTML in Markdown", "```chart", "```mermaid", "```html live", "libera.theme", "Insert diagram", "load the slide-deck skill"]) {
      assert.ok(visuals.includes(topic), `visualization mentions ${topic}`);
    }
    assert.ok(!visuals.includes("$layout"), "slide layout stays in slide-deck");
  });
});

test("problems: deck settings only in decks, chart errors everywhere, examples in longer fences skipped", () => {
  assert.deepEqual(markdownLiveBlockProblems(GOOD_DECK, { deck: true }), []);
  const deck = markdownLiveBlockProblems(BAD_DECK, { deck: true });
  assert.equal(deck.length, 2, deck.join("\n"));
  assert.match(deck[0], /theme/);
  assert.match(deck[1], /^line 6, chart: /);

  const note = markdownLiveBlockProblems(BAD_NOTE);
  assert.equal(note.length, 1, note.join("\n"));
  assert.match(note[0], /^line 5, chart: /);
});

test("the shared finish pass reports each changed Markdown file once, even with both skills loaded", async () => {
  await withLibrary(async (context) => {
    assert.equal(slideDeckSkill.finishPass, finishLiveBlocks);
    assert.equal(visualizationInteractivitySkill.finishPass, finishLiveBlocks);

    const feedback = await slideDeckSkill.finishPass!(context, { final: false });
    assert.match(feedback!, /^The check of your charts and slide settings found problems\. Fix them with Edit, then finish again\.\n\n/);
    assert.match(feedback!, /Talks\/Q3\.slides\.md:\n- line \d+: .*theme/);
    assert.match(feedback!, /Talks\/sales\.md:\n- line 5, chart: /);
    assert.ok(!feedback!.includes("data.csv"));
    assert.equal(await visualizationInteractivitySkill.finishPass!(context, { final: false }), null, "the other skill does not repeat it");

    context.drafts.set("Talks/Q3.slides.md", GOOD_DECK);
    context.drafts.set("Talks/sales.md", "# Sales\n");
    assert.equal(await finishLiveBlocks(context, { final: false }), null, "fixed files pass");
    context.drafts.set("Talks/sales.md", BAD_NOTE);
    assert.equal(await finishLiveBlocks(context, { final: true }), null, "the final pass only settles");
  });
});
