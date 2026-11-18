import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTemporaryLibrary, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";
import { markdownImageTargets, writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { planMigration, runMigration, type MigrationPlan, type MigrationRequest } from "../../src/lib/storage/migration";
import { notebookPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst", "Third"], run);
const warning = (plan: MigrationPlan, kind: string) => plan.warnings.find((item) => item.kind === kind);
const diskPath = (library: string) => { const [notebook, ...parts] = library.split("/"); return path.join(notebookPath(notebook), ...parts); };

async function migrate(request: MigrationRequest) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  return { plan, result: await runMigration(request, plan.token) };
}

test("a vacant destination holding old tags and an attachment is not taken over", () => withLibrary(async () => {
  await writeLibraryFile("Src/a.pdf", "%PDF-1.4 new");
  await setFileTagsForPath("Dst/a.pdf", ["old-tag"]);
  await writeReferenceLibrary("Dst", [{ key: "old", attachments: ["Dst/a.pdf"] }]);
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } };
  const { plan } = await migrate(request);
  assert.notEqual(plan.items[0].to, "Dst/a.pdf");
  assert.equal(plan.items[0].renamed, true);
  assert.deepEqual(warning(plan, "renamed-records")?.paths, [`Src/a.pdf → ${plan.items[0].to}`]);
  assert.equal(warning(plan, "renamed"), undefined);
  assert.equal(await readFile(diskPath(plan.items[0].to), "utf8"), "%PDF-1.4 new");
  assert.equal(existsSync(diskPath("Dst/a.pdf")), false);
  const metadata = await readWorkspaceMetadata();
  assert.deepEqual(metadata.fileTags["Dst/a.pdf"], ["old-tag"]);
  assert.equal(metadata.fileTags[plan.items[0].to], undefined);
  const library = await readReferenceLibrary("Dst");
  assert.deepEqual(Object.values(library.entries).flatMap((entry) => entry.attachments.map((attachment) => attachment.kind === "url" ? "" : attachment.path)), ["Dst/a.pdf"]);
}));

