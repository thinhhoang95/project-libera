import assert from "node:assert/strict";
import test from "node:test";
import { addPackages, applyLatexEdits, assembleLatex, convertMarkdownToLatex, locateLatexLine, MAX_REPAIR_ROUNDS, parseChunk, parseOpening } from "../../src/lib/latex-generation";
import { estimateTokens, latexChunkCharacters, planLatexChunks } from "../../src/lib/latex-chunks";
import { compileLatex, findPdfLatex } from "../../src/lib/latex-export";

const signal = new AbortController().signal;
const OPENING = "\\documentclass{article}\n\\usepackage{amsmath}\n\\title{T}\n\\begin{document}\n\\maketitle\n";
const pdf = async () => Buffer.from("%PDF-");
type Message = { role: string; content: unknown };
const lastTask = (messages: Message[]) => String(messages.at(-1)!.content);
const blockIds = (task: string) => [...task.matchAll(/required end comment: % LIBERA_BLOCK_(\d+)_END/g)].map((match) => match[1]);
const convertedChunk = (task: string, text = "Body") => blockIds(task).map((id) => `${text} ${id}\n% LIBERA_BLOCK_${id}_END`).join("\n");

function longMarkdown(sections: number) {
  return "# Title\n\n" + Array.from({ length: sections }, (_, index) => `## Section ${index + 1}\n\n${("Sentence about topic. ").repeat(150)}\n`).join("\n");
}

test("chunks are sized by estimated output tokens for the document's script", () => {
  assert.equal(estimateTokens("abcd".repeat(100)), 100);
  assert.equal(estimateTokens("漢字"), 2);
  const english = latexChunkCharacters("Plain English text. ".repeat(1_000));
  const chinese = latexChunkCharacters("中文文本。".repeat(1_000));
  assert.ok(english > 25_000 && english < 35_000, String(english));
  assert.ok(chinese < english / 3, String(chinese));
  // The 200,000-character export limit needs only a handful of chunks.
  assert.ok(planLatexChunks(longMarkdown(60)).chunks.length <= 8);
});

test("planner marks the title, list ordinals and continued paragraphs", () => {
  const plan = planLatexChunks("# My Title\n\n" + ("word ".repeat(2_000)) + "\n\n" + Array.from({ length: 3 }, (_, i) => `${i + 1}. ${"item ".repeat(700)}`).join("\n"), 6_000);
  const blocks = plan.chunks.flatMap((chunk) => chunk.blocks);
  assert.equal(plan.title, "My Title");
  assert.equal(blocks[0].title, true);
  assert.ok(blocks.some((block) => block.continues) && blocks.some((block) => block.continuation));
  assert.deepEqual(blocks.filter((block) => block.listStart).map((block) => block.listStart), [1, 2, 3]);
});

test("chunk parsing tolerates fences, stray document commands and inline markers, and hoists packages", () => {
  const chunk = planLatexChunks("First paragraph.\n\nSecond paragraph.").chunks[0];
  const parsed = parseChunk("```latex\n\\usepackage{xcolor}\nFirst. % LIBERA_BLOCK_1_END\nSecond.\n%LIBERA_BLOCK_2_END\n\\end{document}\n```\n% LIBERA_CHUNK_1_DONE", chunk);
  assert.deepEqual(parsed.packages, ["\\usepackage{xcolor}"]);
  assert.match(parsed.body, /^First\.\s*\n% LIBERA_BLOCK_1_END\nSecond\.\s*\n% LIBERA_BLOCK_2_END\n$/);
  assert.throws(() => parseChunk("Only first\n% LIBERA_BLOCK_1_END", chunk), /Expected/);
  assert.throws(() => parseChunk("A\n% LIBERA_BLOCK_1_END\n% LIBERA_BLOCK_2_END", chunk), /no converted content/);
  assert.equal(parseOpening("Here you go:\n```latex\n" + OPENING + "\\end{document}\n```"), OPENING);
  assert.throws(() => parseOpening("No preamble"), /documentclass/);
  assert.equal(addPackages(OPENING, ["\\usepackage{amsmath}", "\\usepackage{xcolor}"]).match(/xcolor/g)?.length, 1);
  assert.ok(!addPackages(OPENING, ["\\usepackage{amsmath}"]).includes("amsmath}\n\\usepackage{amsmath"));
});

test("a long document is converted chunk by chunk, in order, in one growing thread", async () => {
  const markdown = longMarkdown(8);
  const plan = planLatexChunks(markdown, 6_000);
  assert.ok(plan.chunks.length >= 4);
  const started: number[] = [];
  let inFlight = 0, peak = 0, previousLength = 0;
  const complete = async (messages: Message[]) => {
    // Each request extends the previous one, so the prompt prefix stays cacheable.
    assert.ok(messages.length > previousLength);
    previousLength = messages.length;
    const task = lastTask(messages);
    if (task.startsWith("TASK: shared preamble")) return { content: OPENING, finishReason: "stop" };
    started.push(Number(task.match(/^TASK: convert chunk (\d+)/)![1]));
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--;
    return { content: convertedChunk(task), finishReason: "stop" };
  };
  const compiled: string[] = [];
  const result = await convertMarkdownToLatex(markdown, signal, () => {}, { complete: complete as never, chunkCharacters: 6_000, compile: async (source) => { compiled.push(source); return pdf(); } });
  assert.deepEqual(started, plan.chunks.map((_, index) => index + 1));
  assert.equal(peak, 1);
  assert.equal(compiled.length, 1);
  assert.ok(result.source.startsWith(OPENING) && result.source.endsWith("\\end{document}\n"));
  assert.equal(result.source.match(/% LIBERA_BLOCK_\d+_END/g)?.length, plan.chunks.flatMap((chunk) => chunk.blocks).length);
});

