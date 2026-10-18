import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as importRoute } from "../../src/app/api/references/import/route";
import { POST as exportRoute } from "../../src/app/api/references/export/route";
import { GET as citationsRoute } from "../../src/app/api/references/citations/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { closeDirectory, getDirectoryModeSummary, openDirectory } from "../../src/lib/storage/directory-mode";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath, referenceLibraryPath } from "../../src/lib/storage/paths";
import { citationIndexPath, refreshNotebookCitations } from "../../src/lib/storage/reference-citations";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";
import { parseReferenceImport, referenceImportSummary, type ReferenceImportResult } from "../../src/lib/references/import";
import type { ReferenceLibrary } from "../../src/lib/references/types";

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });

function post(route: (request: NextRequest) => Promise<Response>, url: string, body: unknown, authenticated = true) {
  return route(new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authenticated ? cookie() : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}
const importReferences = (body: unknown, authenticated = true) => post(importRoute, "/api/references/import", body, authenticated);
const exportReferences = (body: unknown, authenticated = true) => post(exportRoute, "/api/references/export", body, authenticated);
function citations(query: string, authenticated = true) {
  return citationsRoute(new NextRequest(`http://localhost/api/references/citations?${query}`, { headers: authenticated ? cookie() : {} }));
}

async function imported(body: unknown) {
  const response = await importReferences(body);
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json as ReferenceImportResult;
}

async function withLibrary(run: (root: string, scratch: string) => Promise<void>) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-references-interop-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  try {
    await createNotebook("Notes");
    await run(notebookPath("Notes"), scratch);
  } finally {
    for (const folder of getDirectoryModeSummary().folders) closeDirectory(folder.name);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

const BIBTEX = String.raw`
@article{smith2020sparse,
  author = {Smith, Jane and Doe, John},
  title = {Sparse coding of natural images},
  journal = {Journal of Vision},
  year = {2020},
  doi = {10.1000/sparse}
}

@book{nodate,
  author = {Roe, Richard},
  title = {A book without a year}
}
`;

const RIS = [
  "TY  - JOUR", "ID  - lee2019deep", "AU  - Lee, Kim", "TI  - Deep nets for cells", "PY  - 2019", "JO  - Cell", "DO  - 10.1000/cells", "ER  - ",
  "", "TY  - BOOK", "TI  - Untitled authors", "PY  - 2001", "ER  - ", "",
].join("\r\n");

const CSL_JSON = JSON.stringify([
  { id: "park2018", type: "article-journal", title: "Graph methods", author: [{ family: "Park", given: "Min" }], issued: { "date-parts": [[2018]] } },
  { id: "org2017", type: "report", title: "Annual report", author: [{ literal: "World Health Organization" }], issued: { "date-parts": [[2017]] } },
]);

const MEDLINE = [
  "PMID- 31234567", "TI  - Effects of sleep on memory: a randomized", "      trial.", "FAU - Garcia, Ana", "AU  - Garcia A",
  "FAU - Chen, Wei", "AU  - Chen W", "DP  - 2019 Mar 4", "JT  - Sleep Medicine", "TA  - Sleep Med", "VI  - 12", "IP  - 3",
  "PG  - 100-110", "LID - 10.1000/sleep.2019 [doi]", "PT  - Journal Article", "",
].join("\n");

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

test("import parses each format and auto, normalizes entries and sets their status", async () => {
  await withLibrary(async () => {
    let result = await imported({ notebook: "Notes", format: "bibtex", text: BIBTEX });
    assert.equal(result.added.length, 2);
    assert.equal(result.library.revision, 1, "one transaction");
    const byKey = (library: ReferenceLibrary, key: string) => Object.values(library.entries).find((entry) => entry.key === key)!;
    const sparse = byKey(result.library, "smith2020sparse");
    assert.equal(sparse.status, "confirmed");
    assert.equal(sparse.identifiers.doi, "10.1000/sparse");
    assert.equal(sparse.provenance.title?.source, "import");
    assert.equal(byKey(result.library, "nodate").status, "needs-review", "no issued date");
    assert.deepEqual(result.duplicates, []);
    assert.deepEqual(result.renamedKeys, []);
    assert.deepEqual(result.added, Object.keys(result.library.entries));

    result = await imported({ notebook: "Notes", format: "ris", text: RIS });
    assert.equal(result.added.length, 2);
    assert.equal(result.library.entries[result.added[0]].key, "lee2019deep");
    assert.equal(result.library.entries[result.added[0]].status, "confirmed");
    assert.equal(result.library.entries[result.added[1]].status, "needs-review", "no author or editor");

    result = await imported({ notebook: "Notes", format: "csl-json", text: CSL_JSON });
    assert.deepEqual(result.added.map((id) => result.library.entries[id].key), ["park2018", "org2017"]);
    assert.equal(result.library.entries[result.added[1]].status, "confirmed", "a literal author counts");
    assert.equal(result.library.revision, 3);
  });

  await withLibrary(async () => {
    for (const [text, key] of [[BIBTEX, "smith2020sparse"], [RIS, "lee2019deep"], [CSL_JSON, "park2018"]] as const) {
      const result = await imported({ notebook: "Notes", format: "auto", text });
      assert.ok(result.added.some((id) => result.library.entries[id].key === key), key);
    }
    const medline = await imported({ notebook: "Notes", text: MEDLINE });
    const entry = medline.library.entries[medline.added[0]];
    assert.equal(entry.identifiers.pmid, "31234567");
    assert.equal(entry.identifiers.doi, "10.1000/sleep.2019");
    assert.equal(entry.csl.title, "Effects of sleep on memory: a randomized trial.");
    assert.deepEqual(entry.csl.author?.map((name) => name.family), ["Garcia", "Chen"]);
    assert.deepEqual(entry.csl.issued?.["date-parts"], [[2019, 3, 4]]);
    assert.equal(entry.csl["container-title-short"], "Sleep Med");
    assert.equal(entry.status, "confirmed");

    for (const text of ["10.1000/xyz", "Smith J. Sparse coding. Nature. 2020;1:2-3."]) {
      const response = await importReferences({ notebook: "Notes", format: "auto", text });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Add box/);
    }
    for (const body of [
      { notebook: "Notes", format: "endnote", text: BIBTEX },
      { notebook: "Notes" },
      { format: "bibtex", text: BIBTEX },
      { notebook: "../Notes", text: BIBTEX },
      "{ not json",
    ]) {
      const response = await importReferences(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal((await importReferences({ notebook: "Missing", text: BIBTEX })).status, 404);
    assert.equal((await importReferences({ notebook: "Notes", text: "x".repeat(5 * 1024 * 1024 + 1) })).status, 413);
  });
});

test("import skips exact duplicates, adds in-batch duplicates once, and reports fuzzy ones", async () => {
  await withLibrary(async () => {
    const first = await imported({ notebook: "Notes", text: String.raw`
@article{existing, author = {Smith, Jane}, title = {Sparse coding of natural images}, journal = {Vision}, year = {2020}}
@article{withdoi, author = {Doe, John}, title = {Known work}, journal = {J}, year = {2001}, doi = {10.1000/known}}
` });
    const [existingId, doiId] = first.added;
    const result = await imported({ notebook: "Notes", text: String.raw`
@article{again, author = {Doe, John}, title = {Known work, again}, year = {2001}, doi = {https://doi.org/10.1000/KNOWN}}
@article{fresh, author = {Lee, Kim}, title = {Fresh work}, journal = {J}, year = {2022}, doi = {10.1000/fresh}}
@article{fresh2, author = {Lee, Kim}, title = {Fresh work (copy)}, journal = {J}, year = {2022}, doi = {10.1000/fresh}}
@article{similar, author = {Smith, Jane}, title = {Sparse Coding of Natural Images.}, journal = {Vision}, year = {2020}}
` });
    assert.equal(result.library.revision, first.library.revision + 1, "one revision bump");
    assert.deepEqual(result.added.map((id) => result.library.entries[id].key), ["fresh", "similar"]);
    const [freshId, similarId] = result.added;
    assert.deepEqual(result.duplicates.map(({ entryId, existingId: other, reason, skipped, sourceKey }) => ({ entryId, other, reason, skipped, sourceKey })), [
      { entryId: doiId, other: doiId, reason: "doi", skipped: true, sourceKey: "again" },
      { entryId: freshId, other: freshId, reason: "doi", skipped: true, sourceKey: "fresh2" },
      { entryId: similarId, other: existingId, reason: "fuzzy", skipped: false, sourceKey: "similar" },
    ]);
    assert.equal(Object.keys(result.library.entries).length, 4);
    assert.equal(referenceImportSummary(result), "Added 2 references · 2 duplicates skipped");

    const none = await imported({ notebook: "Notes", text: "@article{x, title = {Fresh}, doi = {10.1000/fresh}}" });
    assert.deepEqual(none.added, []);
    assert.equal(none.library.revision, result.library.revision, "nothing to add writes nothing");
  });
});

test("import keeps free source keys and reports keys taken by other works", async () => {
  await withLibrary(async () => {
    await imported({ notebook: "Notes", text: "@book{smith2020, author = {Smith, Ann}, title = {Gardening}, year = {2020}, publisher = {P}}" });
    const result = await imported({ notebook: "Notes", text: String.raw`
@article{smith2020, author = {Smith, Bob}, title = {Quantum widgets}, journal = {Phys}, year = {2020}}
@article{SMITH2020, author = {Smith, Cy}, title = {Different widgets}, journal = {Phys}, year = {2020}}
@article{free2021, author = {Free, Al}, title = {Open keys}, journal = {J}, year = {2021}}
` });
    const keys = result.added.map((id) => result.library.entries[id].key);
    assert.equal(keys[2], "free2021");
    assert.notEqual(keys[0].toLowerCase(), "smith2020");
    assert.notEqual(keys[1].toLowerCase(), "smith2020");
    assert.deepEqual(result.renamedKeys, [{ sourceKey: "smith2020", key: keys[0] }, { sourceKey: "SMITH2020", key: keys[1] }]);
    assert.match(referenceImportSummary(result), /2 keys renamed/);
  });
});

test("import returns parse errors while the valid entries still import", async () => {
  await withLibrary(async () => {
    const result = await imported({ notebook: "Notes", format: "bibtex", text: String.raw`
@article{good, author = {Good, Ann}, title = {Fine}, journal = {J}, year = {2020}}

@article{broken, title = {Unclosed
@book{alsogood, author = {Ok, Bo}, title = {Also fine}, year = {2019}, publisher = {P}}
` });
    assert.ok(result.errors.length >= 1);
    assert.ok(result.errors.every((error) => typeof error.line === "number" && typeof error.message === "string"));
    const keys = result.added.map((id) => result.library.entries[id].key);
    assert.ok(keys.includes("good") && keys.includes("alsogood"), keys.join());
    assert.match(referenceImportSummary(result), /parse error/);

    const invalid = await imported({ notebook: "Notes", format: "csl-json", text: "[{" });
    assert.deepEqual(invalid.added, []);
    assert.equal(invalid.errors.length, 1);
  });
});

test("import reads reference files in the library by path, and only those", async () => {
  await withLibrary(async (root) => {
    await mkdir(path.join(root, "refs"), { recursive: true });
    await writeFile(path.join(root, "refs/library.bib"), `﻿${BIBTEX}`);
    await writeFile(path.join(root, "refs/pubmed.nbib"), MEDLINE);
    await writeFile(path.join(root, "refs/ris.nbib"), RIS);
    await writeFile(path.join(root, "refs/items.json"), CSL_JSON);
    await writeFile(path.join(root, "refs/list.ris"), RIS.replace(/lee2019deep/, "other").replace(/10\.1000\/cells/, "10.1000/other"));

    let result = await imported({ notebook: "Notes", path: "Notes/refs/library.bib" });
    assert.equal(result.added.length, 2);
    result = await imported({ notebook: "Notes", path: "Notes/refs/pubmed.nbib" });
    assert.equal(result.library.entries[result.added[0]].identifiers.pmid, "31234567");
    result = await imported({ notebook: "Notes", path: "Notes/refs/ris.nbib" });
    assert.equal(result.library.entries[result.added[0]].key, "lee2019deep", "a .nbib file in RIS format");
    result = await imported({ notebook: "Notes", path: "Notes/refs/items.json" });
    assert.equal(result.added.length, 2);
    result = await imported({ notebook: "Notes", path: "Notes/refs/list.ris" });
    assert.equal(result.library.entries[result.added[0]].key, "other");

    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await writeFile(path.join(root, ".hidden/secret.bib"), BIBTEX);
    await mkdir(path.join(root, "_assets"), { recursive: true });
    await writeFile(path.join(root, "_assets/a.bib"), BIBTEX);
    await writeFile(path.join(root, "note.md"), BIBTEX);
    await mkdir(path.join(root, "folder.bib"), { recursive: true });
    for (const [target, status] of [
      ["Notes/.hidden/secret.bib", 400],
      ["Notes/_assets/a.bib", 400],
      ["Notes/../Notes/refs/library.bib", 400],
      ["../outside.bib", 400],
      ["Notes\\refs\\library.bib", 400],
      ["/etc/passwd.bib", 404],
      [".libera/references/library.json", 400],
      ["Notes/note.md", 400],
      ["Notes/folder.bib", 400],
      ["Notes/missing.bib", 404],
    ] as const) {
      const response = await importReferences({ notebook: "Notes", path: target });
      assert.equal(response.status, status, target);
      assert.equal(typeof (await response.json()).error, "string");
    }

    // A sparse file: the size is refused before anything is read.
    await writeFile(path.join(root, "refs/huge.bib"), "");
    await truncate(path.join(root, "refs/huge.bib"), 5 * 1024 * 1024 + 1);
    assert.equal((await importReferences({ notebook: "Notes", path: "Notes/refs/huge.bib" })).status, 413);
    await writeFile(path.join(root, "refs/binary.bib"), "@article{x,\u0000}");
    assert.equal((await importReferences({ notebook: "Notes", path: "Notes/refs/binary.bib" })).status, 415);
  });
});

test("an import plans against the library it applies to", async () => {
  await withLibrary(async () => {
    // A concurrent write between the read and the transaction is retried, so the
    // duplicate check and the returned ids always describe the committed library.
    const [a, b] = await Promise.all([
      imported({ notebook: "Notes", text: "@article{one, author = {A, B}, title = {One}, year = {2020}, doi = {10.1000/one}}" }),
      imported({ notebook: "Notes", text: "@article{one, author = {A, B}, title = {One}, year = {2020}, doi = {10.1000/one}}" }),
    ]);
    const library = await readReferenceLibrary("Notes");
    assert.equal(Object.keys(library.entries).length, 1, "the same work is added once");
    assert.equal(a.added.length + b.added.length, 1);
    assert.equal(a.duplicates.length + b.duplicates.length, 1);
  });
});

test("parseReferenceImport refuses non-structured auto input with the Add box hint", () => {
  assert.throws(() => parseReferenceImport("arXiv:2101.00001", "auto"), /Add box/);
  assert.equal(parseReferenceImport(BIBTEX, "auto").entries.length, 2);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportLibrary() {
  const library = await updateReferenceLibrary("Notes", null, [
    { op: "add", entry: { key: "alpha", csl: { type: "article-journal", title: "Alpha study", author: [{ family: "Ash", given: "Al" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal of Long Names", "container-title-short": "J. Long Names" }, identifiers: { doi: "10.1000/alpha" } } },
    { op: "add", entry: { key: "beta", csl: { type: "book", title: "Beta book", author: [{ family: "Birch", given: "Bo" }], issued: { "date-parts": [[2019]] }, publisher: "Press" } } },
    { op: "add", entry: { key: "gamma", csl: { type: "report", title: "Gamma report", issued: { "date-parts": [[2018]] } } } },
  ]);
  const ids = Object.fromEntries(Object.values(library.entries).map((entry) => [entry.key, entry.id]));
  await updateReferenceLibrary("Notes", null, [{ op: "rename-key", id: ids.alpha, key: "ash2020alpha" }]);
  return ids;
}

test("export writes each format with its type and download name", async () => {
  await withLibrary(async () => {
    await exportLibrary();
    const cases = [
      ["bibtex", "application/x-bibtex; charset=utf-8", "Notes-references.bib", /@article\{ash2020alpha,[\s\S]*journal += \{Journal of Long Names\}/],
      ["biblatex", "application/x-bibtex; charset=utf-8", "Notes-references.bib", /journaltitle += \{Journal of Long Names\}/],
      ["csl-json", "application/vnd.citationstyles.csl+json; charset=utf-8", "Notes-references.json", /"id": "ash2020alpha"/],
      ["ris", "application/x-research-info-systems; charset=utf-8", "Notes-references.ris", /TY {2}- JOUR/],
    ] as const;
    for (const [format, type, name, pattern] of cases) {
      const response = await exportReferences({ notebook: "Notes", format });
      assert.equal(response.status, 200, format);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("content-disposition"), `attachment; filename="${name}"; filename*=UTF-8''${name}`);
      assert.equal(response.headers.get("x-libera-unresolved-keys"), null);
      const text = await response.text();
      assert.match(text, pattern, format);
      for (const key of ["ash2020alpha", "beta", "gamma"]) assert.ok(text.includes(key), `${format} has ${key}`);
    }
    const json = JSON.parse(await (await exportReferences({ notebook: "Notes", format: "csl-json" })).text());
    assert.deepEqual(json.map((item: { id: string }) => item.id), ["ash2020alpha", "beta", "gamma"]);
  });
});

test("export selects ids, cited keys with aliases, reports unknown keys, and honors BibTeX options", async () => {
  await withLibrary(async () => {
    const ids = await exportLibrary();
    let response = await exportReferences({ notebook: "Notes", format: "csl-json", ids: [ids.gamma, "ref_gone"] });
    assert.deepEqual(JSON.parse(await response.text()).map((item: { id: string }) => item.id), ["gamma"]);

    const documentText = "Intro [@beta, p. 3; @alpha] and [@missing] then [-@Ash2020Alpha].\n\n`[@gamma]`\n\n```\n[@gamma]\n```\n\n[@später]";
    response = await exportReferences({ notebook: "Notes", format: "bibtex", documentText, documentName: "Chapter 1.md" });
    assert.equal(response.headers.get("x-libera-unresolved-keys"), "missing,sp%C3%A4ter");
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="Chapter 1-bibliography.bib"; filename*=UTF-8''Chapter%201-bibliography.bib`);
    let text = await response.text();
    assert.ok(text.startsWith("% Citation keys not found in the References library: missing, später\n\n"), text.slice(0, 80));
    assert.ok(text.indexOf("@book{beta,") < text.indexOf("@article{ash2020alpha,"), "citation order");
    assert.ok(!text.includes("gamma"), "code is not cited");
    assert.ok(!text.includes("@comment{alias"), "aliases only on request");

    response = await exportReferences({ notebook: "Notes", format: "ris", documentText });
    text = await response.text();
    assert.ok(text.startsWith("Citation keys not found in the References library: missing, später\r\n\r\n"));
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="Notes-bibliography.ris"; filename*=UTF-8''Notes-bibliography.ris`);
    response = await exportReferences({ notebook: "Notes", format: "csl-json", documentText, documentName: "Draft.md" });
    assert.deepEqual(JSON.parse(await response.text()).map((item: { id: string }) => item.id), ["beta", "ash2020alpha"]);
    assert.equal(response.headers.get("x-libera-unresolved-keys"), "missing,sp%C3%A4ter");

    response = await exportReferences({ notebook: "Notes", format: "bibtex", ids: [ids.alpha], abbreviateJournals: true, includeAliases: true });
    text = await response.text();
    assert.match(text, /^@comment\{alias: alpha -> ash2020alpha\}\n@article\{ash2020alpha,/);
    assert.match(text, /journal += \{J\. Long Names\}/);
    response = await exportReferences({ notebook: "Notes", format: "biblatex", ids: [ids.alpha], abbreviateJournals: true });
    assert.match(await response.text(), /journaltitle += \{J\. Long Names\}/);

    for (const body of [
      { notebook: "Notes", format: "docx" },
      { notebook: "Notes" },
      { notebook: "Notes", format: "bibtex", ids: "x" },
      { notebook: "Notes", format: "bibtex", documentText: 3 },
      { notebook: "Notes", format: "bibtex", abbreviateJournals: "yes" },
      { notebook: "../x", format: "bibtex" },
    ]) {
      response = await exportReferences(body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal((await exportReferences({ notebook: "Missing", format: "bibtex" })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Routes need a session
// ---------------------------------------------------------------------------

test("every interop route requires authentication", async () => {
  await withLibrary(async () => {
    for (const response of [
      await importReferences({ notebook: "Notes", text: BIBTEX }, false),
      await exportReferences({ notebook: "Notes", format: "bibtex" }, false),
      await citations("notebook=Notes", false),
    ]) {
      assert.equal(response.status, 401);
    }
    assert.equal((await readReferenceLibrary("Notes")).revision, 0, "nothing was imported");
  });
});

// ---------------------------------------------------------------------------
// Citation index
// ---------------------------------------------------------------------------

test("the citation index reads only new and changed files and drops deleted ones", async () => {
  await withLibrary(async (root) => {
    await mkdir(path.join(root, "sub"), { recursive: true });
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await mkdir(path.join(root, "_assets"), { recursive: true });
    await mkdir(path.join(root, "_archive"), { recursive: true });
    await writeFile(path.join(root, "a.md"), "See [@x; @y, p. 2] and `[@code]`.");
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    await utimes(path.join(root, "a.md"), fixed, fixed);
    await writeFile(path.join(root, "sub/b.md"), "Also [-@y].");
    await writeFile(path.join(root, "c.md"), "No citations, just mail@example.com.");
    await writeFile(path.join(root, "d.txt"), "[@txt]");
    await writeFile(path.join(root, ".hidden/h.md"), "[@hidden]");
    await writeFile(path.join(root, "_assets/x.md"), "[@asset]");
    await writeFile(path.join(root, "_archive/old.md"), "[@archived]");

    let result = await refreshNotebookCitations("Notes");
    assert.deepEqual(result.byFile, { "Notes/a.md": ["x", "y"], "Notes/sub/b.md": ["y"] });
    assert.deepEqual(result.byKey, { x: ["Notes/a.md"], y: ["Notes/a.md", "Notes/sub/b.md"] });
    assert.deepEqual(result.stats, { files: 3, read: 3, written: true });
    const indexPath = citationIndexPath("Notes");
    assert.equal(indexPath, path.join(root, ".libera", "references", "citations.json"));
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    assert.equal(index.version, 1);
    assert.deepEqual(Object.keys(index.files), ["Notes/a.md", "Notes/c.md", "Notes/sub/b.md"]);
    assert.deepEqual(Object.keys(index.files["Notes/a.md"]).sort(), ["keys", "mtimeMs", "size"]);
    const indexMtime = (await stat(indexPath)).mtimeMs;

    result = await refreshNotebookCitations("Notes");
    assert.deepEqual(result.stats, { files: 3, read: 0, written: false });
    assert.equal((await stat(indexPath)).mtimeMs, indexMtime, "an unchanged index is not rewritten");

    // Same size and mtime: the file is not read again, so its old keys remain.
    await writeFile(path.join(root, "a.md"), "See [@q; @w, p. 2] and `[@code]`.");
    await utimes(path.join(root, "a.md"), fixed, fixed);
    result = await refreshNotebookCitations("Notes");
    assert.deepEqual(result.byFile["Notes/a.md"], ["x", "y"]);
    assert.equal(result.stats.read, 0);
    await utimes(path.join(root, "a.md"), fixed, new Date(fixed.getTime() + 5000));
    result = await refreshNotebookCitations("Notes");
    assert.deepEqual(result.byFile["Notes/a.md"], ["q", "w"]);
    assert.equal(result.stats.read, 1);

    await writeFile(path.join(root, "e.md"), "[@new]");
    await unlink(path.join(root, "sub/b.md"));
    await writeFile(path.join(root, "c.md"), "Now [@q] too, with a different size.");
    result = await refreshNotebookCitations("Notes");
    assert.deepEqual(result.byFile, { "Notes/a.md": ["q", "w"], "Notes/c.md": ["q"], "Notes/e.md": ["new"] });
    assert.deepEqual(result.byKey, { q: ["Notes/a.md", "Notes/c.md"], w: ["Notes/a.md"], new: ["Notes/e.md"] });
    assert.deepEqual(result.stats, { files: 3, read: 2, written: true });

    // The archive is indexed only when included; its entries survive walks without it.
    result = await refreshNotebookCitations("Notes", { includeArchive: true });
    assert.deepEqual(result.byKey.archived, ["Notes/_archive/old.md"]);
    assert.equal(result.stats.read, 1);
    result = await refreshNotebookCitations("Notes");
    assert.equal(result.byKey.archived, undefined);
    assert.equal(result.stats.written, false);
    result = await refreshNotebookCitations("Notes", { includeArchive: true });
    assert.equal(result.stats.read, 0);

    // A damaged index is rebuilt.
    await writeFile(indexPath, "{ partial");
    result = await refreshNotebookCitations("Notes");
    assert.equal(result.stats.read, 3);
    assert.deepEqual(result.byKey.q, ["Notes/a.md", "Notes/c.md"]);
  });
});

test("concurrent citation requests share one rebuild", async () => {
  await withLibrary(async (root) => {
    for (let index = 0; index < 20; index++) await writeFile(path.join(root, `n${index}.md`), `[@k${index}]`);
    const [first, second, third] = await Promise.all([
      refreshNotebookCitations("Notes"),
      refreshNotebookCitations("Notes"),
      refreshNotebookCitations("Notes"),
    ]);
    assert.equal(first.stats, second.stats, "the same rebuild");
    assert.equal(second.stats, third.stats);
    assert.equal(first.stats.read, 20);
    assert.deepEqual(first.byFile, third.byFile);
    const next = await refreshNotebookCitations("Notes");
    assert.notEqual(next.stats, first.stats, "a later request runs its own rebuild");
    assert.equal(next.stats.read, 0);
  });
});

test("a linked folder keeps its citation index in the data folder", async () => {
  await withLibrary(async (_root, scratch) => {
    const project = path.join(scratch, "Thesis");
    await mkdir(path.join(project, "chapters"), { recursive: true });
    await mkdir(path.join(project, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(project, "chapters/intro.md"), "As [@smith2020] shows.");
    await writeFile(path.join(project, "node_modules/pkg/README.md"), "[@dependency]");
    const linked = await openDirectory(project);
    const result = await refreshNotebookCitations(linked.name);
    assert.deepEqual(result.byFile, { [`${linked.name}/chapters/intro.md`]: ["smith2020"] });
    assert.ok(!citationIndexPath(linked.name).startsWith(project), "never written into the user's folder");
    await stat(citationIndexPath(linked.name));
    await assert.rejects(stat(path.join(project, ".libera")));
  });
});

test("an unchanged notebook of 1,000 Markdown files answers from a stat walk", async () => {
  await withLibrary(async (root) => {
    for (let folder = 0; folder < 10; folder++) {
      await mkdir(path.join(root, `f${folder}`), { recursive: true });
      // One at a time: a burst of file creation slows the timing tests running beside this one.
      for (let index = 0; index < 100; index++) {
        await writeFile(path.join(root, `f${folder}`, `note${index}.md`), `Note ${index} cites [@key${index % 37}] and [@shared].`);
      }
    }
    let started = performance.now();
    let result = await refreshNotebookCitations("Notes");
    const cold = performance.now() - started;
    assert.deepEqual(result.stats, { files: 1000, read: 1000, written: true });
    assert.equal(result.byKey.shared.length, 1000);

    started = performance.now();
    result = await refreshNotebookCitations("Notes");
    const warm = performance.now() - started;
    assert.deepEqual(result.stats, { files: 1000, read: 0, written: false });
    console.log(`citation index, 1,000 files: cold ${cold.toFixed(0)} ms, unchanged ${warm.toFixed(0)} ms`);
    assert.ok(warm < 10_000, `unchanged rebuild took ${warm} ms`);
  });
});

test("GET /api/references/citations returns byFile and byKey", async () => {
  await withLibrary(async (root) => {
    await writeFile(path.join(root, "a.md"), "[@smith2020; @old-alias]");
    await writeFile(path.join(root, "b.md"), "[@smith2020, p. 4]");
    const response = await citations("notebook=Notes");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      byFile: { "Notes/a.md": ["smith2020", "old-alias"], "Notes/b.md": ["smith2020"] },
      byKey: { smith2020: ["Notes/a.md", "Notes/b.md"], "old-alias": ["Notes/a.md"] },
    });
    assert.equal((await citations("notebook=Missing")).status, 404);
    assert.equal((await citations("notebook=..")).status, 400);
    assert.equal((await citations("")).status, 400);
    await mkdir(path.join(root, "_archive"), { recursive: true });
    await writeFile(path.join(root, "_archive/z.md"), "[@zed]");
    assert.deepEqual((await (await citations("notebook=Notes&includeArchive=1")).json()).byKey.zed, ["Notes/_archive/z.md"]);
    assert.equal((await (await citations("notebook=Notes")).json()).byKey.zed, undefined);
    assert.ok(!(await readFile(referenceLibraryPath("Notes")).catch(() => null)), "the index does not create a library");
  });
});
