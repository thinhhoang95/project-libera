import assert from "node:assert/strict";
import test from "node:test";
import { buildLatexPrompt, compileLatex, exportLatexPdf, findPdfLatex } from "../../src/lib/latex-export";
import { LatexThread } from "../../src/lib/latex-generation";

import { DEFAULT_LATEX_OPTIONS, latexToday, latexLayoutPrompt, parseLatexOptions } from "../../src/lib/latex-options";

const signal = new AbortController().signal;
const start = "\\documentclass{article}\n\\begin{document}\n";
const end = "\\end{document}";

test("the LaTeX thread keeps one session, forces the requested model and continues cut-off replies in place", async () => {
  let calls = 0;
  const instructions = "Use blue section headings.\nKeep tables near their references.";
  const prompt = buildLatexPrompt({ ...DEFAULT_LATEX_OPTIONS, customInstructions: instructions });
  assert.ok(prompt.includes(instructions));
  assert.ok(prompt.includes("Required page layout"));
  assert.equal(buildLatexPrompt({ ...DEFAULT_LATEX_OPTIONS, customInstructions: " \n " }), buildLatexPrompt(DEFAULT_LATEX_OPTIONS));
  const sessions = new Set<string | undefined>();
  const thread = new LatexThread(prompt, signal, () => {}, async (messages, options) => {
    assert.deepEqual(messages[0], { role: "system", content: prompt });
    assert.equal(options?.model, "openai/gpt-5.6-luna");
    assert.deepEqual(options?.reasoning, { effort: "low" });
    assert.equal(options?.maxTokens, 16000);
    sessions.add(options?.sessionId);
    calls++;
    if (calls === 1) return { content: "```latex\n" + start + "\\text", finishReason: "length" };
    if (calls === 2) {
      assert.equal(messages.at(-2)?.role, "assistant");
      assert.match(String(messages.at(-1)?.content), /cut off/);
      return { content: "bf{Hello}\n```", finishReason: "stop" };
    }
    // A later turn sees every earlier turn of the same conversation.
    assert.deepEqual(messages.slice(1).map((message) => message.role), ["user", "assistant", "user", "assistant", "user"]);
    return { content: "Next", finishReason: "stop" };
  });
  assert.equal(await thread.ask("Document", "Converting"), start + "\\textbf{Hello}\n");
  assert.equal(await thread.ask("More", "Converting"), "Next");
  assert.equal(calls, 3);
  assert.equal(sessions.size, 1);
  assert.ok([...sessions][0]);
});

test("endless and empty replies fail with bounded calls", async () => {
  let calls = 0;
  await assert.rejects(new LatexThread("S", signal, () => {}, async () => { calls++; return { content: "More", finishReason: "length" }; }).ask("Go", "Converting"), /incomplete after 3 parts/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(new LatexThread("S", signal, () => {}, async () => { calls++; return { content: " ", finishReason: "stop" }; }).ask("Go", "Converting"), /empty/);
  assert.equal(calls, 3);
});

test("pdflatex produces a PDF and reports errors for repair", async (context) => {
  let executable: string;
  try { executable = await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const pdf = await compileLatex(start + "\\section{Test}Hello $x^2$.\n" + end, executable, signal);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  await assert.rejects(compileLatex(start + "\\undefinedcommand\n" + end, executable, signal), /Undefined control sequence/);
});


test("export sends compiler failures back to the same thread and returns a valid PDF", async (context) => {
  try { await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  const sessions = new Set<string>();
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "openai/gpt-5.6-luna");
    assert.equal(body.reasoning.effort, "low");
    assert.match(body.messages[0].content, /12pt,letterpaper,oneside/);
    assert.ok(body.messages[0].content.includes(String.raw`\author{A\&B}`));
    assert.ok(body.messages[0].content.includes(String.raw`\date{2026-09-09}`));
    assert.ok(body.messages[0].content.includes("\\fancyfoot[C]{Custom footer}"));
    assert.ok(body.messages[0].content.includes("Libera by Thinh Hoang"));
    assert.equal(body.messages[0].role, "system");
    assert.ok(body.messages[0].content.includes("Use blue section headings.\nKeep tables near their references."));
    sessions.add(body.session_id);
    const task: string = body.messages.at(-1).content;
    let content: string;
    if (task.startsWith("TASK: shared preamble")) content = start + "% LIBERA_PREAMBLE_DONE";
    else if (task.startsWith("TASK: convert chunk")) content = "\\undefinedcommand\n% LIBERA_BLOCK_1_END";
    else {
      assert.match(task, /Undefined control sequence/);
      assert.match(task, /\(chunk 1\):/);
      // The repair turn continues the conversation that produced the chunk.
      assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === "assistant" && message.content.includes("\\undefinedcommand")));
      content = "<<<<<<< SEARCH\n\\undefinedcommand\n=======\nRepaired document\n>>>>>>> REPLACE";
    }
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  });
  try {
    const result = await exportLatexPdf("# Test document", signal, () => {}, { ...DEFAULT_LATEX_OPTIONS, paperSize: "letter", fontSize: 12, author: "A&B", date: "2026-09-09", footer: "Custom footer", showAppName: true, customInstructions: "Use blue section headings.\nKeep tables near their references." });
    assert.equal(calls, 3); // preamble, chunk, one repair edit
    assert.equal(sessions.size, 1);
    assert.match(result.source, /Repaired document/);
    assert.equal(Buffer.from(result.pdf, "base64").subarray(0, 5).toString(), "%PDF-");
  } finally {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("canceled exports do not call the model", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new LatexThread("S", controller.signal, () => {}, async () => {
    assert.fail("Model must not be called after cancellation");
  }).ask("Document", "Converting"), /abort/i);
});


