import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { amendOutlineTool, applyOutlineOperations, createGeneratePdfOutlineSkill, generateOutline, PDF_OUTLINE_SKILL } from "../../src/lib/agent/skills/generate-pdf-outline";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import type { ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent } from "../../src/lib/agent/types";
import {
  parseNumbering,
  planOutlineChunks,
  stitchOutline,
  tableOfContentsPages,
  titleOnPage,
  verifyOutline,
  visibleOutlineRows,
  withOutlineIds,
  type PdfOutlineEntry,
} from "../../src/lib/pdf-outline";
import { readPdfAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { copyFileToDirectory, deleteFile, moveFile, renameFolder } from "../../src/lib/storage/files";
import { readEmbeddedPdfOutline, readPdfOutline, readPdfOutlineFile } from "../../src/lib/storage/pdf-outlines";
import { followSharedPdfChanges, ORPHAN_GRACE_MS, reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { withLibrary, writePdf } from "./references-factcheck-helpers";

const profile = { contextLength: 200_000, supportsTools: true, known: true };

// ---------------------------------------------------------------------------
// The pure parts
// ---------------------------------------------------------------------------

test("numbers are read from headings, conservatively", () => {
  assert.deepEqual(parseNumbering("2.3 Results"), { scheme: "section", parts: ["2", "3"] });
  assert.deepEqual(parseNumbering("3. Methods"), { scheme: "section", parts: ["3"] });
  assert.deepEqual(parseNumbering("Chapter 4 Wave equations"), { scheme: "section", parts: ["4"] });
  assert.deepEqual(parseNumbering("Part II Applications"), { scheme: "part", parts: ["II"] });
  assert.deepEqual(parseNumbering("Appendix B Proofs"), { scheme: "section", parts: ["B"] });
  assert.deepEqual(parseNumbering("A.1 Lemmas"), { scheme: "section", parts: ["A", "1"] });
  assert.deepEqual(parseNumbering("IV. Discussion"), { scheme: "section", parts: ["IV"] });
  assert.deepEqual(parseNumbering("Results", "5.2"), { scheme: "section", parts: ["5", "2"] });
  // Titles that only look numbered.
  assert.equal(parseNumbering("A Survey of Methods"), null);
  assert.equal(parseNumbering("I Think Therefore"), null);
  assert.equal(parseNumbering("2019 Annual Report"), null);
  assert.equal(parseNumbering("Introduction"), null);
});

test("titles match page text despite spacing, case, hyphenation and ligatures", () => {
  assert.ok(titleOnPage("2.1 Data Collection", "text before\n2.1   Data Col-\nlection\nbody"));
  assert.ok(titleOnPage("Classification", "Classiﬁcation of things"));
  assert.ok(titleOnPage("3 Results", "3\nResults and more"));
  assert.ok(!titleOnPage("4 Discussion", "Only results here"));
});

test("chunks respect page and character limits, and a range", () => {
  const pages = Array.from({ length: 30 }, (_, index) => ({ pageNumber: index + 1, text: "x".repeat(index === 4 ? 50_000 : 100) }));
  assert.deepEqual(planOutlineChunks(pages, { maxPages: 12 }), [{ from: 1, to: 4 }, { from: 5, to: 5 }, { from: 6, to: 17 }, { from: 18, to: 29 }, { from: 30, to: 30 }]);
  assert.deepEqual(planOutlineChunks(pages, { maxPages: 12, range: { from: 25, to: 30 } }), [{ from: 25, to: 30 }]);
});

test("a printed table of contents is found in the first pages", () => {
  const toc = "Contents\n1 Introduction .......... 1\n1.1 Background ..... 3\n2 Methods ......... 8\n2.1 Data ...... 9\n3 Results ...... 14\n4 Discussion ..... 20\nReferences ..... 25";
  const pages = [{ pageNumber: 1, text: "A Title\nby Someone" }, { pageNumber: 2, text: toc }, { pageNumber: 3, text: "1 Introduction\nWe begin with a long sentence that is body text." }];
  assert.deepEqual(tableOfContentsPages(pages), [2]);
});

test("stitching re-levels a chunk that disagrees with the numbering elsewhere, drops repeats and closes jumps", () => {
  const { entries, notes } = stitchOutline([
    { range: { from: 1, to: 12 }, entries: [
      { title: "1 Introduction", level: 1, page: 1 },
      { title: "1.1 Background", level: 2, page: 2 },
      { title: "2 Methods", level: 1, page: 8 },
      { title: "2.1 Data", level: 2, page: 10 },
    ] },
    // Started mid-chapter: everything one level too deep, and the edge heading repeated.
    { range: { from: 13, to: 24 }, entries: [
      { title: "2.2 Models", level: 3, page: 14 },
      { title: "3 Results", level: 2, page: 16 },
      { title: "3.1 Main results", level: 3, page: 20 },
      { title: "3.1 Main results", level: 3, page: 20 },
    ] },
    { range: { from: 25, to: 30 }, entries: [{ title: "Notes", level: 4, page: 26 }] },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.title, entry.level]), [
    ["1 Introduction", 1], ["1.1 Background", 2], ["2 Methods", 1], ["2.1 Data", 2],
    ["2.2 Models", 2], ["3 Results", 1], ["3.1 Main results", 2], ["Notes", 3],
  ]);
  assert.ok(notes.some((note) => /pages 13–24 by -1/.test(note)));
  assert.ok(notes.some((note) => /“Notes” .* is now level 3/.test(note)));
});

test("verification finds broken order, levels, numbering, repeats and coverage", () => {
  const entries = withOutlineIds([
    { title: "1 Introduction", level: 2, page: 1 },
    { title: "1.1 Background", level: 2, page: 2 },
    { title: "2 Methods", level: 1, page: 9 },
    { title: "2.1 Data", level: 2, page: 10 },
    { title: "2.3 Tuning", level: 2, page: 11 },
    { title: "2.2 Tuning again", level: 2, page: 12 },
    { title: "3.4 Models", level: 3, page: 12 },
    { title: "Lost", level: 1, page: 5 },
    { title: "2 Methods", level: 1, page: 9 },
    { title: "Deep", level: 3, page: 20 },
    { title: "Far away", level: 1, page: 31 },
  ]);
  const problems = verifyOutline(entries, { pageCount: 100, pageText: (page) => page === 2 ? "1.1 Background" : page === 10 ? "Other text" : undefined, notOutlined: [{ from: 21, to: 30, reason: "the run was stopped" }] });
  const codes = (code: string) => problems.filter((problem) => problem.code === code).map((problem) => problem.id ?? `${problem.pages?.from}-${problem.pages?.to}`);
  assert.deepEqual(codes("level"), ["o1", "o10"]);
  assert.deepEqual(codes("order"), ["o8"]);
  assert.deepEqual(codes("duplicate"), ["o9"]);
  assert.deepEqual(codes("numbering-parent"), ["o7"]);
  assert.deepEqual(codes("numbering-depth"), ["o1", "o7"]);
  assert.deepEqual(codes("numbering-order"), ["o6"]);
  assert.deepEqual(codes("numbering-gap"), ["o5"]);
  assert.deepEqual(codes("title-not-found"), ["o4"]);
  assert.deepEqual(codes("not-outlined"), ["21-30"]);
  assert.deepEqual(codes("sparse"), ["32-100"]);
  assert.ok(problems.every((problem) => problem.severity === (["numbering-gap", "sparse", "title-not-found"].includes(problem.code) ? "warning" : "error")));
});

test("amend operations update, insert, delete and shift by id, and report what cannot apply", () => {
  const entries = withOutlineIds([
    { title: "1 Intro", level: 1, page: 1 },
    { title: "2 Methods", level: 1, page: 4 },
    { title: "2.1 Data", level: 1, page: 5 },
    { title: "2.1.1 Sources", level: 2, page: 6 },
  ]);
  const result = applyOutlineOperations(entries, [
    { op: "update", id: "o1", title: "1 Introduction" },
    { op: "shift", id: "o3", to: "o4", by: 1 },
    { op: "insert", title: "3 Results", level: 1, page: 8 },
    { op: "insert", after: "start", title: "Abstract", level: 1, page: 1 },
    { op: "delete", id: "o9" },
    { op: "update", id: "o2", page: 500 },
  ], 10);
  assert.deepEqual(result.entries.map((entry) => `${entry.id}:${entry.level}:${entry.title}`), ["o6:1:Abstract", "o1:1:1 Introduction", "o2:1:2 Methods", "o3:2:2.1 Data", "o4:3:2.1.1 Sources", "o5:1:3 Results"]);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /no entry o9/);
  assert.match(result.problems[1], /within 1–10/);
  assert.deepEqual(verifyOutline(result.entries, { pageCount: 10 }), []);
});

