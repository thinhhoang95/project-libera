import assert from "node:assert/strict";
import fsp, { mkdir, readFile, writeFile } from "node:fs/promises";
import test, { mock } from "node:test";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { archiveFile, archiveFolder, moveFile, moveFileToDirectory, renameFolder, textVersion } from "../../src/lib/storage/files";
import { fileExistence, linkCandidates, resolveLinkTargetWith } from "../../src/lib/storage/library-links";
import { createMarkdownFileLinkDestination } from "../../src/lib/markdown-file-links";
import { extractMarkdownLinkOccurrences } from "../../src/lib/markdown-link-occurrences";
import { markdownPathOccurrences, rewriteMovedPaths } from "../../src/lib/move-rewrites";
import { latexPathOccurrences } from "../../src/lib/latex/path-occurrences";
import { resolveDeckRelativePath } from "../../src/lib/slide-charts";
import { rawFileSourcePath } from "../../src/lib/markdown-image-sources";
import { linkRewriteByPath, rewriteOpenText } from "../../src/components/libera/tab-retarget";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { addReviewThreads, findReview } from "../../src/lib/storage/markdown-reviews";
import { listPendingReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import type { LiberaLinkRewrites } from "../../src/lib/types";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Links follow moved files (docs/features/move-link-refactor.md). The
// notebook check is the oracle: after every move, every notebook involved
// reports nothing it did not report before (here: only the link that was
// already broken). And each rewritten path is resolved again, as the editor
// resolves it, to the file it opened before: the intended file, not just some file.

const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const read = (relative: string) => readFile(disk(relative), "utf8");
const folder = (relative: string) => mkdir(disk(relative), { recursive: true });
const BROKEN = '"docs/missing.md" finds no file';

/** The file a link opens from its note, as the editor resolves it on the disk as it is. */
async function opens(note: string, href: string) {
  const existence = fileExistence();
  await existence.check(linkCandidates(href, note));
  return resolveLinkTargetWith(href, note, existence.exists)?.path ?? null;
}

/** The destination of the Markdown link whose text is `label`, as the note now writes it. */
async function hrefOf(note: string, label: string) {
  const found = extractMarkdownLinkOccurrences(await read(note)).find((occurrence) => occurrence.excerpt.text === label);
  assert.ok(found, `${note} has a link "${label}"`);
  return found.href;
}

async function opensLabel(note: string, label: string) {
  return opens(note, await hrefOf(note, label));
}

const position = createMarkdownFileLinkDestination({ sourcePath: "Nb/stay.md", targetPath: "Nb/docs/target.md", metadata: { v: 1, line: 3 } });
const annotation = createMarkdownFileLinkDestination({ sourcePath: "Nb/stay.md", targetPath: "Nb/docs/paper.pdf", metadata: { v: 1, fileType: "pdf", viewState: { pdf: { selectedAnnotationId: "a1" } } } });

const STAY = [
  "# Stay",
  "",
  "[inline](docs/target.md) and [heading](docs/target.md#section) and [query](docs/target.md?view=1#section)",
  "",
  "[reference][ref] and [collapsed][] and [angle](<docs/target.md> \"Target title\") and [root](Nb/docs/target.md)",
  "",
  `[spaced](docs/my%20note.md) and [position](${position}) and <a href="docs/target.md">html</a>`,
  "",
  `[annotated](${annotation}) and [moment](docs/memo.m4a#t=3)`,
  "",
  "![figure](/api/files/raw/Nb/docs/fig.png) <img src=\"/api/files/raw/Nb/docs/fig.png\" alt=\"fig\">",
  "",
  "[broken](docs/missing.md) and [external](https://example.com/docs/target.md) and `[code](docs/target.md)`",
  "",
  "```md",
  "[fenced](docs/target.md)",
  "```",
  "",
  "```chart",
  "type: bar",
  "data: docs/data.csv",
  "```",
  "",
  "[ref]: docs/target.md \"Ref title\"",
  "[ref]: docs/other.md",
  "[collapsed]: <docs/target.md>",
  "",
].join("\n");

const TARGET = [
  "# Target",
  "",
  "## Section",
  "",
  "[up](../stay.md) and [sibling](other.md) and [self](target.md#section) and [rooted](Nb/stay.md)",
  "",
  "![figure](/api/files/raw/Nb/docs/fig.png)",
  "",
  "```chart",
  "data: \"data.csv\"",
  "```",
  "",
].join("\n");

/**
 * The fixture. The moved note owns an upload (`_assets/...`, which names the
 * notebook, not the note's folder), and the note that stays shows it by its
 * `/api/markdown-assets/raw?document=…&asset=…` address: neither is rewritten,
 * both must still show. Returns the moved note's text as written.
 */
async function seed() {
  await writeLibraryFile("Nb/docs/target.md", TARGET);
  const upload = await writeMarkdownImageAsset("Nb/docs/target.md", new File(["photo-bytes"], "photo.png"));
  const target = `${TARGET}${upload.markdown}\n`;
  await writeLibraryFile("Nb/docs/target.md", target);
  await writeLibraryFile("Nb/stay.md", `${STAY}\n![shown](${upload.rawUrl})\n`);
  await writeLibraryFile("Nb/docs/other.md", "# Other\n");
  await writeLibraryFile("Nb/docs/my note.md", "# Spaced\n");
  await writeLibraryFile("Nb/docs/data.csv", "label,value\na,1\n");
  await writeLibraryFile("Nb/docs/fig.png", Buffer.from("png-bytes"));
  await writeLibraryFile("Nb/docs/memo.m4a", Buffer.from("audio"));
  await writeLibraryFile("Nb/docs/paper.pdf", "%PDF-1.4 a");
  await writeAt(pdfAnnotationsPath("Nb", ["docs", "paper.pdf"]), JSON.stringify({ annotations: [{ id: "a1", type: "highlight", pageNumber: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] }], comments: [] }));
  await writeLibraryFile("Other/x.md", "[cross](Nb/docs/target.md) and [relcross](../Nb/docs/target.md)\n");
  // Before anything moves, the only finding is the broken link.
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
  return { target, upload };
}

