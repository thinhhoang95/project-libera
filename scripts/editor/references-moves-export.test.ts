import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as bibliographyRoute } from "../../src/app/api/references/bibliography/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { planLatexChunks } from "../../src/lib/latex-chunks";
import { buildLatexPrompt, convertMarkdownToLatex } from "../../src/lib/latex-generation";
import { DEFAULT_LATEX_OPTIONS } from "../../src/lib/latex-options";
import { formatNotebookBibliography, renderBibliography } from "../../src/lib/references/bibliography-export";
import {
  LATEX_CITATION_PROMPT,
  notebookOfDocument,
  prepareLatexCitations,
  restoreLatexCitations,
} from "../../src/lib/references/latex-citations";
import type { CslItem, ReferenceEntry } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath } from "../../src/lib/storage/paths";
import { pendingReferenceReattach, readReferenceLibrary, resetReferenceReattachSchedule, updateReferenceLibrary } from "../../src/lib/storage/references";

const NOW = "2024-01-01T00:00:00.000Z";

async function withData(run: () => Promise<void>) {
  await pendingReferenceReattach();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-references-export-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  try {
    await mkdir(path.join(scratch, "data", "users", "admin"), { recursive: true });
    await run();
  } finally {
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

function entry(id: string, key: string, csl: Partial<CslItem>, createdAt = NOW): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl }, identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt, updatedAt: createdAt, fieldUpdatedAt: {},
  };
}

const article = (family: string, year: number, title: string): Partial<CslItem> => ({
  author: [{ family, given: "Ann" }], issued: { "date-parts": [[year]] }, title, "container-title": "Journal of Tests", volume: "3", page: "1-10",
});

/** A notebook "Refs" with three entries; zeta2020 has a title full of Markdown, LaTeX and HTML syntax. */
async function seed() {
  await createNotebook("Refs");
  await updateReferenceLibrary("Refs", null, [
    { op: "put", entry: entry("r-zeta", "zeta2020", article("Zeta", 2020, "Under_score *star* [x] & 50% $5 <script>alert(1)</script>"), "2024-01-01T00:00:00.000Z") },
    { op: "put", entry: { ...entry("r-alpha", "alpha2019", article("Alpha", 2019, "First steps"), "2024-01-02T00:00:00.000Z"), aliases: ["alphaold"] } },
    { op: "put", entry: entry("r-mid", "mid2021", article("Mid", 2021, "Middle ground"), "2024-01-03T00:00:00.000Z") },
  ]);
  return readReferenceLibrary("Refs");
}

// ---------------------------------------------------------------------------
// Formatted bibliography export
// ---------------------------------------------------------------------------