test("collapsed outline rows hide descendants; search shows matches anywhere", () => {
  const entries: PdfOutlineEntry[] = [
    { id: "a", title: "Part I", level: 1, page: 1 },
    { id: "b", title: "Chapter 1", level: 2, page: 2 },
    { id: "c", title: "Deep section", level: 3, page: 3 },
    { id: "d", title: "Part II", level: 1, page: 9 },
  ];
  assert.deepEqual(visibleOutlineRows(entries, { expansionLevel: 2 }).map((row) => row.entry.id), ["a", "b", "d"]);
  assert.deepEqual(visibleOutlineRows(entries, { expansionLevel: 1 }).map((row) => row.entry.id), ["a", "d"]);
  assert.deepEqual(visibleOutlineRows(entries, { expansionLevel: 1, expanded: { a: true } }).map((row) => row.entry.id), ["a", "b", "d"]);
  assert.deepEqual(visibleOutlineRows(entries, { query: "deep" }).map((row) => row.entry.id), ["c"]);
});

// ---------------------------------------------------------------------------
// Embedded bookmarks
// ---------------------------------------------------------------------------

/** A three-page PDF with bookmarks: Introduction (p. 1, a quarter down), Methods (p. 2) › Setup (p. 3, top). */
function pdfWithBookmarks() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
    ...[0, 1, 2].map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 11 0 R >> >> /Contents 6 0 R >>"),
    "<< /Length 38 >>\nstream\nBT /F1 12 Tf 20 100 Td (Hello) Tj ET\nendstream",
    "<< /Type /Outlines /First 8 0 R /Last 9 0 R /Count 3 >>",
    "<< /Title (Introduction) /Parent 7 0 R /Next 9 0 R /Dest [3 0 R /XYZ 0 150 0] >>",
    "<< /Title (Methods) /Parent 7 0 R /Prev 8 0 R /First 10 0 R /Last 10 0 R /Count 1 /Dest [4 0 R /Fit] >>",
    "<< /Title (Setup) /Parent 9 0 R /Dest [5 0 R /XYZ 0 200 0] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("a PDF's own bookmarks are read with their levels, pages and positions", async () => {
  await withLibrary(async ({ root }) => {
    await writeFile(path.join(root, "Research", "book.pdf"), pdfWithBookmarks());
    const entries = await readEmbeddedPdfOutline("Research/book.pdf");
    assert.deepEqual(entries.map(({ title, level, page, top }) => ({ title, level, page, top })), [
      { title: "Introduction", level: 1, page: 1, top: 0.25 },
      { title: "Methods", level: 1, page: 2, top: undefined },
      { title: "Setup", level: 2, page: 3, top: 0 },
    ]);
    const payload = await readPdfOutline("Research/book.pdf");
    assert.equal(payload.embedded.length, 3);
    assert.equal(payload.generated, null);
  });
});

