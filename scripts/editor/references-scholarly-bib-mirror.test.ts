import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { GET as getMirror, POST as postMirror } from "../../src/app/api/references/bib-mirror/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import {
  addBibliographyChange,
  bibliographyHintField,
  latexBibliographyKind,
  latexCompletionSource,
  latexLibraryEntries,
  latexProjectField,
  setLatexProject,
  type LatexProjectData,
} from "../../src/lib/latex/codemirror/editing";
import {
  BIB_MIRROR_FALLBACK_FILE,
  BIB_MIRROR_FILE,
  BIB_MIRROR_HEADER,
  bibMirrorStatePath,
  flushBibMirror,
  renderBibMirror,
  resetBibMirrorScheduler,
  scheduleBibMirror,
} from "../../src/lib/references/bib-mirror";
import { parseBibtex } from "../../src/lib/references/bibtex";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import type { ReferenceLibrary } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";

// The generated references.bib: opt-in setting, regeneration after library
// transactions, no write when unchanged, protection of hand edits, the route;
// and the LaTeX editor's `\cite` completion from the library with the
// add-bibliography hint.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

async function withNotebook(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-bib-mirror-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Notes");
    await run();
  } finally {
    await flushBibMirror("Notes");
    resetBibMirrorScheduler();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const mirrorFile = () => path.join(notebookPath("Notes"), BIB_MIRROR_FILE);
const fallbackFile = () => path.join(notebookPath("Notes"), BIB_MIRROR_FALLBACK_FILE);
const readMirror = () => readFile(mirrorFile(), "utf8");
const exists = (file: string) => readFile(file).then(() => true, () => false);

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });
function post(body: unknown) {
  return new NextRequest("http://localhost/api/references/bib-mirror", { method: "POST", headers: { "content-type": "application/json", ...cookie() }, body: JSON.stringify(body) });
}

async function addSmith() {
  return updateReferenceLibrary("Notes", null, [{ op: "add", entry: {
    key: "smith2020",
    csl: { type: "article-journal", title: "Sparse attention über alles", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020, 5]] }, "container-title": "Journal of Tests", DOI: "10.1234/abc" },
  } }]);
}

test("the mirror is BibLaTeX with the header, sorted by key, and parses back", () => {
  let library: ReferenceLibrary = emptyReferenceLibrary();
  library = applyLibraryOps(library, [
    { op: "add", entry: { key: "zed2021", csl: { type: "book", title: "Zed" } } },
    { op: "add", entry: { key: "alpha2020", csl: { type: "article-journal", title: "Alpha", "container-title": "J" } } },
  ], "2026-10-18T00:00:00.000Z").library;
  const text = renderBibMirror(library);
  assert.ok(text.startsWith(`${BIB_MIRROR_HEADER}\n\n@article{alpha2020,`));
  assert.ok(text.indexOf("@book{zed2021") > text.indexOf("@article{alpha2020"));
  assert.match(text, /journaltitle = \{J\}/, "BibLaTeX field names");
  assert.deepEqual(parseBibtex(text).entries.map((entry) => entry.sourceKey), ["alpha2020", "zed2021"]);
});

test("enabling writes references.bib at once; library changes regenerate it, debounced; unchanged text is not rewritten", async () => {
  await withNotebook(async () => {
    await addSmith();
    assert.equal(await exists(mirrorFile()), false, "Off by default");
    assert.equal((await postMirror(new NextRequest("http://localhost/api/references/bib-mirror", { method: "POST", body: "{}" }))).status, 401);
    assert.equal((await postMirror(post({ notebook: "Notes", enabled: "yes" }))).status, 400);

    const response = await postMirror(post({ notebook: "Notes", enabled: true }));
    assert.equal(response.status, 200);
    const { library, mirror } = await response.json() as { library: ReferenceLibrary; mirror: { status: string; path: string; entries: number } };
    assert.equal(library.settings?.bibMirror, true);
    assert.deepEqual(mirror, { status: "written", path: "Notes/references.bib", entries: 1 });
    const first = await readMirror();
    assert.match(first, /^% Generated by Libera from this notebook's References\. Edit references in Libera; changes here are overwritten\.\n/);
    assert.match(first, /@article\{smith2020,/);
    assert.match(first, /über alles/, "UTF-8, not LaTeX escapes");
    assert.deepEqual(JSON.parse(await readFile(bibMirrorStatePath("Notes"), "utf8")).version, 1);

    // A library change is written after the debounce, by the storage commit hook.
    const before = await readReferenceLibrary("Notes");
    const smith = Object.values(before.entries)[0];
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: smith.id, csl: { title: "Dense attention" } }]);
    assert.equal(await readMirror(), first, "Not yet: debounced");
    const written = await flushBibMirror("Notes");
    assert.equal(written?.status, "written");
    assert.match(await readMirror(), /title += \{Dense Attention\}|title += \{Dense attention\}/);

    // A change that does not alter the text (notes are not exported) writes nothing.
    const stat = (await import("node:fs/promises")).stat;
    const mtime = (await stat(mirrorFile())).mtimeMs;
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: smith.id, notes: "Private note" }]);
    assert.equal((await flushBibMirror("Notes"))?.status, "unchanged");
    assert.equal((await stat(mirrorFile())).mtimeMs, mtime);

    const got = await getMirror(new NextRequest("http://localhost/api/references/bib-mirror?notebook=Notes", { headers: cookie() }));
    assert.deepEqual((await got.json() as { enabled: boolean }).enabled, true);

    // Turning it off stops regeneration and leaves the file.
    const off = await postMirror(post({ notebook: "Notes", enabled: false }));
    assert.equal((await off.json() as { mirror: { status: string } }).mirror.status, "disabled");
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: smith.id, csl: { title: "Third title" } }]);
    assert.equal(await flushBibMirror("Notes"), null, "Nothing scheduled while off");
    assert.doesNotMatch(await readMirror(), /Third title/);
    assert.ok(await exists(mirrorFile()));
  });
});