test("formatted bibliographies come as text, Markdown or sanitized HTML", async () => {
  await withData(async () => {
    const library = await seed();
    const all = (format: "text" | "markdown" | "html", extra: object = {}) => formatNotebookBibliography({ notebook: "Refs", library, format, ...extra });

    const html = await all("html");
    assert.equal(html.count, 3);
    assert.match(html.text, /^<div class="csl-bib-body csl-hanging-indent"><div class="csl-entry">/);
    assert.match(html.text, /<i>Journal of Tests<\/i>/);
    assert.ok(!html.text.includes("<script"), "entry text is escaped, never markup");
    assert.match(html.text, /&lt;script&gt;/);

    const text = await all("text");
    // APA sorts by author.
    assert.deepEqual(text.text.split("\n").map((line) => line.split(",")[0]), ["Alpha", "Mid", "Zeta"]);
    assert.ok(!/<\/?[a-z]/.test(text.text.replace("<script>alert(1)</script>", "")));
    assert.match(text.text, /Under_score \*star\* \[x\] & 50% \$5 <script>alert\(1\)<\/script>\. Journal of Tests, 3, 1–10\./);

    const markdown = await all("markdown");
    const lines = markdown.text.split("\n\n");
    assert.equal(lines.length, 3);
    assert.match(lines[2], /Under\\_score \\\*star\\\* \\\[x\\\] \\& 50% \\\$5 \\<script\\>alert\(1\)\\<\/script\\>\. \*Journal of Tests\*, \*3\*, 1–10\./);

    // documentText: only the cited entries (aliases resolve), in the style's order; ids are ignored then.
    const cited = await all("text", { documentText: "See [@mid2021] and [@alphaold; @ghost].", ids: ["r-zeta"] });
    assert.equal(cited.count, 2);
    assert.deepEqual(cited.text.split("\n").map((line) => line.split(",")[0]), ["Alpha", "Mid"]);
    assert.deepEqual(cited.unresolvedKeys, ["ghost"]);

    const selected = await all("text", { ids: ["r-mid", "r-gone"] });
    assert.equal(selected.count, 1);
    assert.match(selected.text, /^Mid, A\. \(2021\)/);
    assert.deepEqual(await all("text", { documentText: "No citations." }), { text: "", count: 0, unresolvedKeys: [] });

    // A style override: numeric styles label their entries, in order of first citation.
    const ieee = await all("markdown", { style: "ieee", documentText: "[@zeta2020] then [@alpha2019]" });
    assert.match(ieee.text, /^\\\[1\\\] A\. Zeta, “Under\\_score/);
    assert.match(ieee.text.split("\n\n")[1], /^\\\[2\\\] A\. Alpha, “First steps,” \*J\. Tests\*/, "IEEE prints the ISO 4 journal abbreviation");
    const ieeeText = await all("text", { style: "ieee", ids: ["r-mid"] });
    assert.match(ieeeText.text, /^\[1\] A\. Mid, “Middle ground,” J\. Tests, vol\. 3/);
    await assert.rejects(all("text", { style: "<style/>" }), /bundled style or a \.csl file/);

    // A custom .csl in the notebook is read from disk; a missing one falls back to the default.
    const { BUNDLED_CSL_STYLE_XML } = await import("../../src/lib/references/csl/styles.generated");
    await writeFile(path.join(notebookPath("Refs"), "custom.csl"), BUNDLED_CSL_STYLE_XML.ieee);
    assert.match((await all("text", { style: "custom.csl", ids: ["r-mid"] })).text, /^\[1\] A\. Mid/);
    assert.match((await all("text", { style: "missing.csl", ids: ["r-mid"] })).text, /^Mid, A\. \(2021\)/);
  });
});

test("Markdown output never starts a list or keeps raw markup", () => {
  const html = '<div class="csl-bib-body"><div class="csl-entry">1. Smith, <i> Spaced </i> <b>Bold</b> <a href="https://x.org/a_b">https://x.org/a_b</a> <img src=x onerror=alert(1)></div><div class="csl-entry">- dash</div></div>';
  assert.equal(renderBibliography(html, "markdown"), "1\\. Smith,  *Spaced*  **Bold** https://x.org/a\\_b\n\n\\- dash");
  assert.equal(renderBibliography(html, "text"), "1. Smith, Spaced Bold https://x.org/a_b\n- dash");
});

test("the bibliography route returns JSON or a download and validates its input", async () => {
  await withData(async () => {
    await seed();
    const post = (body: unknown, authenticated = true) => bibliographyRoute(new NextRequest("http://localhost/api/references/bibliography", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}) },
      body: JSON.stringify(body),
    }));
    assert.equal((await post({ notebook: "Refs", format: "text" }, false)).status, 401);
    for (const body of [{ format: "text" }, { notebook: "Refs", format: "pdf" }, { notebook: "Refs", format: "text", ids: "x" }, { notebook: "Refs", format: "text", style: "foo" }, { notebook: "Refs", format: "text", download: "yes" }]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post({ notebook: "Missing", format: "text" })).status, 404);

    let response = await post({ notebook: "Refs", format: "markdown", documentText: "[@mid2021] [@nope]" });
    assert.equal(response.status, 200);
    const json = await response.json() as { text: string; count: number; unresolvedKeys: string[] };
    assert.equal(json.count, 1);
    assert.match(json.text, /^Mid, A\. \(2021\)\. Middle ground\. \*Journal of Tests\*/);
    assert.deepEqual(json.unresolvedKeys, ["nope"]);

    response = await post({ notebook: "Refs", format: "markdown", documentText: "[@mid2021] [@nope]", download: true, documentName: "Refs/Essay.md" });
    assert.match(response.headers.get("content-disposition") ?? "", /Essay-bibliography\.md/);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(response.headers.get("x-libera-unresolved-keys"), "nope");
    assert.equal(await response.text(), `${json.text}\n`);

    response = await post({ notebook: "Refs", format: "html", download: true });
    assert.match(response.headers.get("content-disposition") ?? "", /Refs-references\.html/);
    const page = await response.text();
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /<title>Refs-references<\/title>/);
    assert.equal((page.match(/class="csl-entry"/g) ?? []).length, 3);
  });
});