// ---------------------------------------------------------------------------
// GenerateOutline and AmendOutline
// ---------------------------------------------------------------------------

type ModelBody = { messages: { role: string; content: string }[] };

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

function reply({ text = "", calls = [] }: { text?: string; calls?: Array<{ id: string; name: string; args: unknown }> }) {
  const chunks: unknown[] = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  calls.forEach((call, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50 } });
  return sse(chunks);
}

/** Outliners scripted by the pages they were given and how many turns they have had. */
function scriptOutliners(script: (range: string, turn: number) => Response) {
  const turns = new Map<string, number>();
  const prompts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as ModelBody;
    const prompt = body.messages.find((message) => message.role === "user")!.content;
    const range = /Outline pages (\d+–\d+)\./.exec(prompt)?.[1] ?? "?";
    const turn = turns.get(prompt) ?? 0;
    turns.set(prompt, turn + 1);
    if (turn === 0) prompts.push(prompt);
    return script(range, turn);
  };
  return prompts;
}

const submit = (entries: unknown[]) => reply({ calls: [{ id: `s${Math.random()}`, name: "SubmitOutline", args: { entries } }] });

function context(events: AgentEvent[]): ToolContext {
  return {
    permission: "read-only", skills: AGENT_SKILLS, loadedSkills: new Set([PDF_OUTLINE_SKILL]), skillState: new Map(),
    notebook: "Research", notebooks: ["Research"], openFiles: new Set(), drafts: new Map(), fileState: new Map(), tasks: [],
    snapshots: new RunSnapshots("outline-run-0001"), changed: new Map(), maxResultChars: 40_000,
    signal: new AbortController().signal, emit: (event) => events.push(event), model: "test/agent-model",
    runConfig: { model: "test/agent-model", profile }, budget: { maxInputTokens: 5_000_000, inputTokens: 0 }, usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Thirty pages: a paper with numbered sections, references at the end. */
function paperPages() {
  const pages = Array.from({ length: 30 }, (_, index) => `Body text of page ${index + 1}, with sentences that are not headings.`);
  const put = (page: number, heading: string) => { pages[page - 1] = `${heading}\n${pages[page - 1]}`; };
  put(1, "Abstract"); put(3, "1 Introduction"); put(5, "1.1 Background"); put(8, "2 Methods"); put(10, "2.1 Data");
  put(14, "2.2 Models"); put(16, "3 Results"); put(20, "3.1 Main results"); put(25, "4 Discussion"); put(28, "References");
  return pages;
}

test("GenerateOutline outlines chunks in parallel, sends mistakes back, stitches, verifies, and fills gaps on request", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/paper.pdf", paperPages());
    let secondRound = false;
    const prompts = scriptOutliners((range, turn) => {
      if (range === "1–12") {
        return turn === 0
          ? submit([{ title: "Abstract", level: 1, page: 1 }, { title: "1 Introductoin", level: 1, page: 3 }])
          : submit([
            { title: "Abstract", level: 1, page: 1 }, { title: "1 Introduction", level: 1, page: 3, numbering: "1" },
            { title: "1.1 Background", level: 2, page: 5 }, { title: "2 Methods", level: 1, page: 9 }, { title: "2.1 Data", level: 2, page: 10 },
          ]);
      }
      if (range === "13–24") {
        // Mid-chapter: one level too deep throughout.
        return submit([{ title: "2.2 Models", level: 3, page: 14 }, { title: "3 Results", level: 2, page: 16 }, { title: "3.1 Main results", level: 3, page: 20 }]);
      }
      return secondRound
        ? submit([{ title: "4 Discussion", level: 1, page: 25 }, { title: "References", level: 1, page: 28 }])
        : reply({ text: "I could not decide." });
    });
    const events: AgentEvent[] = [];
    const ctx = context(events);
    const deps = { embedded: async () => [], outlinerPages: async () => paperPages() };

    const first = await generateOutline(ctx, { path: "Research/paper.pdf" }, deps);
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /The end of page 12, for context only/);
    assert.match(first.text, /3 subagents for 30 pages/);
    assert.match(first.text, /“2 Methods” is on page 8, not 9; moved\./);
    assert.match(first.text, /Shifted the levels in pages 13–24 by -1/);
    assert.match(first.text, /Pages 25–30 were not outlined: The check finished without calling SubmitOutline/);
    assert.equal(events.filter((event) => event.type === "subagent_started").length, 3);
    assert.deepEqual(events.filter((event) => event.type === "pdf_outline_saved"), [{ type: "pdf_outline_saved", path: "Research/paper.pdf", count: 8 }]);

    let saved = await readPdfOutlineFile("Research/paper.pdf");
    assert.deepEqual(saved!.entries.map((entry) => `${entry.level} ${entry.page} ${entry.title}`), [
      "1 1 Abstract", "1 3 1 Introduction", "2 5 1.1 Background", "1 8 2 Methods", "2 10 2.1 Data", "2 14 2.2 Models", "1 16 3 Results", "2 20 3.1 Main results",
    ]);
    assert.deepEqual(saved!.problems.map((problem) => problem.code), ["not-outlined"]);
    assert.equal(saved!.model, "test/agent-model");

    // The finish pass sends the remaining error back.
    const skill = createGeneratePdfOutlineSkill(deps);
    assert.match(await skill.finishPass!(ctx, { final: false }) ?? "", /Pages 25–30 were not outlined/);

    secondRound = true;
    const filled = await generateOutline(ctx, { path: "Research/paper.pdf", pages: "25-30" }, deps);
    assert.match(filled.text, /Outlined pages 25–30 of Research\/paper\.pdf/);
    saved = await readPdfOutlineFile("Research/paper.pdf");
    assert.equal(saved!.entries.length, 10);
    assert.deepEqual(saved!.problems, []);
    assert.ok(saved!.updatedAt);
    assert.equal(await skill.finishPass!(ctx, { final: false }), null);

    // Amending checks the whole outline again.
    const amended = await amendOutlineTool.run({ path: "Research/paper.pdf", operations: [
      { op: "insert", after: "o7", title: "2.3 Extra", level: 2, page: 17 },
    ] }, ctx);
    assert.match(amended.text, /“2\.3 Extra” \(o11, page 17\) is numbered 2\.3 but sits under “3 Results”/);
    assert.match(amended.text, /not in page 17's text/);
    const fixed = await amendOutlineTool.run({ path: "Research/paper.pdf", operations: [{ op: "delete", id: "o11" }, { op: "delete", id: "o404" }] }, ctx);
    assert.equal(fixed.isError, true);
    assert.match(fixed.text, /Applied 1 operation/);
    assert.match(fixed.text, /there is no entry o404/);
    assert.match(fixed.text, /Verification found no problems/);
  });
});

