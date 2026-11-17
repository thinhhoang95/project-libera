// Fixture library for the energy bench: one notebook ("Bench") with a long
// Markdown note, a LaTeX report and a text PDF, written into a data folder
// laid out as Libera's server expects (<data>/users/admin/<Notebook>/...).
//
// Everything is generated from a fixed seed, so every run of every version
// sees byte-identical files. The PDF is typeset once with pdflatex and cached.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const WORDS = (
  "the model energy battery editor document reading measure signal latency budget cache layout render " +
  "paragraph section result method sample error figure table value change study effect review margin " +
  "stable typing scroll window panel thread comment theorem proof argument bound estimate converge " +
  "network sensor channel frequency spectrum filter estimate variance prior posterior likelihood"
).split(" ");

/** A small deterministic generator (mulberry32), so fixtures never change between runs. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(random, words = 10 + Math.floor(random() * 14)) {
  const parts = Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]);
  parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return `${parts.join(" ")}.`;
}

function paragraph(random, sentences = 3 + Math.floor(random() * 4)) {
  return Array.from({ length: sentences }, () => sentence(random)).join(" ");
}

/** About 60 KB of Markdown: headings, bold lead-ins, lists, inline and display math, quotes, a table. */
export function longNote(seed = 7) {
  const random = seeded(seed);
  const out = ["# Bench notebook: field notes", "", paragraph(random), ""];
  for (let section = 1; section <= 40; section += 1) {
    out.push(`## ${section}. ${sentence(random, 4).slice(0, -1)}`, "");
    out.push(`**Lead-in ${section}.** ${paragraph(random)}`, "");
    out.push(`${paragraph(random)} The estimate $\\hat{\\theta}_{${section}} = \\frac{1}{n}\\sum_i x_i$ holds here.`, "");
    if (section % 3 === 0) out.push("$$", `E_{${section}} = \\int_0^T P(t)\\,dt + \\sum_{k=1}^{${section}} c_k`, "$$", "");
    out.push(...Array.from({ length: 4 }, () => `- ${sentence(random, 8)}`), "");
    if (section % 5 === 0) {
      out.push("### Details", "", `> ${paragraph(random, 2)}`, "");
      out.push("| Case | Value | Note |", "| --- | --- | --- |");
      for (let row = 0; row < 4; row += 1) out.push(`| ${row + 1} | ${(random() * 100).toFixed(2)} | ${sentence(random, 3)} |`);
      out.push("");
    }
    out.push(paragraph(random), "");
  }
  return `${out.join("\n")}\n`;
}

/** A LaTeX report of a few pages: sections, an equation and a list, quick to typeset. */
export function latexReport(seed = 11) {
  const random = seeded(seed);
  const body = [];
  for (let section = 1; section <= 8; section += 1) {
    body.push(`\\section{${sentence(random, 4).slice(0, -1)}}\\label{sec:${section}}`, "");
    body.push(paragraph(random), "", paragraph(random), "");
    body.push("\\begin{equation}", `  E_{${section}} = \\int_0^T P(t)\\,\\mathrm{d}t \\label{eq:${section}}`, "\\end{equation}", "");
    body.push("\\begin{itemize}", ...Array.from({ length: 3 }, () => `  \\item ${sentence(random, 7)}`), "\\end{itemize}", "");
  }
  return [
    "\\documentclass[11pt]{article}",
    "\\usepackage{amsmath}",
    "\\title{Bench report}",
    "\\author{Libera}",
    "\\begin{document}",
    "\\maketitle",
    "",
    ...body,
    "\\end{document}",
    "",
  ].join("\n");
}

/** The source of a ~30-page text PDF (real text, so the viewer builds a text layer to select and highlight). */
function pdfSource(seed = 13) {
  const random = seeded(seed);
  const body = [];
  for (let section = 1; section <= 24; section += 1) {
    body.push(`\\section{${sentence(random, 5).slice(0, -1)}}`);
    for (let index = 0; index < 6; index += 1) body.push(paragraph(random, 6), "");
  }
  return [
    "\\documentclass[11pt]{article}",
    "\\usepackage[margin=1in]{geometry}",
    "\\begin{document}",
    ...body,
    "\\end{document}",
    "",
  ].join("\n");
}

/** Typesets the PDF once per source hash; later runs copy the cached file. */
async function cachedPdf(cacheDir) {
  const source = pdfSource();
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const cached = path.join(cacheDir, `paper-${hash}.pdf`);
  if (existsSync(cached)) return cached;
  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), "libera-bench-pdf-"));
  try {
    await writeFile(path.join(work, "paper.tex"), source);
    for (let pass = 0; pass < 2; pass += 1) {
      execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "paper.tex"], { cwd: work, stdio: "ignore" });
    }
    await copyFile(path.join(work, "paper.pdf"), cached);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return cached;
}

export const FIXTURE = {
  notebook: "Bench",
  note: "Bench/long-note.md",
  latex: "Bench/report.tex",
  pdf: "Bench/paper.pdf",
};

/** Writes a fresh library into `dataDir` (which must not exist yet or be empty). */
export async function writeFixtureLibrary(dataDir, cacheDir) {
  const notebook = path.join(dataDir, "users", "admin", FIXTURE.notebook);
  await mkdir(notebook, { recursive: true });
  await writeFile(path.join(notebook, "long-note.md"), longNote());
  await writeFile(path.join(notebook, "report.tex"), latexReport());
  await copyFile(await cachedPdf(cacheDir), path.join(notebook, "paper.pdf"));
  return { notebook, sizes: { note: (await readFile(path.join(notebook, "long-note.md"))).length } };
}