type Layout = { target: string; other: string; spaced: string; data: string; fig: string; paper: string; memo: string };

/** Every link of the fixture opens the file it opened before, at its new place; what must not change did not. */
async function assertFollowed(layout: Layout, { root = "Nb/", chartFollows = true }: { root?: string; chartFollows?: boolean } = {}) {
  for (const label of ["inline", "heading", "query", "reference", "collapsed", "angle", "root", "position"]) {
    assert.equal(await opensLabel("Nb/stay.md", label), layout.target, `"${label}" opens the moved note`);
  }
  assert.equal(await opensLabel("Nb/stay.md", "spaced"), layout.spaced);
  assert.equal(await opensLabel("Nb/stay.md", "annotated"), layout.paper);
  assert.equal(await opensLabel("Nb/stay.md", "moment"), layout.memo);
  assert.match(await hrefOf("Nb/stay.md", "moment"), /#t=3$/);
  const stay = await read("Nb/stay.md");
  // Addresses that name the notebook, not a folder: as written.
  assert.match(stay, /!\[shown\]\(\/api\/markdown-assets\/raw\?document=/);
  // The link's own style: a relative link stays relative, a library path stays one, titles, brackets and fragments stay.
  assert.ok((await hrefOf("Nb/stay.md", "root")).startsWith(root), await hrefOf("Nb/stay.md", "root"));
  assert.ok(!(await hrefOf("Nb/stay.md", "inline")).startsWith("Nb/"));
  assert.match(stay, /\[angle\]\(<[^>]+> "Target title"\)/);
  assert.match(stay, /\[ref\]: \S+ "Ref title"/);
  assert.match(await hrefOf("Nb/stay.md", "heading"), /#section$/);
  assert.match(await hrefOf("Nb/stay.md", "query"), /\?view=1#section$/);
  assert.match(await hrefOf("Nb/stay.md", "position"), /#libera=/);
  // Untouched: the broken link, code, a fence, an external URL, the unused second definition.
  for (const kept of ["[broken](docs/missing.md)", "`[code](docs/target.md)`", "[fenced](docs/target.md)", "https://example.com/docs/target.md", "[ref]: docs/other.md"]) assert.ok(stay.includes(kept), kept);
  // HTML links and library image addresses, as their readers take them.
  const occurrences = markdownPathOccurrences(stay);
  const html = occurrences.find((occurrence) => occurrence.kind === "html-link")!;
  assert.equal(await opens("Nb/stay.md", html.value), layout.target);
  for (const image of occurrences.filter((occurrence) => (occurrence.kind === "image" || occurrence.kind === "html-image") && occurrence.value.startsWith("/api/files/raw/"))) assert.equal(rawFileSourcePath(image.value), layout.fig);
  if (chartFollows) assert.equal(resolveDeckRelativePath("Nb/stay.md", occurrences.find((occurrence) => occurrence.kind === "chart")!.value), layout.data);
  // The moved note's own links still reach the files that stayed, or moved with it.
  assert.equal(await opensLabel(layout.target, "up"), "Nb/stay.md");
  assert.equal(await opensLabel(layout.target, "sibling"), layout.other);
  assert.equal(await opensLabel(layout.target, "self"), layout.target);
  assert.equal(await opensLabel(layout.target, "rooted"), "Nb/stay.md");
  const moved = markdownPathOccurrences(await read(layout.target));
  assert.equal(resolveDeckRelativePath(layout.target, moved.find((occurrence) => occurrence.kind === "chart")!.value), layout.data);
  assert.equal(rawFileSourcePath(moved.find((occurrence) => occurrence.kind === "image" && occurrence.value.startsWith("/api/files/raw/"))!.value), layout.fig);
  // Another notebook's links into the moved file, by library path and relative.
  assert.equal(await opensLabel("Other/x.md", "cross"), layout.target);
  assert.equal(await opensLabel("Other/x.md", "relcross"), layout.target);
}

const fileMoved = (target: string): Layout => ({ ...folderMoved("Nb/docs"), target });
const folderMoved = (folder: string): Layout => ({ target: `${folder}/target.md`, other: `${folder}/other.md`, spaced: `${folder}/my note.md`, data: `${folder}/data.csv`, fig: `${folder}/fig.png`, paper: `${folder}/paper.pdf`, memo: `${folder}/memo.m4a` });

test("Move… (and drag and drop) of a note: links to it, and its own, keep their files", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const { upload } = await seed();
  await folder("Nb/elsewhere");
  const moved = await moveFileToDirectory("Nb/docs/target.md", "Nb/elsewhere");
  assert.equal(moved.file.path, "Nb/elsewhere/target.md");
  // Its own upload is read from the notebook's `_assets`: as written.
  assert.ok((await read("Nb/elsewhere/target.md")).includes(upload.markdown));
  // The payload carries the moved note's text as it is now, and every rewrite.
  assert.equal(moved.content, await read("Nb/elsewhere/target.md"));
  assert.deepEqual(moved.links?.rewritten.map((note) => note.path).sort(), ["Nb/elsewhere/target.md", "Nb/stay.md", "Other/x.md"]);
  assert.deepEqual(moved.links?.skipped, []);
  assert.equal(moved.unfinished, undefined);
  await assertFollowed(fileMoved("Nb/elsewhere/target.md"));
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
}));

test("rename of a note to a name with a space: links are percent-encoded where they need it", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seed();
  const moved = await moveFile("Nb/docs/target.md", "Nb", "renamed target.md");
  assert.equal(moved.file.path, "Nb/docs/renamed target.md");
  assert.equal(await hrefOf("Nb/stay.md", "inline"), "docs/renamed%20target.md");
  await assertFollowed(fileMoved("Nb/docs/renamed target.md"));
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
}));

test("Archive File: the archived note is still what its links open", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seed();
  const archived = await archiveFile("Nb/docs/target.md");
  assert.equal(archived.file.path, "Nb/_archive/target.md");
  await assertFollowed(fileMoved("Nb/_archive/target.md"));
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
}));