test("GenerateOutline leaves PDFs with bookmarks alone and refuses scans", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/booked.pdf", paperPages());
    await writePdf(root, "Research/scan.pdf", Array.from({ length: 5 }, () => ""));
    const ctx = context([]);
    const booked = await generateOutline(ctx, { path: "Research/booked.pdf" }, { embedded: async () => [{ id: "b1", title: "Intro", level: 1, page: 1 }] });
    assert.match(booked.text, /has its own bookmarks \(1 entry\)/);
    assert.equal(await readPdfOutlineFile("Research/booked.pdf"), null);
    await assert.rejects(generateOutline(ctx, { path: "Research/scan.pdf" }, { embedded: async () => [] }), /probably a scan/);
  });
});

test("a PDF renamed while its outline is generated gets it under the new name; a deleted one gets none", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/paper.pdf", paperPages());
    scriptOutliners(() => submit([]));
    const ctx = context([]);
    const renamed = await generateOutline(ctx, { path: "Research/paper.pdf" }, {
      embedded: async () => [],
      // Renamed outside Libera after the text was read, before the outline is saved.
      outlinerPages: async () => { await rename(path.join(root, "Research", "paper.pdf"), path.join(root, "Research", "renamed.pdf")); return paperPages(); },
    });
    assert.match(renamed.text, /was renamed or moved to Research\/renamed\.pdf meanwhile/);
    assert.equal(await readPdfOutlineFile("Research/paper.pdf"), null);
    assert.ok(await readPdfOutlineFile("Research/renamed.pdf"));

    await writePdf(root, "Research/doomed.pdf", paperPages().map((text) => `${text} doomed`));
    await assert.rejects(generateOutline(context([]), { path: "Research/doomed.pdf" }, {
      embedded: async () => [],
      outlinerPages: async () => { await rm(path.join(root, "Research", "doomed.pdf")); return paperPages(); },
    }), /was deleted or moved out of its notebook/);
    await assert.rejects(stat(path.join(root, "Research", ".libera", "outlines", "by-path", "doomed.pdf.json")));
  });
});