test("leftover records are also found where the destination notebook is being created", () => withLibrary(async () => {
  await writeLibraryFile("Src/a.pdf", "%PDF-1.4 new");
  await setFileTagsForPath("Fresh/a.pdf", ["old-tag"]);
  const plan = await planMigration({ source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Fresh", create: {} } });
  assert.equal(plan.items[0].to, "Fresh/a-1.pdf");
  assert.ok(warning(plan, "renamed-records"));
}));

test("an image embedded by another notebook is kept, and warned about while it is moving", () => withLibrary(async () => {
  await writeLibraryFile("Src/notes/n.md", "# Note\n");
  const upload = await writeMarkdownImageAsset("Src/notes/n.md", new File(["photo-bytes"], "photo.png"));
  const content = `# Note\n\n${upload.markdown}\n`;
  await writeLibraryFile("Src/notes/n.md", content);
  const original = markdownImageTargets("Src/notes/n.md", content)[0];
  assert.ok(original.libraryPath && existsSync(diskPath(original.libraryPath)));
  await writeLibraryFile("Third/t.md", `![](/api/files/raw/${original.libraryPath})\n`);
  await migrate({ source: "Src", paths: ["Src/notes/n.md"], destination: { notebook: "Dst" } });
  assert.ok(existsSync(diskPath(original.libraryPath)), "the third notebook's image survived");
}));

test("without another embed the moved note's original image is removed", () => withLibrary(async () => {
  await writeLibraryFile("Src/notes/n.md", "# Note\n");
  const upload = await writeMarkdownImageAsset("Src/notes/n.md", new File(["photo-bytes"], "photo.png"));
  const content = `# Note\n\n${upload.markdown}\n`;
  await writeLibraryFile("Src/notes/n.md", content);
  const original = markdownImageTargets("Src/notes/n.md", content)[0];
  await migrate({ source: "Src", paths: ["Src/notes/n.md"], destination: { notebook: "Dst" } });
  assert.equal(existsSync(diskPath(original.libraryPath!)), false);
}));

test("notes of other notebooks showing a moving image are in the review", () => withLibrary(async () => {
  await writeLibraryFile("Src/papers/fig.png", Buffer.from("png"));
  await writeLibraryFile("Third/t.md", "![](/api/files/raw/Src/papers/fig.png)\n");
  const plan = await planMigration({ source: "Src", paths: ["Src/papers/fig.png"], destination: { notebook: "Dst" } });
  assert.deepEqual(warning(plan, "inbound-images")?.paths, ["Third/t.md"]);
}));

test("LaTeX: a renamed chapter, shadowed by one the destination has, is reported", () => withLibrary(async () => {
  await writeLibraryFile("Src/main.tex", "\\documentclass{article}\n\\begin{document}\\input{chapter}\\end{document}\n");
  await writeLibraryFile("Src/chapter.tex", "new chapter");
  await writeLibraryFile("Dst/chapter.tex", "old chapter");
  const plan = await planMigration({ source: "Src", paths: ["Src/main.tex", "Src/chapter.tex"], destination: { notebook: "Dst" } });
  assert.equal(plan.items.find((item) => item.from === "Src/chapter.tex")?.to, "Dst/chapter-1.tex");
  assert.deepEqual(warning(plan, "latex-shadowed")?.paths, ["Src/main.tex: chapter.tex"]);
}));

test("LaTeX: a project moving into a clean destination has no shadowing", () => withLibrary(async () => {
  await writeLibraryFile("Src/main.tex", "\\documentclass{article}\n\\begin{document}\\input{chapter}\\end{document}\n");
  await writeLibraryFile("Src/chapter.tex", "new chapter");
  const plan = await planMigration({ source: "Src", paths: ["Src/main.tex", "Src/chapter.tex"], destination: { notebook: "Dst" } });
  assert.equal(warning(plan, "latex-shadowed"), undefined);
}));

test("links and chart data are read from the notes, not from a stale index", () => withLibrary(async () => {
  await writeLibraryFile("Src/data.csv", "a,b\n1,2\n");
  await writeLibraryFile("Src/other.md", "other");
  await writeLibraryFile("Src/chart.md", "```chart\ntype: bar\ndata: data.csv\n```\n");
  await writeLibraryFile("Third/link.md", "[other](Src/other.md)\n");
  const plan = await planMigration({ source: "Src", paths: ["Src/data.csv", "Src/other.md"], destination: { notebook: "Dst" } });
  assert.deepEqual(warning(plan, "inbound-links")?.paths, ["Src/chart.md", "Third/link.md"]);
}));

test("a moving note whose chart data stays behind is reported", () => withLibrary(async () => {
  await writeLibraryFile("Src/data.csv", "a,b\n1,2\n");
  await writeLibraryFile("Src/chart.md", "```chart\ntype: bar\ndata: data.csv\n```\n");
  const plan = await planMigration({ source: "Src", paths: ["Src/chart.md"], destination: { notebook: "Dst" } });
  assert.deepEqual(warning(plan, "outbound-links")?.paths, ["Src/chart.md"]);
}));

test("LaTeX citations that the destination library lacks are reported", () => withLibrary(async () => {
  await writeReferenceLibrary("Src", [{ key: "smith2020", attachments: [] }, { key: "known", attachments: [] }]);
  await writeReferenceLibrary("Dst", [{ key: "known", attachments: [] }]);
  await writeLibraryFile("Src/paper.tex", "\\documentclass{article}\n\\begin{document}\\cite{smith2020,known,nobody}\\end{document}\n");
  const plan = await planMigration({ source: "Src", paths: ["Src/paper.tex"], destination: { notebook: "Dst" } });
  assert.deepEqual(warning(plan, "latex-citations")?.paths, ["Src/paper.tex: smith2020"]);
}));