test("folder rename: links into the folder follow, links between its notes stay", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const { target } = await seed();
  const tree = await renameFolder("Nb/docs", "papers");
  assert.ok(tree.links?.rewritten.some((note) => note.path === "Nb/stay.md"));
  // Inside the folder, only the library address changed: same depth, same neighbours.
  assert.equal(await read("Nb/papers/target.md"), target.replace("/api/files/raw/Nb/docs/fig.png", "/api/files/raw/Nb/papers/fig.png"));
  await assertFollowed(folderMoved("Nb/papers"));
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
}));

test("Archive Folder: the archive is one level deeper, and links out of it follow", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seed();
  const tree = await archiveFolder("Nb/docs");
  assert.equal(tree.moved?.to, "Nb/_archive/docs");
  assert.equal(await hrefOf("Nb/_archive/docs/target.md", "up"), "../../stay.md");
  await assertFollowed(folderMoved("Nb/_archive/docs"));
  await assertNotebookSound("Nb", { allow: [BROKEN] });
  await assertNotebookSound("Other");
}));

test("migration of the folder to another notebook: links follow it there; a chart can't, and says so", () => withTemporaryLibrary(["Nb", "Other", "Dst"], async () => {
  await seed();
  const request: MigrationRequest = { source: "Nb", paths: ["Nb/docs"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  const result = await runMigration(request, plan.token);
  assert.equal(result.state, "done", JSON.stringify(result));
  assert.deepEqual(result.missing, []);
  // The chart of a note that stays reads its data from its own notebook only: reported, not rewritten.
  assert.deepEqual(result.links?.skipped.map((skip) => [skip.path, skip.written, skip.reason]), [["Nb/stay.md", "docs/data.csv", "chart-notebook"]]);
  assert.ok(result.links?.rewritten.some((note) => note.path === "Dst/docs/target.md"));
  await assertFollowed(folderMoved("Dst/docs"), { root: "Dst/", chartFollows: false });
  await assertNotebookSound("Nb", { allow: [BROKEN, 'reads its data from "docs/data.csv"'] });
  await assertNotebookSound("Dst");
  await assertNotebookSound("Other");
}));

test("a selection moved one file at a time: each move is right on its own, and links between them end right", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seed();
  await folder("Nb/b");
  await moveFileToDirectory("Nb/docs/target.md", "Nb/b");
  assert.equal(await hrefOf("Nb/b/target.md", "sibling"), "../docs/other.md");
  await moveFileToDirectory("Nb/docs/other.md", "Nb/b");
  assert.equal(await hrefOf("Nb/b/target.md", "sibling"), "other.md");
  await assertNotebookSound("Nb", { allow: [BROKEN] });
}));