// ---------------------------------------------------------------------------
// The side-cars follow the PDF
// ---------------------------------------------------------------------------

async function seedOutline(root: string, file: string) {
  await writePdf(root, file, paperPages());
  scriptOutliners(() => submit([]));
  await generateOutline(context([]), { path: file }, { embedded: async () => [], outlinerPages: async () => paperPages() });
  assert.ok(await readPdfOutlineFile(file));
}

const outlineSidecar = (root: string, notebook: string, ...parts: string[]) => path.join(root, notebook, ".libera", "outlines", "by-path", ...parts.slice(0, -1), `${parts.at(-1)}.json`);
const annotation = { id: "n1", type: "text", pageNumber: 1, text: "Note", fontSize: 12, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, createdAt: "2026-10-24", updatedAt: "2026-10-24" };

test("renaming, copying, moving a folder and deleting in Libera take the outline along", async () => {
  await withLibrary(async ({ root }) => {
    await seedOutline(root, "Research/papers/paper.pdf");
    await moveFile("Research/papers/paper.pdf", "Research", "renamed.pdf");
    assert.ok(await readPdfOutlineFile("Research/papers/renamed.pdf"));
    await assert.rejects(stat(outlineSidecar(root, "Research", "papers", "paper.pdf")));
    await copyFileToDirectory("Research/papers/renamed.pdf", "Research", "copy.pdf");
    assert.ok(await readPdfOutlineFile("Research/copy.pdf"));
    await renameFolder("Research/papers", "articles");
    assert.ok(await readPdfOutlineFile("Research/articles/renamed.pdf"));
    await deleteFile("Research/articles/renamed.pdf");
    await assert.rejects(stat(outlineSidecar(root, "Research", "articles", "renamed.pdf")));
  });
});