test("a references.bib edited by hand (or not written by Libera) is never overwritten: the mirror goes to references.libera.bib", async () => {
  await withNotebook(async () => {
    await addSmith();
    await writeFile(mirrorFile(), "@book{mine, title={My own}}\n", "utf8");
    const response = await postMirror(post({ notebook: "Notes", enabled: true }));
    const { mirror } = await response.json() as { mirror: Record<string, unknown> };
    assert.deepEqual(mirror, { status: "protected", path: "Notes/references.libera.bib", editedPath: "Notes/references.bib", entries: 1 });
    assert.equal(await readMirror(), "@book{mine, title={My own}}\n");
    assert.match(await readFile(fallbackFile(), "utf8"), /@article\{smith2020,/);

    // Once the user removes their file, Libera's mirror takes the place again.
    await rm(mirrorFile());
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: { key: "lee2019", csl: { type: "book", title: "Graphs" } } }]);
    assert.equal((await flushBibMirror("Notes"))?.status, "written");
    // A later hand edit of the mirror is detected by its hash.
    await writeFile(mirrorFile(), `${await readMirror()}\n% my note\n`, "utf8");
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: { key: "kim2018", csl: { type: "book", title: "Kim" } } }]);
    const result = await flushBibMirror("Notes");
    assert.equal(result?.status, "protected");
    assert.match(await readMirror(), /% my note/);
    assert.match(await readFile(fallbackFile(), "utf8"), /@book\{kim2018,/);
  });
});

test("scheduling is cheap and silent when the mirror is off", async () => {
  await withNotebook(async () => {
    const library = await addSmith();
    scheduleBibMirror("Notes", library, 0);
    assert.equal(await flushBibMirror("Notes"), null);
    assert.equal(await exists(mirrorFile()), false);
  });
});

// ---------------------------------------------------------------------------
// LaTeX editor
// ---------------------------------------------------------------------------

const LIBRARY = applyLibraryOps(emptyReferenceLibrary(), [
  { op: "add", entry: { key: "smith2020", csl: { type: "article-journal", title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }, { family: "Doe" }], issued: { "date-parts": [[2020]] } } } },
  { op: "add", entry: { key: "lee2019", csl: { type: "book", title: "Graphs", author: [{ family: "Lee" }], issued: { "date-parts": [[2019]] } } } },
], "2026-10-18T00:00:00.000Z").library;
const leeId = Object.values(LIBRARY.entries).find((entry) => entry.key === "lee2019")!.id;
const WITH_ALIAS = applyLibraryOps(LIBRARY, [{ op: "rename-key", id: leeId, key: "lee2019graphs" }], "2026-10-18T00:00:00.000Z").library;

function view(doc: string, project: Partial<LatexProjectData>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = new EditorView({ state: EditorState.create({ doc, extensions: [latexProjectField] }), parent });
  editor.dispatch({ effects: setLatexProject.of({ labels: [], bibEntries: [], files: [], ...project }) });
  return editor;
}

function complete(editor: EditorView, pos = editor.state.doc.length) {
  const result = latexCompletionSource(new CompletionContext(editor.state, pos, true));
  assert.ok(result);
  return result;
}