test("a chunk with garbled markers is retried in the thread and accepted on the last attempt if complete", async () => {
  let calls = 0;
  const complete = async (messages: Message[]) => {
    if (lastTask(messages).startsWith("TASK: shared preamble")) return { content: OPENING, finishReason: "stop" };
    calls++;
    if (calls > 1) assert.match(lastTask(messages), /^That reply was rejected/);
    return { content: "Hello world, this is a paragraph. Nothing marks it.", finishReason: "stop" };
  };
  const result = await convertMarkdownToLatex("Hello world, this is a paragraph.", signal, () => {}, { complete: complete as never, compile: pdf });
  assert.equal(calls, 3);
  assert.match(result.source, /Nothing marks it/);
});

test("edits apply to whichever piece uniquely matches and are rejected atomically otherwise", () => {
  const pieces = { opening: OPENING, bodies: ["\\section{A}\n  \\bad{x}\n% LIBERA_BLOCK_1_END\n", "Same\n% LIBERA_BLOCK_2_END\n", "Same\n% LIBERA_BLOCK_3_END\n"] };
  const edited = applyLatexEdits(pieces, "<<<<<<< SEARCH\n    9 | \\bad{x}\n=======\n\\textbf{x}\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n\\begin{document}\n=======\n\\usepackage{xcolor}\n\\begin{document}\n>>>>>>> REPLACE");
  assert.equal(edited.bodies[0], "\\section{A}\n\\textbf{x}\n% LIBERA_BLOCK_1_END\n");
  assert.match(edited.opening, /xcolor\}\n\\begin\{document\}/);
  assert.equal(edited.bodies[1], pieces.bodies[1]);
  assert.throws(() => applyLatexEdits(pieces, "<<<<<<< SEARCH\nSame\n=======\nX\n>>>>>>> REPLACE"), /matches 2 places/);
  assert.throws(() => applyLatexEdits(pieces, "<<<<<<< SEARCH\n\\bad{x}\n=======\nok\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nMissing\n=======\nX\n>>>>>>> REPLACE"), /Edit 2: .*not found/);
  assert.equal(pieces.bodies[0], "\\section{A}\n  \\bad{x}\n% LIBERA_BLOCK_1_END\n");
  assert.throws(() => applyLatexEdits(pieces, "Here is the whole document again."), /No edit blocks/);
});

test("compile errors go back to the same thread as edits until the PDF compiles", async (context) => {
  let executable: string;
  try { executable = await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const tasks: string[] = [];
  const complete = async (messages: Message[]) => {
    const task = lastTask(messages);
    tasks.push(task);
    if (task.startsWith("TASK: shared preamble")) return { content: OPENING, finishReason: "stop" };
    if (task.startsWith("TASK: convert chunk")) return { content: "\\usepackage{xcolor}\n\\textcolor{red}{ok}\n\\badcommand\n\\begin{itemize}\n\\item one\n% LIBERA_BLOCK_1_END", finishReason: "stop" };
    if (/\\badcommand/.test(task)) return { content: "<<<<<<< SEARCH\n\\badcommand\n=======\nfixed\n>>>>>>> REPLACE", finishReason: "stop" };
    assert.match(task, /itemize/);
    return { content: "<<<<<<< SEARCH\n\\item one\n=======\n\\item one\n\\end{itemize}\n>>>>>>> REPLACE", finishReason: "stop" };
  };
  const result = await convertMarkdownToLatex("Paragraph.", signal, () => {}, { complete: complete as never, compile: (source) => compileLatex(source, executable, signal) });
  assert.equal(tasks.filter((task) => task.startsWith("TASK: fix")).length, 2);
  assert.match(result.source, /\\usepackage\{xcolor\}\n\\begin\{document\}/);
  assert.match(result.source, /fixed\n\\begin\{itemize\}\n\\item one\n\\end\{itemize\}/);
  assert.equal(result.pdf.subarray(0, 5).toString(), "%PDF-");
});

test("repair rounds are bounded and errors are traced to the owning chunk", async () => {
  const pieces = { opening: OPENING, bodies: ["A\n% LIBERA_BLOCK_1_END\n", "\\broken\n% LIBERA_BLOCK_2_END\n"] };
  const line = assembleLatex(pieces).split("\n").indexOf("\\broken") + 1;
  assert.equal(locateLatexLine(pieces, line), 1);
  assert.equal(locateLatexLine(pieces, 2), -1);
  let repairs = 0;
  const complete = async (messages: Message[]) => {
    const task = lastTask(messages);
    if (task.startsWith("TASK: shared preamble")) return { content: OPENING, finishReason: "stop" };
    if (task.startsWith("TASK: convert chunk")) return { content: convertedChunk(task), finishReason: "stop" };
    repairs++;
    assert.match(task, /\(chunk 1\):\n[\s\S]*\| Body 1/);
    return { content: `<<<<<<< SEARCH\nBody 1\n=======\nBody 1\n>>>>>>> REPLACE`, finishReason: "stop" };
  };
  await assert.rejects(convertMarkdownToLatex("Para.", signal, () => {}, { complete: complete as never, compile: async () => { throw new Error("./document.tex:6: Undefined control sequence."); } }), /still failed after 8 repair rounds/);
  assert.equal(repairs, MAX_REPAIR_ROUNDS);
});