test("side-cars of a PDF renamed outside Libera find it by its bytes; a deleted PDF's are set aside, not inherited, and come back with it", async () => {
  await withLibrary(async ({ root }) => {
    await seedOutline(root, "Research/a.pdf");
    await writePdfAnnotations("Research/a.pdf", [annotation]);
    const bytes = await readFile(path.join(root, "Research", "a.pdf"));
    const pdf = (name: string) => ({ path: `Research/${name}`, size: bytes.length });

    // Renamed in Finder: both side-cars move to the new name.
    await rename(path.join(root, "Research", "a.pdf"), path.join(root, "Research", "b.pdf"));
    assert.deepEqual(await reconcilePdfSidecars("Research", [pdf("b.pdf")]), { reattached: 2, setAside: 0 });
    assert.equal((await readPdfAnnotations("Research/b.pdf")).annotations.length, 1);
    assert.ok(await readPdfOutlineFile("Research/b.pdf"));

    // Deleted: kept in place for the grace period, then set aside.
    await rm(path.join(root, "Research", "b.pdf"));
    const now = Date.now();
    assert.deepEqual(await reconcilePdfSidecars("Research", [], { now }), { reattached: 0, setAside: 0 });
    assert.deepEqual(await reconcilePdfSidecars("Research", [], { now: now + ORPHAN_GRACE_MS + 1 }), { reattached: 0, setAside: 2 });
    await assert.rejects(stat(outlineSidecar(root, "Research", "b.pdf")));

    // A different PDF saved under the old name does not inherit them.
    await writePdf(root, "Research/b.pdf", ["A different document"]);
    const other = (await stat(path.join(root, "Research", "b.pdf"))).size;
    await reconcilePdfSidecars("Research", [{ path: "Research/b.pdf", size: other }], { now: now + 2 * 60_000 });
    assert.equal((await readPdfAnnotations("Research/b.pdf")).annotations.length, 0);
    assert.equal(await readPdfOutlineFile("Research/b.pdf"), null);

    // The original comes back from the trash under another name: its notes return.
    await writeFile(path.join(root, "Research", "restored.pdf"), bytes);
    assert.deepEqual(await reconcilePdfSidecars("Research", [{ path: "Research/b.pdf", size: other }, pdf("restored.pdf")], { now: now + 4 * 60_000 }), { reattached: 2, setAside: 0 });
    assert.equal((await readPdfAnnotations("Research/restored.pdf")).annotations.length, 1);
    assert.ok(await readPdfOutlineFile("Research/restored.pdf"));
  });
});

test("a shared notebook's host moves and removals carry the PDF's side-cars", async () => {
  await withLibrary(async ({ root }) => {
    await seedOutline(root, "Research/shared.pdf");
    await writePdfAnnotations("Research/shared.pdf", [annotation]);
    await rename(path.join(root, "Research", "shared.pdf"), path.join(root, "Research", "moved.pdf"));
    assert.equal(await followSharedPdfChanges([{ from: "Research/shared.pdf", to: "Research/moved.pdf" }], []), 1);
    assert.equal((await readPdfAnnotations("Research/moved.pdf")).annotations.length, 1);
    assert.ok(await readPdfOutlineFile("Research/moved.pdf"));

    const bytes = await readFile(path.join(root, "Research", "moved.pdf"));
    await rm(path.join(root, "Research", "moved.pdf"));
    await followSharedPdfChanges([], ["Research/moved.pdf"]);
    await assert.rejects(stat(outlineSidecar(root, "Research", "moved.pdf")));
    // The host restores it: the notes come back on the next refresh.
    await writeFile(path.join(root, "Research", "moved.pdf"), bytes);
    assert.equal((await reconcilePdfSidecars("Research", [{ path: "Research/moved.pdf", size: bytes.length }], { now: Date.now() + 10 * 60_000 })).reattached, 2);
    assert.equal((await readPdfAnnotations("Research/moved.pdf")).annotations.length, 1);
  });
});