function apply(editor: EditorView, option: Completion, from: number, to = editor.state.doc.length) {
  assert.equal(typeof option.apply, "function");
  (option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(editor, option, from, to);
}

test("\\cite completion offers the library's keys and aliases with author, year and title, even without a .bib", () => {
  const entries = latexLibraryEntries(WITH_ALIAS);
  assert.deepEqual(entries, [
    { key: "lee2019graphs", aliases: ["lee2019"], author: "Lee", year: "2019", title: "Graphs" },
    { key: "smith2020", aliases: [], author: "Smith et al.", year: "2020", title: "Sparse attention" },
  ]);
  const editor = view("\\documentclass{article}\n\\begin{document}\nSee \\parencite{", { libraryEntries: entries, bibEntries: [{ key: "smith2020", type: "article", title: "From the bib" }] });
  const result = complete(editor);
  const options = result.options.map((option) => [option.label, option.detail]);
  assert.deepEqual(options, [
    ["smith2020", undefined],
    ["lee2019graphs", "2019 · References"],
    ["lee2019", "alias of lee2019graphs"],
  ], "A key a .bib already offers is not repeated");
  assert.equal(result.options[1].info, "Graphs — Lee");
  editor.destroy();
});

test("choosing a library key in a document without a bibliography offers to add one and turn on the mirror", () => {
  let enabled = 0;
  const source = "\\documentclass{article}\n\\usepackage[style=apa]{biblatex}\n\\begin{document}\nSee \\cite{";
  const editor = view(source, { libraryEntries: latexLibraryEntries(WITH_ALIAS), enableBibMirror: () => { enabled += 1; } });
  const result = complete(editor);
  // The alias inserts the current key.
  apply(editor, result.options.find((option) => option.label === "lee2019")!, result.from);
  assert.ok(editor.state.doc.toString().endsWith("\\cite{lee2019graphs}"));
  assert.deepEqual(editor.state.field(bibliographyHintField), { key: "lee2019graphs", kind: "biblatex" });
  const panel = editor.dom.querySelector(".cm-latex-bibliography-hint")!;
  assert.ok(panel, "The hint shows as a panel");
  assert.match(panel.textContent!, /no bibliography/);
  const [add] = [...panel.querySelectorAll("button")];
  assert.equal(add.textContent, "Add \\addbibresource{references.bib}");
  add.click();
  assert.equal(enabled, 1);
  assert.match(editor.state.doc.toString(), /\\usepackage\[style=apa\]\{biblatex\}\n\\addbibresource\{references.bib\}\n\\begin\{document\}/);
  assert.equal(editor.state.field(bibliographyHintField), null);
  assert.equal(editor.dom.querySelector(".cm-latex-bibliography-hint"), null);

  // With a bibliography, no hint.
  const withBib = view("\\documentclass{article}\n\\begin{document}\n\\cite{\n\\bibliography{refs}\n\\end{document}", { libraryEntries: latexLibraryEntries(LIBRARY) });
  const position = withBib.state.doc.toString().indexOf("\\cite{") + 6;
  const options = complete(withBib, position);
  apply(withBib, options.options.find((option) => option.label === "smith2020")!, options.from, position);
  assert.equal(withBib.state.field(bibliographyHintField), null);
  // A chapter file (the project says its main file has one): no hint either.
  const chapter = view("\\section{One}\n\\cite{", { libraryEntries: latexLibraryEntries(LIBRARY), hasBibliography: true });
  const chapterOptions = complete(chapter);
  apply(chapter, chapterOptions.options[0], chapterOptions.from);
  assert.equal(chapter.state.field(bibliographyHintField), null);
  for (const editorView of [editor, withBib, chapter]) editorView.destroy();
});

test("BibTeX projects get \\bibliography{references} before \\end{document}, with a style when none is set", () => {
  const bibtex = "\\documentclass{article}\n\\usepackage{natbib}\n\\begin{document}\nText % \\end{document} in a comment\n\\end{document}\n";
  assert.equal(latexBibliographyKind(bibtex), "bibtex");
  assert.equal(latexBibliographyKind("% \\usepackage{biblatex}\n\\documentclass{article}"), "bibtex", "Commented out");
  const change = addBibliographyChange(bibtex, "bibtex")!;
  const applied = bibtex.slice(0, change.from) + change.insert + bibtex.slice(change.from);
  assert.ok(applied.endsWith("in a comment\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n"));
  const styled = "\\documentclass{article}\n\\bibliographystyle{abbrvnat}\n\\begin{document}\n\\end{document}";
  assert.equal(addBibliographyChange(styled, "bibtex")!.insert, "\\bibliography{references}\n");
  assert.equal(addBibliographyChange("\\section{Chapter}", "bibtex"), null, "Not a main file");

  let enabled = 0;
  const editor = view("\\section{Chapter}\n\\cite{", { libraryEntries: latexLibraryEntries(LIBRARY), enableBibMirror: () => { enabled += 1; } });
  const result = complete(editor);
  apply(editor, result.options.find((option) => option.label === "smith2020")!, result.from);
  const panel = editor.dom.querySelector(".cm-latex-bibliography-hint")!;
  assert.match(panel.textContent!, /to the main file/);
  const [generate, dismiss] = [...panel.querySelectorAll("button")];
  assert.equal(generate.textContent, "Generate references.bib");
  assert.equal(dismiss.textContent, "Dismiss");
  generate.click();
  assert.equal(enabled, 1);
  assert.equal(editor.state.doc.toString(), "\\section{Chapter}\n\\cite{smith2020}", "No edit outside a main file");
  editor.destroy();
});