test("layout defaults and validation reject invalid geometry and option types", () => {
  assert.deepEqual(parseLatexOptions(), DEFAULT_LATEX_OPTIONS);
  assert.equal(parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, customInstructions: undefined }).customInstructions, "");
  for (const customInstructions of [null, 123, "x".repeat(10_001)]) {
    assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, customInstructions }), /Custom instructions/);
  }
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, fontSize: 14 }), /font size/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, fontSize: "11" }), /font size/);
  assert.equal(parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, fontSize: undefined }).fontSize, 12);
  for (const fontSize of [10, 11, 12] as const) {
    assert.ok(latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, fontSize }).includes(`\\documentclass[${fontSize}pt,a4paper,oneside]`));
  }
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, paperSize: "a3" }), /paper/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, margins: { left: -1 } }), /Margins/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, margins: { left: NaN } }), /Margins/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, margins: { left: 5, right: 5, top: 1, bottom: 1 } }), /Reduce/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, showAppName: "yes" }), /app name/);
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, header: "x".repeat(501) }), /500/);
});

test("preamble clears default marks, escapes custom text and positions footer marks", () => {
  const plain = latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, footer: "A&B_50%" });
  assert.ok(plain.includes(String.raw`\fancyfoot[L]{A\&B\_50\%}`));
  assert.ok(plain.includes(String.raw`\fancyfoot[R]{}`));
  assert.ok(plain.includes("left=1in,right=1in,top=1in,bottom=1in"));
  const branded = latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, header: "Title", footer: "Note", showAppName: true });
  assert.ok(branded.includes(String.raw`\fancyhead[C]{Title}`));
  assert.ok(branded.includes(String.raw`\fancyfoot[C]{Note}`));
  assert.ok(branded.includes(String.raw`\fancyfoot[R]{Libera by Thinh Hoang}`));
  assert.ok(branded.includes(String.raw`\fancypagestyle{plain}`));
});

test("requested preamble compiles for each paper size with custom header and footer", async (context) => {
  let executable: string;
  try { executable = await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  for (const [paperSize, fontSize] of [["a4", 10], ["letter", 11], ["a5", 12]] as const) {
    const prompt = latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, paperSize, fontSize, author: "A&B", date: "2026-09-09", header: "A&B 50%", footer: "Custom note", showAppName: true });
    const preamble = prompt.slice(prompt.indexOf(String.raw`\documentclass`));
    const pdf = await compileLatex(preamble + String.raw`
\begin{document}
\title{Test}\maketitle
Hello.\newpage Second page.
\end{document}`, executable, signal);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
});


test("author/date defaults migrate saved options and validate real calendar dates", () => {
  const migrated = parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, author: undefined, date: undefined });
  assert.equal(migrated.author, "");
  assert.equal(migrated.date, "");
  assert.equal(latexToday(new Date(2026, 8, 9, 23, 59)), "2026-09-09");
  assert.ok(latexLayoutPrompt(migrated).includes(`\\date{${latexToday()}}`));
  assert.equal(parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, date: "2028-02-29" }).date, "2028-02-29");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "today", null]) {
    assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, date }), /valid date/);
  }
  assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, author: "x".repeat(501) }), /Author/);
});


test("blank footers use page / total pages in the correct footer position", async (context) => {
  for (const showAppName of [false, true]) {
    const prompt = latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, footer: "   ", showAppName });
    const mark = `\\fancyfoot[${showAppName ? "C" : "L"}]{\\thepage{} / \\pageref{LastPage}}`;
    assert.equal(prompt.split(mark).length - 1, 2); // fancy and plain/title pages
    assert.ok(prompt.includes(String.raw`\usepackage{lastpage}`));
  }
  assert.ok(!latexLayoutPrompt({ ...DEFAULT_LATEX_OPTIONS, footer: "Custom" }).includes(String.raw`\usepackage{lastpage}`));
  let executable: string;
  try { executable = await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const prompt = latexLayoutPrompt(DEFAULT_LATEX_OPTIONS);
  const source = prompt.slice(prompt.indexOf(String.raw`\documentclass`)) + String.raw`
\begin{document}
\title{Page count test}\maketitle
First page.\newpage Second page.
\end{document}`;
  const pdf = await compileLatex(source, executable, signal);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