test("a same-named file beside the new place is not picked up; a link that found nothing stays as written", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/index.md", "[Chapter](chapter.md) and [Gone](missing.md) and [Same](same.md)\n");
  await writeLibraryFile("Nb/chapter.md", "# Outer chapter\n");
  await writeLibraryFile("Nb/same.md", "# Same\n");
  await writeLibraryFile("Nb/sub/chapter.md", "# Inner chapter\n");
  await writeLibraryFile("Nb/sub/same.md", "# Same\n");
  const moved = await moveFileToDirectory("Nb/index.md", "Nb/sub");
  assert.equal(await read("Nb/sub/index.md"), "[Chapter](../chapter.md) and [Gone](missing.md) and [Same](../same.md)\n");
  assert.equal(moved.content, await read("Nb/sub/index.md"));
  await assertNotebookSound("Nb", { allow: ['"missing.md" finds no file'] });
}));

test("a file arriving where a library path's relative reading would find it: the link keeps its file", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/n.md", "[x](Nb/b/x.md)\n");
  await writeLibraryFile("Nb/b/x.md", "# The one\n");
  await writeLibraryFile("Nb/c/x.md", "# Another\n");
  await writeLibraryFile("Nb/a/Nb/b/keep.md", "# Keeps the folder\n");
  assert.equal(await opens("Nb/a/n.md", "Nb/b/x.md"), "Nb/b/x.md");
  // Nb/c/x.md arrives at Nb/a/Nb/b/x.md, the place the resolver tries first for that link.
  await moveFileToDirectory("Nb/c/x.md", "Nb/a/Nb/b");
  assert.equal(await opensLabel("Nb/a/n.md", "x"), "Nb/b/x.md");
  await assertNotebookSound("Nb");
}));

test("a note that stays and is saved while the move runs is read again and rewritten, never overwritten", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seed();
  await folder("Nb/b");
  const saved = `${STAY}\n[added while moving](docs/target.md)\n`;
  const original = fsp.readFile;
  let raced = false;
  // The rewrite reads each note under its lock (one argument: the bytes): the first read of stay.md finds a save that landed after planning.
  mock.method(fsp, "readFile", async (...args: Parameters<typeof fsp.readFile>) => {
    if (!raced && args.length === 1 && String(args[0]) === disk("Nb/stay.md")) {
      raced = true;
      await writeFile(disk("Nb/stay.md"), saved);
    }
    return original(...args);
  });
  try { await moveFileToDirectory("Nb/docs/target.md", "Nb/b"); }
  finally { mock.restoreAll(); }
  assert.ok(raced, "the save landed between planning and writing");
  const text = await read("Nb/stay.md");
  assert.equal(await opensLabel("Nb/stay.md", "added while moving"), "Nb/b/target.md");
  assert.equal(await opensLabel("Nb/stay.md", "inline"), "Nb/b/target.md");
  assert.ok(text.includes("[added while moving]"), "the save is kept");
  await assertNotebookSound("Nb", { allow: [BROKEN] });
}));