// ---------------------------------------------------------------------------
// LaTeX export
// ---------------------------------------------------------------------------

const signal = new AbortController().signal;
const OPENING = "\\documentclass{article}\n\\begin{document}\n\\maketitle\n";
type Message = { role: string; content: unknown };

/** The BLOCK sections of a chunk task: id and Markdown. */
function taskBlocks(task: string) {
  const markdown = task.slice(task.indexOf("MARKDOWN BLOCKS"));
  return [...markdown.matchAll(/BLOCK (\d+) \([^\n]*\n([\s\S]*?)(?=\n\nBLOCK \d+ \(|$)/g)].map((match) => ({ id: match[1], markdown: match[2] }));
}

/**
 * A mocked model that "converts" each block by copying its Markdown, after
 * `transform` (which may drop or alter placeholders), on each attempt.
 */
function mockModel(transform: (markdown: string, attempt: number) => string = (text) => text) {
  const requests: string[] = [];
  let attempt = 0;
  const complete = async (messages: Message[]) => {
    const task = String(messages.at(-1)!.content);
    requests.push(task);
    if (task.startsWith("TASK: shared preamble")) return { content: OPENING, finishReason: "stop" };
    if (task.startsWith("TASK: convert chunk")) attempt = 0;
    else attempt += 1;
    const chunkTask = task.startsWith("TASK: convert chunk") ? task : [...requests].reverse().find((request) => request.startsWith("TASK: convert chunk"))!;
    const content = taskBlocks(chunkTask).map((block) => `${transform(block.markdown, attempt)}\n% LIBERA_BLOCK_${block.id}_END`).join("\n");
    return { content, finishReason: "stop" };
  };
  return { complete: complete as unknown as Parameters<typeof convertMarkdownToLatex>[3]["complete"], requests, system: () => "" };
}

const DOCUMENT = [
  "# Essay",
  "",
  "As shown [@zeta2020, p. 3], and see [@alphaold; @ghost].",
  "",
  "- [@mid2021] opens this item",
  "",
  "Plain closing words.",
  "",
].join("\n");

test("citations become placeholders that survive chunking and are restored as escaped LaTeX with a bibliography", async () => {
  await withData(async () => {
    await seed();
    const plan = (await prepareLatexCitations(DOCUMENT, "Refs"))!;
    assert.ok(plan);
    assert.ok(!plan.markdown.includes("[@"));
    const placeholders = [...plan.citations.keys()];
    assert.equal(placeholders.length, 3);
    for (const placeholder of placeholders) assert.match(placeholder, /^ZCITE[A-Z]{10}Z$/);
    assert.equal(plan.citations.get(placeholders[0]), "(Zeta, 2020, p. 3)");
    assert.equal(plan.citations.get(placeholders[1]), "(Alpha, 2019; @ghost?)");
    assert.match(plan.bibliography, /^\\section\*\{References\}\n\n\\noindent\\hangindent=2em\\hangafter=1 Alpha, A\. \(2019\)\. First steps\. \\emph\{Journal of Tests\}, \\emph\{3\}, 1--10\.\\par/);
    assert.match(plan.bibliography, /Under\\_score \*star\* \[x\] \\& 50\\% \\\$5 \\textless\{\}script\\textgreater\{\}/);

    // A long paragraph full of citations is split only between words, never through a placeholder.
    const long = Array.from({ length: 400 }, (_, index) => `word${index} [@${["zeta2020", "mid2021", "alpha2019"][index % 3]}]`).join(" ");
    const longPlan = (await prepareLatexCitations(long, "Refs"))!;
    const chunks = planLatexChunks(longPlan.markdown, 2_000);
    const blocks = chunks.chunks.flatMap((chunk) => chunk.blocks);
    assert.ok(blocks.length > 2);
    const found = blocks.flatMap((block) => [...block.markdown.matchAll(longPlan.pattern)].map((match) => match[0]));
    assert.deepEqual(found, [...longPlan.citations.keys()]);

    let compiled = "";
    const model = mockModel();
    const result = await convertMarkdownToLatex(plan.markdown, signal, () => {}, {
      compile: async (source) => { compiled = source; return Buffer.from("%PDF-"); },
      complete: model.complete,
      citations: plan,
    });
    assert.equal(result.source, compiled);
    assert.ok(!plan.pattern.test(result.source));
    assert.match(result.source, /As shown \(Zeta, 2020, p\. 3\), and see \(Alpha, 2019; @ghost\?\)\./);
    assert.match(result.source, /- \(Mid, 2021\) opens this item/);
    assert.match(result.source, /\\section\*\{References\}[\s\S]*Mid, A\. \(2021\)[\s\S]*Zeta, A\. \(2020\)[\s\S]*\\end\{document\}\n$/);
    assert.equal(model.requests.filter((request) => request.startsWith("TASK: convert chunk")).length, 1);
  });
});

test("the prompt tells the model to keep placeholders, keeps the bibliography-tools rule, and is unchanged without citations", async () => {
  await withData(async () => {
    await seed();
    const plain = buildLatexPrompt(DEFAULT_LATEX_OPTIONS);
    assert.ok(!plain.includes("ZCITE"));
    assert.match(plain, /external bibliography tools/);
    const withCitations = buildLatexPrompt(DEFAULT_LATEX_OPTIONS, [], { citations: true });
    assert.ok(withCitations.includes(LATEX_CITATION_PROMPT));
    assert.match(withCitations, /external bibliography tools/);
    assert.equal(withCitations.replace(`\n${LATEX_CITATION_PROMPT}`, ""), plain);

    assert.equal(await prepareLatexCitations("No citations here, just an email a@b.c and `[@code]`.", "Refs"), null);
    const systems: string[] = [];
    const model = mockModel();
    await convertMarkdownToLatex("Just text.", signal, () => {}, {
      compile: async () => Buffer.from("%PDF-"),
      complete: (async (messages: Message[], options: unknown) => {
        systems.push(String(messages[0].content));
        return model.complete!(messages as never, options as never);
      }) as never,
      citations: null,
    });
    assert.equal(systems[0], plain);
    assert.equal(notebookOfDocument("Refs/dir/Essay.md"), "Refs");
    assert.equal(notebookOfDocument(""), null);
  });
});

test("a dropped or altered placeholder is asked for again, then restored at the end of its block", async () => {
  await withData(async () => {
    await seed();
    const plan = (await prepareLatexCitations(DOCUMENT, "Refs"))!;
    const [zeta, alpha] = [...plan.citations.keys()];

    // Dropped on the first attempt, copied on the second: no recovery is needed.
    let model = mockModel((text, attempt) => attempt === 0 ? text.replace(zeta, "") : text);
    let result = await convertMarkdownToLatex(plan.markdown, signal, () => {}, { compile: async () => Buffer.from("%PDF-"), complete: model.complete, citations: plan });
    const retry = model.requests.find((request) => request.startsWith("That reply was rejected"))!;
    assert.match(retry, new RegExp(`placeholders are missing or were altered: ${zeta}`));
    assert.match(result.source, /As shown \(Zeta, 2020, p\. 3\), and see/);

    // Dropped or altered on every attempt: the last attempt puts those citations back at the end of their block,
    // and the remains of the altered placeholder are removed. A placeholder whose case changed still counts.
    const mid = [...plan.citations.keys()][2];
    model = mockModel((text) => text.replace(zeta, "").replace(alpha, alpha.toLowerCase()).replace(mid, mid.slice(0, -1)));
    result = await convertMarkdownToLatex(plan.markdown, signal, () => {}, { compile: async () => Buffer.from("%PDF-"), complete: model.complete, citations: plan });
    assert.equal(model.requests.filter((request) => request.startsWith("That reply was rejected")).length, 2);
    assert.match(result.source, /As shown , and see \(Alpha, 2019; @ghost\?\)\. \(Zeta, 2020, p\. 3\)\n\n% LIBERA_BLOCK_2_END/);
    assert.match(result.source, /\n-  opens this item \(Mid, 2021\)\n\n% LIBERA_BLOCK_3_END/);
    assert.ok(!result.source.includes(plan.nonce));

    // With the block comments gone too, missing citations go at the end of the chunk; none is lost.
    const restored = restoreLatexCitations("Converted text without markers.", [{ id: 7, markdown: `A ${zeta} B ${plan.bibliographyPlaceholder ?? ""}` }], plan, { recover: true });
    assert.deepEqual(restored.missing, [zeta]);
    assert.equal(restored.body, "Converted text without markers. (Zeta, 2020, p. 3)");
  });
});

test("numeric styles produce thebibliography, and the bibliography marker places it", async () => {
  await withData(async () => {
    await seed();
    await updateReferenceLibrary("Refs", null, [{ op: "set-style", style: "ieee" }]);
    const markdown = "[@mid2021] opens.\n\n:::bibliography\n:::\n\nAfter the list [@zeta2020].\n";
    const plan = (await prepareLatexCitations(markdown, "Refs"))!;
    assert.ok(plan.bibliographyPlaceholder);
    assert.ok(!plan.markdown.includes(":::"));
    assert.equal(plan.citations.get([...plan.citations.keys()][0]), "{[1]}");
    assert.equal(plan.bibliography, [
      "\\begin{thebibliography}{9}",
      "\\bibitem{libera-ref-1} A. Mid, ``Middle ground,'' \\emph{J. Tests}, vol. 3, pp. 1--10, 2021.",
      "",
      "\\bibitem{libera-ref-2} A. Zeta, ``Under\\_score *star* [x] \\& 50\\% \\$5 \\textless{}script\\textgreater{}alert(1)\\textless{}/script\\textgreater{},'' \\emph{J. Tests}, vol. 3, pp. 1--10, 2020.",
      "\\end{thebibliography}",
    ].join("\n"));
    const result = await convertMarkdownToLatex(plan.markdown, signal, () => {}, { compile: async () => Buffer.from("%PDF-"), complete: mockModel().complete, citations: plan });
    const at = result.source.indexOf("\\begin{thebibliography}");
    assert.ok(at > result.source.indexOf("{[1]} opens") && at < result.source.indexOf("After the list {[2]}"));
    assert.equal(result.source.match(/thebibliography\}\{/g)?.length, 1);

    // Without a notebook, citations keep their source text (escaped) and there is no bibliography.
    const orphan = (await prepareLatexCitations("Cite [@mid2021].", null))!;
    assert.deepEqual([...orphan.citations.values()], ["{[@mid2021]}"]);
    assert.equal(orphan.bibliography, "");
  });
});

test("the LaTeX export still runs when the document's notebook has no readable library", async () => {
  await withData(async () => {
    const plan = await prepareLatexCitations("Claim [@smith2020, p. 3].", "Missing notebook");
    assert.ok(plan, "citations are still planned");
    assert.equal(plan.citations.size, 1);
    const [latex] = [...plan.citations.values()];
    assert.match(latex, /smith2020/, "an unresolved citation keeps its key");
  });
});
