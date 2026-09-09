import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import JSZip from "jszip";
import { prepareLatexImages, assertLatexImagesIncluded, latexImagesPrompt } from "../../src/lib/latex-images";
import { compileLatex, exportLatexPdf, findPdfLatex } from "../../src/lib/latex-export";
import { DEFAULT_LATEX_OPTIONS, parseLatexOptions } from "../../src/lib/latex-options";

const signal = new AbortController().signal;
const photo = () => sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).jpeg().toBuffer();

test("Markdown and reference images resolve once, while code examples stay untouched", async () => {
  const body = await photo();
  const sources: string[] = [];
  const asset = "_assets/MILP-Hotspot/gap-investigation/photo_2026-09-02-09.34.23.jpeg";
  const markdown = `![photo_2026-09-02 09.34.23](${asset})\n![Again][photo]\n\n[photo]: ${asset}\n\n\`![example](missing.png)\`\n\n\`\`\`markdown\n![example](missing.png)\n\`\`\``;
  const result = await prepareLatexImages(markdown, "Notebook/MILP-Hotspot/gap-investigation.md", signal, async (document, source) => {
    assert.equal(document, "Notebook/MILP-Hotspot/gap-investigation.md");
    sources.push(source); return { body };
  });
  assert.deepEqual(sources, [asset]);
  assert.equal(result.images.length, 1);
  assert.equal((result.markdown.match(/\]\(image-1.png\)/g) || []).length, 2);
  assert.ok(result.markdown.includes("![example](missing.png)"));
  assert.equal((await sharp(result.images[0].body).metadata()).format, "png");
  assert.throws(() => assertLatexImagesIncluded("placeholder", result.images), /omitted/);
  assert.throws(() => assertLatexImagesIncluded(String.raw`% \includegraphics{image-1.png}`, result.images), /omitted/);
  assert.throws(() => assertLatexImagesIncluded(String.raw`\includegraphics[draft]{image-1.png}`, result.images), /draft/);
  assertLatexImagesIncluded(String.raw`\includegraphics[width=0.75\textwidth]{image-1.png}`, result.images);
});

test("image width defaults migrate old preferences and reject invalid widths", () => {
  assert.equal(parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, imageWidth: undefined }).imageWidth, 0.75);
  for (const imageWidth of [0, -1, 2, NaN, "0.5"]) {
    assert.throws(() => parseLatexOptions({ ...DEFAULT_LATEX_OPTIONS, imageWidth }), /Image width/);
  }
  assert.ok(latexImagesPrompt([{ fileName: "image-1.png", body: Buffer.alloc(0) }], 0.6).includes(String.raw`width=0.6\textwidth`));
});

test("missing local images fail explicitly instead of exporting a placeholder", async () => {
  await assert.rejects(prepareLatexImages("![Missing](_assets/doc/missing.jpg)", "Book/doc.md", signal, async () => { throw new Error("File not found"); }), /missing.jpg.*File not found/);
});

test("notebook asset path resolves to a real staged image embedded by pdflatex", async (context) => {
  let executable: string;
  try { executable = await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-image-test-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const { ADMIN_USER } = await import("../../src/lib/storage/constants");
    const notebook = path.join(directory, "users", ADMIN_USER, "Book");
    const asset = "_assets/MILP-Hotspot/gap-investigation/photo_2026-09-02-09.34.23.jpeg";
    await mkdir(path.join(notebook, "MILP-Hotspot"), { recursive: true });
    await mkdir(path.dirname(path.join(notebook, asset)), { recursive: true });
    await writeFile(path.join(notebook, "MILP-Hotspot", "gap-investigation.md"), "# Document");
    await writeFile(path.join(notebook, asset), await photo());
    const result = await prepareLatexImages(`![Photo](${asset})`, "Book/MILP-Hotspot/gap-investigation.md", signal);
    const source = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics[width=0.75\textwidth]{image-1.png}
\end{document}`;
    const pdf = await compileLatex(source, executable, signal, result.images);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.toString("latin1"), /\/Subtype \/Image/);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test("export repairs omitted images, preserves width and bundles compilable sources", async (context) => {
  try { await findPdfLatex(signal); } catch { context.skip("pdflatex is not installed"); return; }
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.ok(body.messages[0].content.includes(String.raw`width=0.6\textwidth`));
    assert.ok(body.messages[0].content.includes("image-1.png"));
    calls++;
    const content = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
` + (calls === 1 ? "Placeholder" : String.raw`\includegraphics[width=0.6\textwidth]{image-1.png}`) + String.raw`
\end{document}`;
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  });
  try {
    const image = (await photo()).toString("base64");
    const result = await exportLatexPdf(`![Photo](data:image/jpeg;base64,${image})`, signal, () => {}, { ...DEFAULT_LATEX_OPTIONS, imageWidth: 0.6 });
    assert.equal(calls, 2);
    assert.match(Buffer.from(result.pdf, "base64").toString("latin1"), /\/Subtype \/Image/);
    assert.ok(result.archive);
    const archive = await JSZip.loadAsync(result.archive, { base64: true });
    assert.equal(await archive.file("document.tex")?.async("string"), result.source);
    assert.ok(archive.file("image-1.png"));
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