test("a migration interrupted once its link rewrites are journaled finishes the same rewrites on resume", () => withTemporaryLibrary(["Nb", "Other", "Dst"], async () => {
  await seed();
  const request: MigrationRequest = { source: "Nb", paths: ["Nb/docs/target.md", "Nb/docs/other.md", "Nb/docs/data.csv"], destination: { notebook: "Dst", flat: true } };
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  setMigrationFaultForTests((point) => { if (point === "links:planned") throw Object.assign(new Error("simulated crash"), { crash: true }); });
  try { await assert.rejects(runMigration(request, plan.token), /simulated crash/); }
  finally { setMigrationFaultForTests(null); }
  const [interrupted] = await listInterruptedMigrations();
  assert.ok(interrupted, "the migration is left interrupted");
  // Planned, not written yet: the note that stays still names the old place.
  assert.equal(await hrefOf("Nb/stay.md", "inline"), "docs/target.md");
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done", JSON.stringify(resumed));
  assert.deepEqual(resumed.missing, []);
  assert.equal(await opensLabel("Nb/stay.md", "inline"), "Dst/target.md");
  assert.equal(await opensLabel("Other/x.md", "cross"), "Dst/target.md");
  assert.equal(await opensLabel("Dst/target.md", "up"), "Nb/stay.md");
  assert.equal(await opensLabel("Dst/target.md", "sibling"), "Dst/other.md");
  assert.equal(resolveDeckRelativePath("Dst/target.md", markdownPathOccurrences(await read("Dst/target.md")).find((occurrence) => occurrence.kind === "chart")!.value), "Dst/data.csv");
  await assertNotebookSound("Nb", { allow: [BROKEN, 'reads its data from "docs/data.csv"'] });
  await assertNotebookSound("Dst");
  await assertNotebookSound("Other");
}));

test("a pending agent review, review comments and undo history of a note that stays get the same rewrite", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/docs/target.md", "# Target\n");
  await folder("Nb/b");
  const before = "Intro [t](docs/target.md) and more.\n";
  const after = `${before}\nAgent line.\n`;
  // An agent run edited the note: a pending review of `before`, and its undo history.
  await writeLibraryFile("Nb/stay.md", before);
  const snapshots = new RunSnapshots("run-links-0001");
  await snapshots.recordOriginal("Nb/stay.md", before);
  await withReviewWrite("Nb/stay.md", before, "run-links-0001", async () => { await writeLibraryFile("Nb/stay.md", after); });
  await snapshots.recordWritten("Nb/stay.md", after);
  // A comment on "and more", after the link.
  const start = after.indexOf("and more");
  await addReviewThreads("Nb/stay.md", after, [{ range: { start, end: start + "and more".length }, text: "Say more" }]);

  await moveFileToDirectory("Nb/docs/target.md", "Nb/b");
  const now = await read("Nb/stay.md");
  assert.equal(now, after.replace("docs/target.md", "b/target.md"));
  const [pending] = await listPendingReviews();
  assert.equal(pending.baseline, before.replace("docs/target.md", "b/target.md"), "the review shows only the agent's change, not the move's");
  const review = await findReview("Nb/stay.md");
  assert.equal(review?.snapshot, now);
  const thread = review!.threads[0];
  assert.equal(now.slice(thread.anchor.start, thread.anchor.end), "and more");
  assert.equal(thread.anchor.state, "attached");
  await assertNotebookSound("Nb");
  // Undo takes the note back to before the run, with the link that follows the move.
  const [result] = await undoRun("run-links-0001");
  assert.equal(result.status, "restored");
  assert.equal(await read("Nb/stay.md"), before.replace("docs/target.md", "b/target.md"));
  await assertNotebookSound("Nb");
}));

