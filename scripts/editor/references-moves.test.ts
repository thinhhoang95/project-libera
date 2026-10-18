import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as rewriteRoute } from "../../src/app/api/references/rewrite/route";
import { PATCH as filesRoute } from "../../src/app/api/files/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { copyReferencesOnMove, markdownFilesUnder, planReferenceCopy, type ReferenceMoveResult } from "../../src/lib/references/moves";
import { REWRITE_SKIP_REASONS } from "../../src/lib/references/rewrite";
import type { CslItem, ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";
import { moveFile, moveFileToDirectory } from "../../src/lib/storage/files";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath, notebookSystemDirectoryPath, referenceLibraryPath } from "../../src/lib/storage/paths";
import { refreshNotebookCitations } from "../../src/lib/storage/reference-citations";
import { pendingReferenceReattach, readReferenceLibrary, resetReferenceReattachSchedule, updateReferenceLibrary } from "../../src/lib/storage/references";

const NOW = "2024-01-01T00:00:00.000Z";
const SEARCH = Symbol.for("libera.searchIndexer");
const searchStore = globalThis as { [SEARCH]?: { notifyChanges(paths?: string[]): void } };

async function withData(run: () => Promise<void>) {
  await pendingReferenceReattach();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-references-moves-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  try {
    await mkdir(path.join(scratch, "data", "users", "admin"), { recursive: true });
    await run();
  } finally {
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    delete searchStore[SEARCH];
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Collect the paths storage reports to the search indexer. */
function watchSearch() {
  const notified: string[] = [];
  searchStore[SEARCH] = { notifyChanges: (paths) => notified.push(...paths ?? []) };
  return notified;
}

function entry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl }, identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

const article = (family: string, year: number, title: string, extra: Partial<CslItem> = {}): Partial<CslItem> =>
  ({ author: [{ family, given: "A." }], issued: { "date-parts": [[year]] }, title, ...extra });

async function put(notebook: string, entries: ReferenceEntry[]) {
  return updateReferenceLibrary(notebook, null, entries.map((value) => ({ op: "put" as const, entry: value })));
}

async function writeNote(relativePath: string, text: string) {
  const [notebook, ...parts] = relativePath.split("/");
  const target = path.join(notebookPath(notebook), ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function readNote(relativePath: string) {
  const [notebook, ...parts] = relativePath.split("/");
  return readFile(path.join(notebookPath(notebook), ...parts), "utf8");
}

const byKey = (library: ReferenceLibrary, key: string) => Object.values(library.entries).find((value) => value.key === key);

/** The source and destination libraries every copy-on-move test starts from. */
async function seedLibraries() {
  await createNotebook("Source");
  await createNotebook("Dest");
  await put("Source", [
    entry("s-smith", "smith2020", article("Smith", 2020, "Sparse coding at scale"), { identifiers: { doi: "10.1000/sparse" } }),
    entry("s-jones", "jones2019", article("Jones", 2019, "A theory of everything else"), { attachments: [{ kind: "markdown", path: "Source/paper.md", sha256: "0".repeat(64), size: 1 }, { kind: "pdf", path: "Source/jones.pdf", sha256: "1".repeat(64), size: 1 }] }),
    entry("s-lee", "lee2018", article("Lee", 2018, "Graph methods for proteins")),
    entry("s-brown", "brown2021", article("Brown", 2021, "Deep learning for cat recognition in the wild")),
    entry("s-kim", "kim2022", article("Kim", 2022, "Quantum gardens"), { aliases: ["kimold"] }),
  ]);
  await put("Dest", [
    entry("d-smith", "smithX", article("Smith", 2020, "Sparse coding at scale (preprint title)"), { identifiers: { doi: "10.1000/sparse" } }),
    entry("d-lee", "lee2018", article("Leeway", 2018, "Cooking with seaweed")),
    entry("d-brown", "brownDL", article("Brown", 2021, "Deep Learning for Cat Recognition in the Wild")),
  ]);
}

const PAPER = [
  "# Paper",
  "",
  "See [@smith2020], [@jones2019; @lee2018], [@brown2021, p. 3], [@ghost] and [@kimold].",
  "",
  "Code `[@lee2018]` is not a citation.",
  "",
].join("\n");

test("moving a document to another notebook reuses, copies and renames the entries it cites", async () => {
  await withData(async () => {
    await seedLibraries();
    await writeNote("Source/paper.md", PAPER);
    const notified = watchSearch();

    const payload = await moveFile("Source/paper.md", "Dest", "paper.md") as Awaited<ReturnType<typeof moveFile>> & { references?: ReferenceMoveResult };
    assert.equal(payload.file.path, "Dest/paper.md");
    const references = payload.references!;
    assert.equal(references.error, undefined);

    const dest = await readReferenceLibrary("Dest");
    const leeCopy = Object.values(dest.entries).find((value) => value.csl.title === "Graph methods for proteins")!;
    assert.ok(leeCopy, "the work whose key is taken is copied");
    assert.notEqual(leeCopy.key, "lee2018");
    assert.match(leeCopy.key, /^lee2018/);
    assert.notEqual(leeCopy.id, "s-lee");

    // Identifier match (DOI) and fuzzy ≥ 0.95 are reused under the destination's keys.
    assert.deepEqual(references.reused, [
      { key: "smith2020", destinationKey: "smithX" },
      { key: "brown2021", destinationKey: "brownDL" },
    ]);
    assert.deepEqual(references.copied.map((item) => item.key).sort(), ["jones2019", "kim2022", leeCopy.key].sort());
    for (const { key, entryId } of references.copied) assert.equal(dest.entries[entryId]?.key, key);
    assert.equal(references.destinationRevision, dest.revision);

    const map = { smith2020: "smithX", lee2018: leeCopy.key, brown2021: "brownDL" };
    assert.deepEqual(
      Object.fromEntries(references.renamed.map(({ from, to, files }) => [from, { to, files }])),
      Object.fromEntries(Object.entries(map).map(([from, to]) => [from, { to, files: ["Dest/paper.md"] }])),
    );
    assert.deepEqual(references.drafts, [{ path: "Dest/paper.md", map }]);

    // The file on disk and the returned content are rewritten; unresolved keys, aliases kept by the copy and code are untouched.
    const expected = PAPER
      .replace("[@smith2020]", "[@smithX]")
      .replace("@lee2018]", `@${leeCopy.key}]`)
      .replace("[@brown2021, p. 3]", "[@brownDL, p. 3]");
    assert.equal(await readNote("Dest/paper.md"), expected);
    assert.equal(payload.content, expected);
    assert.match(expected, /\[@ghost\]/);
    assert.match(expected, /`\[@lee2018\]`/);
    assert.ok(notified.includes("Dest/paper.md"));

    // A free key and the aliases free in the destination are kept; the citation of the alias still resolves.
    const kim = byKey(dest, "kim2022")!;
    assert.deepEqual(kim.aliases, ["kimold"]);
    assert.ok(!references.renamed.some((item) => item.from === "kimold"));

    // Attachments keep their library-relative paths, and the moved document's own path was remapped first.
    const jones = byKey(dest, "jones2019")!;
    assert.deepEqual(jones.attachments.map((value) => value.kind === "url" ? value.url : value.path), ["Dest/paper.md", "Source/jones.pdf"]);
    // Nothing is added to the destination's existing entries.
    assert.deepEqual(dest.entries["d-smith"].aliases, []);
    assert.deepEqual(dest.entries["d-brown"].aliases, []);
    assert.equal(Object.keys(dest.entries).length, 6);

    // The citation index sees the rewritten file.
    const index = await refreshNotebookCitations("Dest");
    assert.deepEqual(index.byFile["Dest/paper.md"], ["smithX", "jones2019", leeCopy.key, "brownDL", "ghost", "kimold"]);
  });
});

test("moves into a folder of another notebook reuse what was copied before, and same-notebook moves add nothing", async () => {
  await withData(async () => {
    await seedLibraries();
    await writeNote("Source/a.md", "First [@jones2019].");
    await writeNote("Source/b.md", "Again [@jones2019] and [@unknownkey].");
    await mkdir(path.join(notebookPath("Dest"), "drafts"), { recursive: true });

    const first = await moveFileToDirectory("Source/a.md", "Dest/drafts") as { references?: ReferenceMoveResult };
    assert.deepEqual(first.references!.copied.map((item) => item.key), ["jones2019"]);
    const revision = (await readReferenceLibrary("Dest")).revision;

    const second = await moveFileToDirectory("Source/b.md", "Dest") as { references?: ReferenceMoveResult; content?: string };
    assert.deepEqual(second.references, { copied: [], reused: [{ key: "jones2019", destinationKey: "jones2019" }], renamed: [], drafts: [], destinationRevision: null });
    assert.equal(second.content, "Again [@jones2019] and [@unknownkey].");
    assert.equal((await readReferenceLibrary("Dest")).revision, revision);

    await writeNote("Dest/c.md", "[@jones2019]");
    const local = await moveFileToDirectory("Dest/c.md", "Dest/drafts") as { references?: unknown };
    assert.equal(local.references, undefined);
    const renamed = await moveFile("Dest/drafts/c.md", "Dest", "d.md") as { references?: unknown };
    assert.equal(renamed.references, undefined);
  });
});

test("the files route returns the references result with the moved file", async () => {
  await withData(async () => {
    await seedLibraries();
    await writeNote("Source/paper.md", "Cite [@lee2018].");
    const response = await filesRoute(new NextRequest("http://localhost/api/files", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
      body: JSON.stringify({ path: "Source/paper.md", destinationNotebook: "Dest", destinationName: "paper.md" }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { file: { path: string }; content: string; references: ReferenceMoveResult };
    assert.equal(body.file.path, "Dest/paper.md");
    const [{ key }] = body.references.copied;
    assert.deepEqual(body.references.drafts, [{ path: "Dest/paper.md", map: { lee2018: key } }]);
    assert.equal(body.content, `Cite [@${key}].`);
  });
});

test("a failure while copying references never fails the move", async () => {
  await withData(async () => {
    await seedLibraries();
    await createNotebook("Broken");
    await mkdir(path.dirname(referenceLibraryPath("Broken")), { recursive: true });
    // A library saved by a newer Libera cannot be written.
    await writeFile(referenceLibraryPath("Broken"), JSON.stringify({ version: 99, revision: 1, style: "apa", entries: {} }));
    await writeNote("Source/paper.md", PAPER);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let payload: { file: { path: string }; content?: string; references?: ReferenceMoveResult };
    try {
      payload = await moveFile("Source/paper.md", "Broken", "paper.md");
    } finally {
      console.error = originalError;
    }
    assert.equal(payload.file.path, "Broken/paper.md");
    assert.equal(payload.content, PAPER);
    assert.match(payload.references!.error!, /newer version of Libera/);
    assert.deepEqual(payload.references!.copied, []);
    // Logged (the attachment wiring logs its own failure on that library too).
    assert.ok(errors.some((args) => String((args as unknown[])[0]).includes("Could not copy the references")));
    assert.equal(await readNote("Broken/paper.md"), PAPER);
  });
});

test("a folder's Markdown files are handled together, and the copy plan is pure", async () => {
  await withData(async () => {
    await seedLibraries();
    await writeNote("Dest/moved/one.md", "[@lee2018]");
    await writeNote("Dest/moved/deep/two.md", "[@lee2018] [@smith2020]");
    await writeNote("Dest/moved/image.png", "not markdown");
    const files = await markdownFilesUnder("Dest/moved");
    assert.deepEqual(files, ["Dest/moved/deep/two.md", "Dest/moved/one.md"]);
    const result = await copyReferencesOnMove("Source", "Dest", files.map((to) => ({ from: to.replace("Dest/", "Source/"), to })));
    const [{ key }] = result.copied;
    assert.deepEqual(result.renamed.find((item) => item.from === "lee2018"), { from: "lee2018", to: key, files: files });
    assert.equal(await readNote("Dest/moved/one.md"), `[@${key}]`);
    assert.equal(await readNote("Dest/moved/deep/two.md"), `[@${key}] [@smithX]`);
    assert.equal(result.drafts.length, 2);

    const source = await readReferenceLibrary("Source");
    const before = structuredClone(source);
    let ids = 0;
    const plan = planReferenceCopy(source, { version: 1, revision: 0, style: "apa", entries: { x: entry("x", "Kimold", article("Other", 1999, "Unrelated")) } }, ["kim2022", "kimold", "ghost"], { now: NOW, newId: () => `new-${ids++}` });
    // The alias is taken (case-insensitively) in the destination, so its citations move to the copy's key.
    assert.deepEqual(plan.copied, [{ key: "kim2022", entryId: "new-0" }]);
    assert.deepEqual([...plan.keyMap], [["kimold", "kim2022"]]);
    assert.deepEqual(plan.ops, [{ op: "put", entry: { ...source.entries["s-kim"], id: "new-0", aliases: [], updatedAt: NOW } }]);
    assert.deepEqual(source, before);
  });
});

// ---------------------------------------------------------------------------
// Key rename rewrite
// ---------------------------------------------------------------------------

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });

async function rewrite(body: unknown, authenticated = true) {
  const response = await rewriteRoute(new NextRequest("http://localhost/api/references/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authenticated ? cookie() : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("the rewrite route previews with drafts, applies with a stale check, returns draft edits and undoes", async () => {
  await withData(async () => {
    await createNotebook("R");
    await put("R", [entry("r1", "oldkey", article("Old", 2000, "Old work")), entry("r2", "other", article("Other", 2001, "Other work"))]);
    await updateReferenceLibrary("R", null, [{ op: "rename-key", id: "r1", key: "newkey" }]);
    await writeNote("R/a.md", "Intro [@oldkey].\n\nMore [see @oldkey, p. 2; @other].\n`[@oldkey]`\n");
    await writeNote("R/b.md", "Saved [@oldkey].\n");
    await writeNote("R/c.md", "No citations of it [@other].\n");
    await writeNote("R/_archive/old.md", "Archived [@oldkey].\n");
    const drafts = { "R/b.md": "Draft [@oldkey] and [@oldkey, p. 2].", "R/d.md": "Unsaved [@oldkey].", "Elsewhere/x.md": "[@oldkey]" };
    const map = { oldkey: "newkey" };

    assert.equal((await rewrite({ notebook: "R", map, dryRun: true }, false)).status, 401);
    for (const [body, pattern] of [
      [{ notebook: "R", map: { oldkey: "missing" }, dryRun: true }, /not a key or alias/],
      [{ notebook: "R", map: { "bad key": "newkey" }, dryRun: true }, /not a valid citation key/],
      [{ notebook: "R", map: { oldkey: "oldkey" }, dryRun: true }, /mapped to itself/],
      [{ notebook: "R", map: {}, dryRun: true }, /no key changes/],
      [{ notebook: "R", map }, /dryRun/],
      [{ notebook: "R", map, dryRun: false }, /Preview the rewrite first/],
      [{ notebook: "../R", map, dryRun: true }, /Notebook name/],
      ["{ nope", /not valid JSON/],
    ] as const) {
      const result = await rewrite(body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.match(result.body.error, pattern);
    }
    // The old key resolves as an alias, so the new key is valid as the alias's target; aliases are accepted as targets too.
    assert.equal((await rewrite({ notebook: "R", map: { other: "oldkey" }, dryRun: true })).status, 200);

    const preview = await rewrite({ notebook: "R", map, dryRun: true, drafts });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.files, [
      { path: "R/_archive/old.md", count: 1, excerpts: [{ line: 1, before: "Archived [@oldkey].", after: "Archived [@newkey]." }] },
      { path: "R/a.md", count: 2, excerpts: [
        { line: 1, before: "Intro [@oldkey].", after: "Intro [@newkey]." },
        { line: 3, before: "More [see @oldkey, p. 2; @other].", after: "More [see @newkey, p. 2; @other]." },
      ] },
      { path: "R/b.md", count: 2, excerpts: [{ line: 1, before: "Draft [@oldkey] and [@oldkey, p. 2].", after: "Draft [@newkey] and [@newkey, p. 2]." }] },
      { path: "R/d.md", count: 1, excerpts: [{ line: 1, before: "Unsaved [@oldkey].", after: "Unsaved [@newkey]." }] },
    ]);
    assert.deepEqual(Object.keys(preview.body.expected).sort(), ["R/_archive/old.md", "R/a.md", "R/b.md"]);
    // A dry run writes nothing.
    assert.equal(await readNote("R/a.md"), "Intro [@oldkey].\n\nMore [see @oldkey, p. 2; @other].\n`[@oldkey]`\n");

    // b.md changes after the preview; a file that starts citing the old key was not previewed.
    await writeNote("R/b.md", "Saved [@oldkey] edited.\n");
    await writeNote("R/e.md", "Late [@oldkey].\n");
    const notified = watchSearch();
    const applied = await rewrite({ notebook: "R", map, dryRun: false, expected: preview.body.expected, drafts });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body.changed, ["R/_archive/old.md", "R/a.md"]);
    assert.deepEqual(applied.body.skipped, [
      { path: "R/b.md", reason: REWRITE_SKIP_REASONS.changed },
      { path: "R/e.md", reason: REWRITE_SKIP_REASONS.notPreviewed },
    ]);
    assert.deepEqual(applied.body.draftEdits, { "R/b.md": "Draft [@newkey] and [@newkey, p. 2].", "R/d.md": "Unsaved [@newkey]." });
    assert.match(applied.body.rewriteId, /^rw-/);
    assert.equal(await readNote("R/a.md"), "Intro [@newkey].\n\nMore [see @newkey, p. 2; @other].\n`[@oldkey]`\n");
    assert.equal(await readNote("R/b.md"), "Saved [@oldkey] edited.\n");
    assert.deepEqual(notified.sort(), ["R/_archive/old.md", "R/a.md"]);

    // The citation index follows the rewrite.
    const index = await refreshNotebookCitations("R", { includeArchive: true });
    assert.deepEqual(index.byKey.newkey, ["R/_archive/old.md", "R/a.md"]);
    assert.deepEqual(index.byKey.oldkey, ["R/b.md", "R/e.md"]);

    // Undo restores the files that were not edited since.
    await writeNote("R/_archive/old.md", "Edited after the rewrite [@newkey].\n");
    const undone = await rewrite({ notebook: "R", undo: applied.body.rewriteId });
    assert.equal(undone.status, 200);
    assert.deepEqual(undone.body, { restored: ["R/a.md"], skipped: [{ path: "R/_archive/old.md", reason: REWRITE_SKIP_REASONS.changedSinceRewrite }] });
    assert.equal(await readNote("R/a.md"), "Intro [@oldkey].\n\nMore [see @oldkey, p. 2; @other].\n`[@oldkey]`\n");
    assert.deepEqual((await refreshNotebookCitations("R", { includeArchive: true })).byKey.newkey, ["R/_archive/old.md"]);
    assert.equal((await rewrite({ notebook: "R", undo: applied.body.rewriteId })).status, 409);
    assert.equal((await rewrite({ notebook: "R", undo: "../../x" })).status, 400);
    assert.equal((await rewrite({ notebook: "R", undo: "rw-0000000000000-000000000000" })).status, 404);

    // Nothing to change: no undo handle, no backup.
    const none = await rewrite({ notebook: "R", map: { nobody: "newkey" }, dryRun: false, expected: {} });
    assert.deepEqual(none.body, { rewriteId: null, changed: [], skipped: [], draftEdits: {} });
  });
});

test("rewrite backups keep the last 20", async () => {
  await withData(async () => {
    await createNotebook("R");
    await put("R", [entry("r1", "a", article("A", 2000, "A")), entry("r2", "b", article("B", 2000, "B"))]);
    await writeNote("R/n.md", "[@a]");
    let from = "a";
    for (let round = 0; round < 22; round += 1) {
      const to = from === "a" ? "b" : "a";
      const preview = await rewrite({ notebook: "R", map: { [from]: to }, dryRun: true });
      const applied = await rewrite({ notebook: "R", map: { [from]: to }, dryRun: false, expected: preview.body.expected });
      assert.deepEqual(applied.body.changed, ["R/n.md"]);
      from = to;
    }
    const backups = await readdir(path.join(notebookSystemDirectoryPath("R"), "references", "rewrites"));
    assert.equal(backups.filter((name) => name.endsWith(".json")).length, 20);
  });
});
