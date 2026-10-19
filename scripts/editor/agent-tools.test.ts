import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globToRegExp } from "../../src/lib/agent/glob";
import { resolveLibraryPath } from "../../src/lib/agent/library";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { ALL_TOOLS, toolsForPermission, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentPermission } from "../../src/lib/agent/types";

// A minimal valid PDF, so Read and Grep exercise real text extraction.
function pdfFixture(text: string) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-agent-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users", "admin");
  const files: Record<string, string> = {
    "Research/plan.md": "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\n",
    "Research/ideas/atlas.md": "# Atlas\n\nProject Atlas notes.\nBudget: see plan.\n",
    "Research/quotes.md": "He said “hello” to ‘them’.\n",
    "Research/windows.md": "first line\r\nsecond line\r\nthird line\r\n",
    "Research/empty.md": "",
    "Research/.hidden/secret.md": "budget secret",
    "Research/_assets/plan/image.md": "budget asset",
    "Research/_archive/old.md": "old budget",
    "Personal/diary.md": "Dear diary, the budget again.\n",
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    await writeFile(path.join(root, "Research/paper.pdf"), pdfFixture("Pricing is on page one"));
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function makeContext(permission: AgentPermission, overrides: Partial<ToolContext> = {}) {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission,
    skills: [],
    loadedSkills: new Set(),
    skillState: new Map(),
    notebook: "Research",
    notebooks: ["Personal", "Research"],
    openFiles: new Set(["Research/plan.md"]),
    drafts: new Map(),
    fileState: new Map(),
    tasks: [],
    snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`),
    changed: new Map(),
    maxResultChars: 40_000,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { context, events };
}

async function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name)!;
  try {
    return await tool.run(args, context);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true, result: "" };
  }
}

test("identical agent undo snapshots do not rewrite the manifest", async () => {
  await withLibrary(async (root) => {
    const snapshots = new RunSnapshots("dedup-run-0001");
    await snapshots.recordOriginal("Research/plan.md", "Original");
    await snapshots.recordWritten("Research/plan.md", "Changed");
    const target = path.join(root, ".libera", "agent-runs", "dedup-run-0001.json");
    const before = await stat(target);
    await snapshots.recordWritten("Research/plan.md", "Changed");
    const after = await stat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    await snapshots.recordWritten("Research/plan.md", "Changed again");
    const manifest = JSON.parse(await readFile(target, "utf8"));
    assert.equal(manifest.files["Research/plan.md"].written, createHash("sha256").update("Changed again").digest("hex"));
  });
});

test("glob patterns match folders, names at any depth, alternatives and classes", () => {
  assert.ok(globToRegExp("**/*.md").test("ideas/atlas.md"));
  assert.ok(globToRegExp("**/*.md").test("plan.md"));
  assert.ok(globToRegExp("*.md").test("deep/folder/plan.md"));
  assert.ok(globToRegExp("ideas/*.{md,tex}").test("ideas/atlas.tex"));
  assert.ok(!globToRegExp("ideas/*.md").test("ideas/sub/atlas.md"));
  assert.ok(globToRegExp("meeting-[0-9]*.md").test("notes/meeting-3b.md"));
  assert.ok(globToRegExp("**/ATLAS.MD").test("ideas/atlas.md"));
});

test("paths resolve inside the library and reject traversal, hidden folders and symlinks out", async () => {
  await withLibrary(async (root) => {
    assert.equal((await resolveLibraryPath("Research/plan.md")).path, "Research/plan.md");
    assert.equal((await resolveLibraryPath("ideas/atlas.md", { defaultNotebook: "Research" })).path, "Research/ideas/atlas.md");
    assert.equal((await resolveLibraryPath(path.join(root, "Personal", "diary.md"))).path, "Personal/diary.md");
    assert.equal((await resolveLibraryPath("/Research/plan.md")).path, "Research/plan.md");
    await assert.rejects(resolveLibraryPath("Research/../Personal/diary.md"), /may not contain/);
    await assert.rejects(resolveLibraryPath("Research/.hidden/secret.md"), /reserved/);
    await assert.rejects(resolveLibraryPath("Research/_assets/plan/image.md"), /reserved/);
    await assert.rejects(resolveLibraryPath("/etc/passwd"), /outside the library/);
    await assert.rejects(resolveLibraryPath("notes.md"), /not a notebook/);
    const outside = await mkdtemp(path.join(os.tmpdir(), "libera-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "outside");
      await symlink(outside, path.join(root, "Research", "linked"));
      await assert.rejects(resolveLibraryPath("Research/linked/secret.md"), /outside the notebook/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test("Glob and Grep search the current notebook by default, the library on request, and PDF text", async () => {
  await withLibrary(async () => {
    const { context } = makeContext("read-only");
    const glob = await call(context, "Glob", { pattern: "**/*.md" });
    assert.equal(glob.isError, false);
    const listed = glob.text.split("\n");
    assert.ok(listed.includes("Research/plan.md") && listed.includes("Research/ideas/atlas.md"));
    assert.ok(!listed.some((file) => file.includes("Personal") || file.includes("_archive") || file.includes(".hidden") || file.includes("_assets")));
    assert.ok((await call(context, "Glob", { pattern: "*.md", path: "/" })).text.includes("Personal/diary.md"));
    assert.ok((await call(context, "Glob", { pattern: "Research/ideas/*.md" })).text.includes("Research/ideas/atlas.md"));
    assert.ok((await call(context, "Glob", { pattern: "*.md", path: "Research/_archive" })).text.includes("Research/_archive/old.md"));

    const files = await call(context, "Grep", { pattern: "budget", "-i": true });
    assert.deepEqual(new Set(files.text.split("\n")), new Set(["Research/plan.md", "Research/ideas/atlas.md"]));
    const content = await call(context, "Grep", { pattern: "Q3 budget", output_mode: "content", "-C": 1 });
    assert.match(content.text, /^Research\/plan\.md-2-\nResearch\/plan\.md:3:The Q3 budget is 40k\.\nResearch\/plan\.md-4-Atlas launches in May\./);
    const counts = await call(context, "Grep", { pattern: "budget", "-i": true, output_mode: "count", path: "/" });
    assert.ok(counts.text.includes("Personal/diary.md:1"));
    const pdf = await call(context, "Grep", { pattern: "Pricing", output_mode: "content" });
    assert.match(pdf.text, /Research\/paper\.pdf:page 1:Pricing is on page one/);
    const cachedPdf = await call(context, "Grep", { pattern: "page one", glob: "*.pdf" });
    assert.equal(cachedPdf.text, "Research/paper.pdf");
    const invalid = await call(context, "Grep", { pattern: "(unclosed" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /Invalid regular expression/);
    const paged = await call(context, "Grep", { pattern: "e", output_mode: "content", head_limit: 2 });
    assert.match(paged.text, /Showing entries 1-2 of/);
  });
});

test("Read numbers lines, pages long files, shows unsaved drafts, and reads PDFs by page", async () => {
  await withLibrary(async (root) => {
    const { context } = makeContext("read-only", { drafts: new Map([["Research/plan.md", "# Plan\n\nUnsaved line.\n"]]) });
    const draft = await call(context, "Read", { file_path: "Research/plan.md" });
    assert.match(draft.text, /^ {5}1\t# Plan\n {5}2\t\n {5}3\tUnsaved line\./);
    assert.match(draft.text, /unsaved changes/);
    const window = await call(context, "Read", { file_path: "ideas/atlas.md", offset: "2", limit: 2 });
    assert.match(window.text, /^ {5}2\t\n {5}3\tProject Atlas notes\.\n\n\(Showing lines 2-3 of 4/);
    assert.equal(context.fileState.get("Research/ideas/atlas.md")?.partial, true);
    assert.match((await call(context, "Read", { file_path: "Research/empty.md" })).text, /exists but is empty/);
    const missing = await call(context, "Read", { file_path: "Research/plam.md" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Did you mean Research\/plan\.md\?/);
    assert.match((await call(context, "Read", { file_path: "Research/ideas" })).text, /is a folder/);
    const pdf = await call(context, "Read", { file_path: "Research/paper.pdf" });
    assert.match(pdf.text, /1 page, text extracted from the PDF[\s\S]*--- Page 1 ---\nPricing is on page one/);
    assert.match((await call(context, "Read", { file_path: "Research/paper.pdf", pages: "2" })).text, /page 2 does not exist/);
    assert.match((await call(context, "Read", { file_path: "Research/paper.pdf", pages: "1-30" })).text, /--- Page 1 ---/);

    // A long PDF, through a cache entry like the one extraction writes.
    const bytes = await readFile(path.join(root, "Research/paper.pdf"));
    await writeFile(path.join(root, "Research/long.pdf"), bytes);
    const pages = Array.from({ length: 30 }, (_, index) => ({ pageNumber: index + 1, text: `${"Body text. ".repeat(400)}Page marker ${index + 1}` }));
    await mkdir(path.join(root, "Research/.libera/pdf-text"), { recursive: true });
    await writeFile(path.join(root, "Research/.libera/pdf-text/long.pdf.json"), JSON.stringify({
      version: 3, pdfContentHash: createHash("sha256").update(bytes).digest("hex"), pdfSize: bytes.length, pageCount: 30,
      path: "Research/long.pdf", pdfUpdatedAt: "", generatedAt: new Date().toISOString(), pages,
    }));
    const opening = await call(context, "Read", { file_path: "Research/long.pdf" });
    assert.match(opening.text, /30 pages[\s\S]*Page marker 1\n[\s\S]*\(Showing pages 1-\d+ of 30\. Read other pages with pages/);
    assert.ok(!opening.text.includes("Page marker 30"));
    assert.match((await call(context, "Read", { file_path: "Research/long.pdf", pages: "5-30" })).text, /at most 20 PDF pages/);
    assert.match((await call(context, "Read", { file_path: "Research/long.pdf", pages: "29-30" })).text, /--- Page 29 ---[\s\S]*Page marker 30$/);
    assert.match((await call(context, "Grep", { pattern: "Page marker 17\\b", output_mode: "content" })).text, /Research\/long\.pdf:page 17:/);
  });
});

test("Edit requires a fresh read, forgives common slips, preserves line endings, and Write respects permissions", async () => {
  await withLibrary(async (root) => {
    const { context, events } = makeContext("notebook");
    const unread = await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });
    assert.match(unread.text, /Read Research\/plan\.md before editing/);
    await call(context, "Read", { file_path: "Research/plan.md" });
    const edited = await call(context, "Edit", { file_path: "Research/plan.md", old_string: "     3\tThe Q3 budget is 40k.", new_string: "     3\tThe Q3 budget is 50k." });
    assert.equal(edited.isError, false, edited.text);
    assert.match(edited.text, /line-number prefixes/);
    assert.match(edited.text, / {5}3\tThe Q3 budget is 50k\./);
    assert.equal(await readFile(path.join(root, "Research/plan.md"), "utf8"), "# Plan\n\nThe Q3 budget is 50k.\nAtlas launches in May.\n");
    assert.deepEqual(events.filter((event) => event.type === "file_changed"), [{ type: "file_changed", path: "Research/plan.md", created: false }]);

    await writeFile(path.join(root, "Research/plan.md"), "Changed by the user.\n");
    assert.match((await call(context, "Edit", { file_path: "Research/plan.md", old_string: "Changed", new_string: "Edited" })).text, /changed since you read it/);

    await call(context, "Read", { file_path: "Research/windows.md" });
    assert.equal((await call(context, "Edit", { file_path: "Research/windows.md", old_string: "first line\nsecond line", new_string: "line one\nline two" })).isError, false);
    assert.equal(await readFile(path.join(root, "Research/windows.md"), "utf8"), "line one\r\nline two\r\nthird line\r\n");

    await call(context, "Read", { file_path: "Research/quotes.md" });
    assert.equal((await call(context, "Edit", { file_path: "Research/quotes.md", old_string: "He said \"hello\"", new_string: "She said \"hi\"" })).isError, false);
    assert.equal(await readFile(path.join(root, "Research/quotes.md"), "utf8"), "She said \"hi\" to ‘them’.\n");

    await call(context, "Read", { file_path: "Research/ideas/atlas.md" });
    const ambiguous = await call(context, "Edit", { file_path: "Research/ideas/atlas.md", old_string: "Atlas", new_string: "Orion" });
    assert.match(ambiguous.text, /matches 2 places .*lines 1, 3/);
    assert.equal((await call(context, "Edit", { file_path: "Research/ideas/atlas.md", old_string: "Atlas", new_string: "Orion", replace_all: true })).isError, false);
    const notFound = await call(context, "Edit", { file_path: "Research/ideas/atlas.md", old_string: "Project Orion notez.", new_string: "x" });
    assert.match(notFound.text, /not found[\s\S]*closest lines[\s\S]*3\tProject Orion notes\./);

    const created = await call(context, "Write", { file_path: "summaries/q3.md", content: "# Q3\n" });
    assert.equal(created.isError, false, created.text);
    assert.equal(await readFile(path.join(root, "Research/summaries/q3.md"), "utf8"), "# Q3\n");
    assert.match((await call(context, "Write", { file_path: "Research/empty.md", content: "x" })).text, /already exists\. Read the whole file/);
    assert.match((await call(context, "Write", { file_path: "Research/plan.md", content: "x" })).text, /changed since you read it/);
    assert.match((await call(context, "Write", { file_path: "Research/ideas/atlas.md", content: "# Orion\n" })).text, /^Overwrote Research\/ideas\/atlas\.md/);
    assert.match((await call(context, "Write", { file_path: "Personal/new.md", content: "x" })).text, /only modify files in the notebook "Research"/);
    assert.match((await call(context, "Write", { file_path: "Research/new.pdf", content: "x" })).text, /only Markdown/);
    assert.match((await call(context, "Write", { file_path: "Research/_archive/new.md", content: "x" })).text, /_archive/);

    const open = makeContext("open-files").context;
    await call(open, "Read", { file_path: "Research/ideas/atlas.md" });
    assert.match((await call(open, "Edit", { file_path: "Research/ideas/atlas.md", old_string: "# Orion", new_string: "# A" })).text, /only modify files that are open in the editor: Research\/plan\.md/);
    assert.match((await call(open, "Write", { file_path: "Research/another.md", content: "x" })).text, /cannot create new files/);
    assert.deepEqual(toolsForPermission("read-only").map((tool) => tool.name), ["Glob", "Grep", "Read", "ReadComments", "TaskCreate", "TaskUpdate", "Skill", "References"]);
  });
});

test("undo restores originals, removes created files, gives back unsaved drafts, and skips files edited afterwards", async () => {
  await withLibrary(async (root) => {
    const snapshots = new RunSnapshots("undo-run-0001");
    const { context } = makeContext("notebook", {
      snapshots,
      openFiles: new Set(["Research/plan.md", "Research/ideas/atlas.md"]),
      drafts: new Map([["Research/ideas/atlas.md", "# Atlas\n\nUnsaved draft.\n"]]),
    });
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "60k" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "May", new_string: "June" });
    await call(context, "Read", { file_path: "Research/ideas/atlas.md" });
    await call(context, "Edit", { file_path: "Research/ideas/atlas.md", old_string: "Unsaved draft.", new_string: "Agent text." });
    assert.equal(await readFile(path.join(root, "Research/ideas/atlas.md"), "utf8"), "# Atlas\n\nAgent text.\n");
    await call(context, "Write", { file_path: "Research/new.md", content: "New note\n" });
    await call(context, "Write", { file_path: "Research/later.md", content: "Later\n" });
    await writeFile(path.join(root, "Research/later.md"), "The user kept writing.\n");

    const partial = await undoRun("undo-run-0001", ["Research/plan.md"]);
    assert.deepEqual(partial, [{ path: "Research/plan.md", status: "restored", content: "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\n" }]);
    const rest = await undoRun("undo-run-0001");
    const byPath = Object.fromEntries(rest.map((result) => [result.path, result]));
    assert.equal(byPath["Research/plan.md"].status, "already-reverted");
    assert.deepEqual(byPath["Research/ideas/atlas.md"], { path: "Research/ideas/atlas.md", status: "restored", content: "# Atlas\n\nProject Atlas notes.\nBudget: see plan.\n", draft: "# Atlas\n\nUnsaved draft.\n" });
    assert.equal(byPath["Research/new.md"].status, "deleted");
    assert.equal(byPath["Research/later.md"].status, "conflict");
    await assert.rejects(readFile(path.join(root, "Research/new.md"), "utf8"));
    assert.equal(await readFile(path.join(root, "Research/later.md"), "utf8"), "The user kept writing.\n");
    await assert.rejects(undoRun("missing-run-0001"), /no longer available/);
  });
});

test("tasks are tracked and reported", async () => {
  await withLibrary(async () => {
    const { context, events } = makeContext("read-only");
    await call(context, "TaskCreate", { subject: "Find notes" });
    await call(context, "TaskCreate", { subject: "Summarize" });
    const updated = await call(context, "TaskUpdate", { taskId: "#1", status: "completed" });
    assert.equal(updated.text, "#1 [completed] Find notes\n#2 [pending] Summarize");
    await call(context, "TaskUpdate", { taskId: 2, status: "deleted" });
    assert.deepEqual(context.tasks, [{ id: "1", subject: "Find notes", status: "completed" }]);
    assert.equal(events.filter((event) => event.type === "tasks_updated").length, 4);
    assert.match((await call(context, "TaskUpdate", { taskId: "9", status: "completed" })).text, /no task #9/);
  });
});