test("LaTeX: moving the main file rewrites its includes, figures and bibliography, and the chapters' paths read from it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper/main.tex", "\\documentclass{article}\n\\addbibresource{more.bib}\n\\begin{document}\n\\input{chapters/intro}\n\\includegraphics[width=2in]{figs/plot}\n\\includepdf[pages=-]{extra/appendix}\n% \\input{commented/out}\n\\bibliography{refs}\n\\end{document}\n");
  await writeLibraryFile("Nb/paper/chapters/intro.tex", "Intro \\includegraphics*{figs/plot.png} and \\lstinputlisting{code/a.py}\n");
  await writeLibraryFile("Nb/paper/figs/plot.png", Buffer.from("png"));
  await writeLibraryFile("Nb/paper/extra/appendix.pdf", "%PDF-1.4 x");
  await writeLibraryFile("Nb/paper/code/a.py", "print(1)\n");
  await writeLibraryFile("Nb/paper/refs.bib", "@article{a, title={A}}\n");
  await writeLibraryFile("Nb/paper/more.bib", "@article{b, title={B}}\n");
  await assertNotebookSound("Nb");
  await moveFileToDirectory("Nb/paper/main.tex", "Nb");
  const main = await read("Nb/main.tex");
  assert.match(main, /\\input\{paper\/chapters\/intro\}/);
  assert.match(main, /\\includegraphics\[width=2in\]\{paper\/figs\/plot\}/, "the extension TeX adds stays left out");
  assert.match(main, /\\includepdf\[pages=-\]\{paper\/extra\/appendix\}/);
  assert.match(main, /\\addbibresource\{paper\/more\.bib\}/);
  assert.match(main, /\\bibliography\{paper\/refs\}/);
  assert.match(main, /% \\input\{commented\/out\}/, "comments are left as they are");
  const intro = await read("Nb/paper/chapters/intro.tex");
  assert.match(intro, /\\includegraphics\*\{paper\/figs\/plot\.png\}/);
  assert.match(intro, /\\lstinputlisting\{paper\/code\/a\.py\}/);
  await assertNotebookSound("Nb");
}));

test("LaTeX: renaming a figures folder rewrites the figures it holds", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\includegraphics{figs/plot}\n\\end{document}\n");
  await writeLibraryFile("Nb/paper/figs/plot.pdf", Buffer.from("%PDF"));
  await renameFolder("Nb/paper/figs", "images");
  assert.match(await read("Nb/paper/main.tex"), /\\includegraphics\{images\/plot\}/);
  assert.deepEqual(latexPathOccurrences(await read("Nb/paper/main.tex")).map((occurrence) => occurrence.written), ["images/plot"]);
  await assertNotebookSound("Nb");
}));

test("the app's rewrite of an open note with unsaved edits: draft and baseline both, and the baseline is the disk's text", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const { target } = await seed();
  await folder("Nb/b");
  // The tab had saved stay.md as it was, and has typed more since (a new link to the same file among it).
  const baseline = await read("Nb/stay.md");
  const draft = `${baseline}\nTyped, with [another](docs/target.md) and [one more](docs/my%20note.md).\n`;
  const moved = await moveFileToDirectory("Nb/docs/target.md", "Nb/b");
  const rewrite = linkRewriteByPath(moved.links)!;
  const next = rewriteOpenText({ saved: baseline, draft, conflict: undefined }, (text) => rewrite("Nb/stay.md", text));
  // The baseline is now exactly the disk's text: a save meets no conflict.
  assert.equal(next.saved, await read("Nb/stay.md"));
  assert.equal(textVersion(next.saved), textVersion(await read("Nb/stay.md")));
  // The draft keeps what was typed, with the same rewrite (a destination the saved text had is rewritten in it too).
  assert.equal(next.draft, `${next.saved}\nTyped, with [another](b/target.md) and [one more](docs/my%20note.md).\n`);
  // The same pure function, applied to the moved note's own text, gives the server's text.
  assert.equal(rewriteMovedPaths(target, "Nb/b/target.md", moved.links!.rewritten.find((note) => note.path === "Nb/b/target.md")!.rewrite), await read("Nb/b/target.md"));
  // Nothing else is touched: a file with no rewrite comes back as it was.
  const unrelated: LiberaLinkRewrites = { rewritten: [], skipped: [], unchecked: [] };
  assert.equal(linkRewriteByPath(unrelated), undefined);
}));
