import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { latexDependencies, latexOpenable } from "../../src/lib/latex/dependencies";
import { writeLatexPath } from "../../src/lib/move-rewrites";
import { archiveFile, moveFile, moveFileToDirectory } from "../../src/lib/storage/files";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { filePathFromParts } from "../../src/lib/storage/paths";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";

// Review 2026-11-25, package X1 (R-H3, R-H4, R-H5): a move writes only the
// LaTeX paths the build can open (latex/build.ts: openin_any=p, BIBINPUTS, the
// work folder's mirror skipping `_` folders), and the check judges the same way.

const folder = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return mkdir(filePathFromParts(notebook, parts), { recursive: true }); };
const read = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return readFile(filePathFromParts(notebook, parts), "utf8"); };
const latexMessages = async (notebook: string) => (await verifyNotebook(notebook)).findings.filter((finding) => finding.check === "latex").map((finding) => finding.message).sort();

const DOCUMENT = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("R-H3: renaming a notebook-root .bib read through BIBINPUTS is written as a name the search finds, not ../", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper/main.tex", DOCUMENT("\\bibliography{refs}"));
  await writeLibraryFile("Nb/refs.bib", "@article{a, title={A}}\n");
  await assertNotebookSound("Nb");
  const moved = await moveFile("Nb/refs.bib", "Nb", "library.bib");
  assert.match(await read("Nb/paper/main.tex"), /\\bibliography\{library\}/);
  assert.deepEqual(moved.links?.skipped ?? [], []);
  await assertNotebookSound("Nb");
}));

test("R-H3: moving main.tex into a subfolder does not write ../ for includes and figures; it says so, and the check agrees", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper/main.tex", DOCUMENT("\\input{chapters/a}\n\\includegraphics{figs/p}\n\\bibliography{refs}"));
  await writeLibraryFile("Nb/paper/chapters/a.tex", "A\n");
  await writeLibraryFile("Nb/paper/figs/p.png", Buffer.from("png"));
  await writeLibraryFile("Nb/paper/refs.bib", "@article{a, title={A}}\n");
  await assertNotebookSound("Nb");
  await folder("Nb/paper/sub");
  const moved = await moveFileToDirectory("Nb/paper/main.tex", "Nb/paper/sub");
  const main = await read("Nb/paper/sub/main.tex");
  assert.doesNotMatch(main, /\.\.\//, "no path the compiler refuses");
  assert.match(main, /\\input\{chapters\/a\}/);
  assert.match(main, /\\includegraphics\{figs\/p\}/);
  // The bibliography has a spelling the search finds (BIBINPUTS holds the notebook folder).
  assert.match(main, /\\bibliography\{paper\/refs\}/);
  assert.deepEqual((moved.links?.skipped ?? []).map((skip) => skip.written).sort(), ["chapters/a", "figs/p"]);
  // The check reports exactly what the move left, by the same rule.
  assert.deepEqual(await latexMessages("Nb"), ['includes "chapters/a.tex", which is not found.', 'shows "figs/p", which is not found.']);
}));

test("R-H3: archiving an \\include'd chapter is left alone (the mirror skips _archive); an \\input of it follows", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/main.tex", DOCUMENT("\\include{one}\n\\input{two}"));
  await writeLibraryFile("Nb/one.tex", "One\n");
  await writeLibraryFile("Nb/two.tex", "Two\n");
  await assertNotebookSound("Nb");
  const first = await archiveFile("Nb/one.tex");
  assert.match(await read("Nb/main.tex"), /\\include\{one\}/);
  assert.deepEqual((first.links?.skipped ?? []).map((skip) => skip.written), ["one"]);
  assert.deepEqual(await latexMessages("Nb"), ['includes "one.tex", which is not found.']);
  const second = await archiveFile("Nb/two.tex");
  assert.match(await read("Nb/main.tex"), /\\input\{_archive\/two\}/);
  assert.deepEqual(second.links?.skipped ?? [], []);
}));

test("R-H3: the check reports a reference the compiler cannot open even when the file is there", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper/main.tex", DOCUMENT("\\input{../shared}\n\\include{_old/one}"));
  await writeLibraryFile("Nb/shared.tex", "S\n");
  await writeLibraryFile("Nb/paper/_old/one.tex", "O\n");
  assert.deepEqual(await latexMessages("Nb"), ['includes "../shared.tex", which is not found.', 'includes "_old/one.tex", which is not found.']);
  assert.equal(latexOpenable("figs/a"), true);
  assert.equal(latexOpenable("../a"), false);
  assert.equal(latexOpenable("_old/a", { include: true }), false);
  assert.equal(latexOpenable("_old/a"), true);
}));

test("R-H4: writeLatexPath refuses a comma in a bibliography key and spaces the readers would trim", () => {
  assert.equal(writeLatexPath("Smith, 2024", "latex-bibliography"), null);
  assert.equal(writeLatexPath("Smith, 2024.bib", "latex-bibresource"), "Smith, 2024.bib");
  assert.equal(writeLatexPath(" lead"), null);
  assert.equal(writeLatexPath("trail "), null);
  assert.equal(writeLatexPath("in side"), "in side");
});

test("R-H4: a .bib renamed to a name with a comma is not written into \\bibliography; it is reported", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/main.tex", DOCUMENT("\\bibliography{refs}"));
  await writeLibraryFile("Nb/refs.bib", "@article{a, title={A}}\n");
  const moved = await moveFile("Nb/refs.bib", "Nb", "Smith, 2024.bib");
  assert.match(await read("Nb/main.tex"), /\\bibliography\{refs\}/);
  assert.deepEqual((moved.links?.skipped ?? []).map((skip) => skip.written), ["refs"]);
  assert.deepEqual(await latexMessages("Nb"), ['uses the bibliography "refs.bib", which is not found.']);
}));

test("R-H5: a subfiles chapter is not a main file, so moving it is not a conflict between builds", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/main.tex", DOCUMENT("\\subfile{chapters/ch}"));
  await writeLibraryFile("Nb/chapters/ch.tex", "\\documentclass[../main.tex]{subfiles}\n\\begin{document}\n\\input{part}\n\\end{document}\n");
  await writeLibraryFile("Nb/part.tex", "Main's part\n");
  await writeLibraryFile("Nb/chapters/part.tex", "Chapter's part\n");
  const files = ["Nb/main.tex", "Nb/chapters/ch.tex", "Nb/part.tex", "Nb/chapters/part.tex"];
  assert.deepEqual((await latexDependencies("Nb", files)).roots, ["Nb/main.tex"]);
  await assertNotebookSound("Nb");
  await folder("Nb/other");
  const moved = await moveFileToDirectory("Nb/chapters/ch.tex", "Nb/other");
  assert.deepEqual(moved.links?.skipped ?? [], []);
  assert.match(await read("Nb/main.tex"), /\\subfile\{other\/ch\}/);
  await assertNotebookSound("Nb");
}));
