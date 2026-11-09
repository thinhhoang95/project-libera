/*
 * Off-book end-to-end run of Check Notebook → Try to fix → Acknowledge.
 * Not part of any test suite: nothing runs it by default. Run it by hand:
 *
 *   node --import tsx scripts/offbook/notebook-repair-e2e.ts [--source <notebook folder>] [--keep] [--port 3123]
 *
 * --source  a notebook folder to copy as the portfolio's content (read only;
 *           default: the "Commitment Optimization" notebook in OneDrive).
 * --keep    keep the throwaway data folder afterwards.
 *
 * What it does, against the real app (a `next dev` server it starts on a
 * throwaway data folder, driven over HTTP as the UI drives it):
 *
 *  1. Copies the source notebook's notes, figures and PDFs into a new
 *     notebook "Portfolio", under a subfolder `drafts/` (a plain copy, as
 *     Finder would make one), then adds what people make in the app: a
 *     linking index note with deep links (heading anchors, relative links,
 *     library addresses, a PDF), an uploaded figure, review comments, stars,
 *     tags, PDF annotations, a reference with an attached PDF, definitions
 *     and Python code.
 *  2. Checks the notebook (the baseline).
 *  3. Moves things outside the app, as Finder would: everything in drafts/ up
 *     to the notebook's top level, the literature folder renamed, one note
 *     deleted for good, one note edited by another editor.
 *  4. Loads the tree (what the app does on returning to the window), checks,
 *     runs Try to fix, checks, runs Acknowledge, checks.
 *  5. Asserts what must hold, and writes a report (Markdown) with every
 *     finding, plan and result, plus the server's log.
 *
 * Exits 1 when an assertion fails. The report says where it is.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const SOURCE = option("--source") ?? path.join(os.homedir(), "OneDrive", "Libera", "users", "admin", "Commitment Optimization");
const KEEP = args.includes("--keep");
const PORT = Number(option("--port") ?? 3123);
const BASE = `http://localhost:${PORT}`;
const NB = "Portfolio";
const REPO = path.resolve(__dirname, "..", "..");

// ---- Report ------------------------------------------------------------------

const report: string[] = [];
const failures: string[] = [];
const log = (line = "") => { report.push(line); console.log(line); };
const section = (title: string) => log(`\n## ${title}\n`);
const check = (ok: boolean, what: string) => { log(`- ${ok ? "PASS" : "**FAIL**"} ${what}`); if (!ok) failures.push(what); };

type Finding = { check: string; severity: string; path: string; message: string; clear?: unknown[] };
type Report = { completeness: string; findings: Finding[]; checks: { id: string; status: string; note?: string }[] };
function logReport(label: string, result: Report) {
  const clearable = result.findings.filter((finding) => finding.clear?.length).length;
  log(`**${label}**: ${result.findings.length} findings (${clearable} clearable), ${result.completeness}.`);
  for (const check of result.checks) if (check.status === "failed" || check.status === "incomplete") log(`  - check ${check.id} ${check.status}: ${check.note}`);
  for (const finding of result.findings) log(`  - [${finding.severity}${finding.clear?.length ? ", clearable" : ""}] ${finding.check} · ${finding.path} — ${finding.message}`);
}

// ---- The app ------------------------------------------------------------------

let server: ChildProcess | null = null;
const serverLog: string[] = [];
let cookie = "";

async function startServer(dataDir: string, password: string) {
  const next = createRequire(path.join(REPO, "package.json")).resolve("next/dist/bin/next");
  server = spawn(process.execPath, [next, "dev", "-p", String(PORT)], {
    cwd: REPO,
    env: { ...process.env, LIBERA_DATA_DIR: dataDir, LIBERA_DEV_PASSWORD: password, LIBERA_SESSION_SECRET: randomBytes(24).toString("hex"), LIBERA_USAGE_LEDGER: "off", NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The dev server did not start within 120 s.")), 120_000);
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      serverLog.push(text);
      if (/Ready in|✓ Ready/.test(text)) { clearTimeout(timer); resolve(); }
    };
    server!.stdout!.on("data", take);
    server!.stderr!.on("data", take);
    server!.on("exit", (code) => { clearTimeout(timer); reject(new Error(`The dev server exited (${code}).\n${serverLog.join("")}`)); });
  });
  await ready;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  if (process.platform === "win32") await new Promise((resolve) => spawn("taskkill", ["/pid", String(server!.pid), "/t", "/f"]).on("exit", resolve));
  else server.kill("SIGTERM");
}

async function api<T = unknown>(method: string, route: string, body?: unknown, form?: FormData): Promise<T> {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length) cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}
const q = (value: string) => encodeURIComponent(value);
const verify = () => api<Report>("GET", `/api/notebooks/verify?notebook=${q(NB)}`);
const loadTree = () => api("GET", "/api/tree");

// ---- Files on disk, as Finder sees them ---------------------------------------

const exists = (target: string) => stat(target).then(() => true, () => false);
async function filesUnder(root: string, skip = (name: string) => name.startsWith(".")): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target); else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return found;
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const libraryLink = (libraryPath: string) => libraryPath.split("/").map(encodeURIComponent).join("/");

// ---- The run ------------------------------------------------------------------

async function main() {
  if (!(await exists(SOURCE))) throw new Error(`The source notebook ${SOURCE} is not there. Pass --source <folder>.`);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "libera-offbook-e2e-"));
  const admin = path.join(dataDir, "users", "admin");
  const root = path.join(admin, NB);
  // Outside the data folder, which is removed after a passing run.
  const reportPath = path.join(os.tmpdir(), `libera-offbook-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  log(`# Notebook repair end-to-end (off-book)\n\nSource: ${SOURCE}\nData folder: ${dataDir}\nStarted: ${new Date().toISOString()}`);
  const password = randomBytes(12).toString("base64url");

  // Libera's storage helpers, for the few records the app makes without an HTTP route here (definitions, Python code).
  process.env.LIBERA_DATA_DIR = dataDir;
  const { definitionsPath, filePathFromParts } = await import("../../src/lib/storage/paths");
  const { pythonSidecarPath } = await import("../../src/lib/python/sidecar");
  const { DEFINITIONS_VERSION } = await import("../../src/lib/definitions");
  const { markdownHeadingAnchors } = await import("../../src/lib/markdown-heading-anchors");

  try {
    // 1. The portfolio: a Finder copy of the source's notes, figures and PDFs under drafts/.
    section("1. Portfolio");
    await mkdir(admin, { recursive: true });
    const content = await filesUnder(SOURCE, (name) => name.startsWith(".") || name === "_assets");
    for (const file of content) {
      await mkdir(path.dirname(path.join(root, "drafts", file)), { recursive: true });
      await cp(path.join(SOURCE, file), path.join(root, "drafts", file));
    }
    // The figures the source's notes embed (its _assets, where the notes' embeds point), so their images resolve as they did.
    if (await exists(path.join(SOURCE, "_assets"))) await cp(path.join(SOURCE, "_assets"), path.join(root, "_assets"), { recursive: true });
    log(`Copied ${content.length} files into ${NB}/drafts (Finder copy).`);

    await startServer(dataDir, password);
    log(`Dev server on ${BASE}.`);
    await api("POST", "/api/auth/login", { password });
    await loadTree();

    const notes = content.filter((file) => file.endsWith(".md")).map((file) => `${NB}/drafts/${file}`);
    const pdfs = content.filter((file) => file.toLowerCase().endsWith(".pdf")).map((file) => `${NB}/drafts/${file}`);
    if (notes.length < 3 || pdfs.length < 2) throw new Error(`The source needs at least 3 notes and 2 PDFs (has ${notes.length} and ${pdfs.length}).`);
    const [noteA, noteB, noteGone] = notes.filter((note) => !note.includes("/", `${NB}/drafts/`.length));
    const [pdfA, pdfB] = pdfs;
    log(`Notes in play: ${noteA}, ${noteB}, ${noteGone} (deleted later). PDFs: ${pdfA}, ${pdfB}.`);

    // A linking note with deep links of every kind, and a figure uploaded into it.
    // The anchor the editor makes for the note's second heading (the first is often the title).
    const headingOf = async (note: string) => {
      const anchors = markdownHeadingAnchors(await readFile(path.join(admin, ...note.split("/")), "utf8"));
      return (anchors[1] ?? anchors[0])?.slug ?? "";
    };
    const rel = (from: string, to: string) => path.posix.relative(path.posix.dirname(from), to).split("/").map(encodeURIComponent).join("/");
    const index = `${NB}/drafts/index.md`;
    await api("POST", "/api/files", { notebook: NB, parentPath: `${NB}/drafts`, name: "index.md", content: "# Index\n" });
    const figure = new FormData();
    figure.set("documentPath", index);
    figure.set("file", new File([randomBytes(256)], "figure.png", { type: "image/png" }));
    const upload = await api<{ markdown: string }>("POST", "/api/markdown-assets", undefined, figure);
    const indexText = [
      "# Index",
      "",
      "## Relative links",
      `- [${path.posix.basename(noteA)}](${rel(index, noteA)}#${await headingOf(noteA)}) (a heading)`,
      `- [${path.posix.basename(noteB)}](${rel(index, noteB)})`,
      `- [the paper](${rel(index, pdfA)})`,
      "",
      "## Library addresses",
      `- [${path.posix.basename(noteB)}](${libraryLink(noteB)})`,
      `- [the other paper](${libraryLink(pdfB)})`,
      "",
      "## A figure",
      upload.markdown,
      "",
    ].join("\n");
    await api("PATCH", "/api/files", { path: index, content: indexText });

    // What people make in the app.
    await api("PATCH", "/api/starred-files", { path: noteA, starred: true });
    await api("PATCH", "/api/starred-files", { path: pdfA, starred: true });
    await api("PATCH", "/api/file-tags", { path: noteB, tags: ["digest"] });
    await api("PATCH", "/api/file-tags", { path: noteGone, tags: ["plan"] });
    for (const note of [noteA, noteGone]) {
      const snapshot = await readFile(path.join(admin, ...note.split("/")), "utf8");
      const review = await api<{ id: string; revision: number }>("POST", "/api/markdown-reviews", { action: "load", key: note, snapshot });
      await api("POST", "/api/markdown-reviews", { action: "comment", id: review.id, revision: review.revision, snapshot, range: { start: 0, end: Math.min(10, snapshot.length) }, text: `A comment on ${path.posix.basename(note)}` });
    }
    const highlight = (id: string) => ({ id, type: "text", pageNumber: 1, text: `note ${id}`, rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } });
    await api("PATCH", "/api/pdf-annotations", { path: pdfA, annotations: [highlight("a1")] });
    await api("PATCH", "/api/pdf-annotations", { path: pdfB, annotations: [highlight("b1")] });
    const pdfBytes = await readFile(path.join(admin, ...pdfA.split("/")));
    const { library } = await api<{ library: { revision: number } }>("GET", `/api/references?notebook=${q(NB)}`);
    await api("PATCH", "/api/references", { notebook: NB, revision: library.revision, ops: [{ op: "add", entry: { key: "paper2026", csl: { type: "article-journal", title: "The paper" }, attachments: [{ kind: "pdf", path: pdfA, sha256: sha256(pdfBytes), size: pdfBytes.length }] } }] });
    // Definitions and Python code, saved where the app saves them.
    for (const note of [noteA, noteB]) {
      const [, ...parts] = note.split("/");
      const bytes = await readFile(filePathFromParts(NB, parts));
      await mkdir(path.dirname(definitionsPath(NB, parts)), { recursive: true });
      await writeFile(definitionsPath(NB, parts), JSON.stringify({ version: DEFINITIONS_VERSION, documentPath: note, generatedAt: new Date().toISOString(), model: "offbook", source: { size: bytes.length, contentHash: sha256(bytes) }, entries: [] }));
    }
    const python = path.join(admin, ...pythonSidecarPath(noteGone).split("/"));
    await mkdir(path.dirname(python), { recursive: true });
    await writeFile(python, "print('analysis')\n");
    await loadTree();

    // 2. Baseline.
    section("2. Baseline check");
    const baseline = await verify();
    logReport("Baseline", baseline);
    check(!baseline.findings.some((finding) => finding.path.startsWith(`${NB}/drafts/index.md`)), "the index note's links and figure resolve before anything moves");

    // 3. Outside the app, as Finder would.
    section("3. Finder");
    const moved = new Map<string, string>();
    for (const entry of await readdir(path.join(root, "drafts"))) {
      const target = entry === "1103_Literature_Review" ? "Literature" : entry;
      await rename(path.join(root, "drafts", entry), path.join(root, target));
      log(`- moved drafts/${entry} → ${target}`);
      moved.set(`${NB}/drafts/${entry}`, `${NB}/${target}`);
    }
    await rm(path.join(root, "drafts"), { recursive: true });
    const now = (libraryPath: string) => { for (const [from, to] of moved) if (libraryPath === from || libraryPath.startsWith(`${from}/`)) return to + libraryPath.slice(from.length); return libraryPath; };
    const goneNow = now(noteGone);
    await rm(path.join(admin, ...goneNow.split("/")));
    log(`- deleted ${goneNow} for good`);
    // The source's figure and code folders renamed: the notes' embeds break, the images and code look unused.
    for (const entry of await readdir(path.join(root, "_assets"), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "drafts") continue;
      await rename(path.join(root, "_assets", entry.name), path.join(root, "_assets", `${entry.name}-old`));
      log(`- renamed _assets/${entry.name} → _assets/${entry.name}-old`);
    }
    const editedNow = now(noteB);
    await writeFile(path.join(admin, ...editedNow.split("/")), `${await readFile(path.join(admin, ...editedNow.split("/")), "utf8")}\n\nEdited in another editor.\n`);
    log(`- edited ${editedNow} in another editor`);

    // 4. The app notices, then the check, Try to fix and Acknowledge.
    section("4. Tree load, check");
    await loadTree();
    const afterMove = await verify();
    logReport("After the Finder moves", afterMove);

    section("5. Try to fix");
    const plan = await api<{ moves: { from: string; to: string; records: string[] }[]; unmatched: { from: string; reason: string; records: string[] }[]; token: string }>("GET", `/api/notebooks/repair?notebook=${q(NB)}`);
    for (const move of plan.moves) log(`- pair: ${move.from} → ${move.to} (${move.records.join(", ")})`);
    for (const item of plan.unmatched) log(`- left: ${item.from} (${item.reason}; ${item.records.join(", ")})`);
    const fixed = await api<{ moved: unknown[]; problems: string[] }>("POST", "/api/notebooks/repair", { notebook: NB, token: plan.token });
    log(`Applied: ${fixed.moved.length} moved, problems: ${fixed.problems.length ? fixed.problems.join(" | ") : "none"}`);
    await loadTree();
    const afterFix = await verify();
    logReport("After Try to fix", afterFix);
    check(!fixed.problems.length, "Try to fix reports no problems");
    check(plan.moves.some((move) => move.from === noteA && move.to === now(noteA)), `${noteA}'s records are paired with ${now(noteA)}`);

    section("6. Acknowledge");
    const cleanup = await api<{ items: { path: string; message: string; consequence: string; lost: boolean }[]; remaining: number; token: string }>("GET", `/api/notebooks/cleanup?notebook=${q(NB)}`);
    for (const item of cleanup.items) log(`- ${item.lost ? "LOST " : ""}${item.path} — ${item.message} → ${item.consequence}`);
    log(`${cleanup.items.length} items, ${cleanup.remaining} other findings stay.`);
    const cleaned = await api<{ cleared: number; problems: string[] }>("POST", "/api/notebooks/cleanup", { notebook: NB, token: cleanup.token });
    log(`Applied: ${cleaned.cleared} cleared, problems: ${cleaned.problems.length ? cleaned.problems.join(" | ") : "none"}`);
    await loadTree();
    const final = await verify();
    logReport("After Acknowledge", final);

    // 5. What must hold.
    section("7. Assertions");
    check(!cleaned.problems.length, "Acknowledge reports no problems");
    check(cleaned.cleared === cleanup.items.length, "every listed item was cleared");
    check(!final.findings.some((finding) => finding.clear?.length), "checking again finds nothing stale");
    check(final.completeness === "complete", "the final check is complete");
    const workspace = JSON.parse(await readFile(path.join(admin, ".libera-workspace.json"), "utf8")) as { starredFilePaths: string[]; fileTags: Record<string, string[]> };
    check(workspace.starredFilePaths.includes(now(noteA)), "the star followed the moved note");
    check(workspace.starredFilePaths.includes(now(pdfA)), "the star followed the moved PDF");
    check(JSON.stringify(workspace.fileTags[now(noteB)]) === JSON.stringify(["digest"]), "the tags followed the moved note");
    check(!Object.keys(workspace.fileTags).some((key) => key.includes("/drafts/")) && !workspace.starredFilePaths.some((key) => key.includes("/drafts/")), "no star or tag is left at an old path");
    const reviewIndex = JSON.parse(await readFile(path.join(admin, ".libera", "reviews", "index.json"), "utf8")) as { documents: Record<string, string> };
    const reviewKeys = Object.values(reviewIndex.documents);
    check(reviewKeys.includes(now(noteA)), "the review comments followed the moved note");
    check(!reviewKeys.some((key) => key.includes("/drafts/") || key === goneNow || key === noteGone), "no review comments are left for missing files");
    const annotations = await api<{ annotations: { id: string }[] }>("GET", `/api/pdf-annotations?path=${q(now(pdfA))}`);
    check(annotations.annotations.some((annotation) => annotation.id === "a1"), "the PDF's annotations followed it into the renamed folder");
    const references = await api<{ library?: { entries: Record<string, { attachments: { path?: string }[] }> }; entries?: Record<string, { attachments: { path?: string }[] }> }>("GET", `/api/references?notebook=${q(NB)}`);
    const attachments = Object.values(references.library?.entries ?? references.entries ?? {}).flatMap((entry) => entry.attachments.map((attachment) => attachment.path));
    check(attachments.includes(now(pdfA)), "the reference attachment followed the PDF");
    check(!(await exists(python)), "the deleted note's Python code is gone");
    check(await exists(definitionsPath(NB, now(noteA).split("/").slice(1))), "definitions of the moved, unchanged note followed it");
    check(!(await exists(definitionsPath(NB, editedNow.split("/").slice(1)))), "definitions saved for the note's older version were removed");
    const stays = final.findings.map((finding) => `${finding.check}: ${finding.message}`);
    log(`\nStill listed (need a person): ${stays.length ? "" : "none"}`);
    for (const line of stays) log(`  - ${line}`);
    const brokenIndex = final.findings.filter((finding) => finding.path === now(index));
    log(`The index note after the move: ${brokenIndex.length} findings (library addresses and links to moved files are expected to break; links are never rewritten).`);
    const figureNow = upload.markdown.match(/\(([^)]+)\)/)?.[1];
    if (figureNow) log(`The uploaded figure is referenced as ${figureNow}.`);
    // An image a missing embed names (by file name) must never be offered for removal.
    const missingNames = new Set(afterFix.findings.filter((finding) => finding.check === "images").map((finding) => finding.message.match(/Shows (.+), which is missing/)?.[1]?.split("/").at(-1)?.toLowerCase()));
    check(!cleanup.items.some((item) => missingNames.has(item.path.split("/").at(-1)?.toLowerCase())), "Acknowledge never offers an image whose name a broken embed uses");
    check(baseline.findings.every((finding) => finding.check !== "images"), "every figure the source's notes embed resolves in the portfolio");
    check(!cleanup.items.some((item) => item.path.endsWith(".py") && item.path.includes("-old/")), "Acknowledge never offers Python code named like a note that is there");
    check(afterFix.findings.some((finding) => finding.check === "images"), "the renamed figures folder broke some embeds (the case above was exercised)");
  } catch (error) {
    // A run that stops early has not shown anything to hold.
    failures.push(`the run stopped: ${error instanceof Error ? error.message : String(error)}`);
    log(`\n**The run stopped:** ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    await stopServer();
    section("Server log (errors and failed requests)");
    const lines = serverLog.join("").split(/\r?\n/).filter((line) => /error|Error|exception| [45]\d\d in /.test(line));
    log(lines.length ? lines.map((line) => `    ${line}`).join("\n") : "none");
    await writeFile(path.join(dataDir, "server.log"), serverLog.join(""));
    log(`\n${failures.length ? `**${failures.length} assertions failed.**` : "All assertions passed."}`);
    await writeFile(reportPath, report.join("\n"));
    console.log(`\nReport: ${reportPath}`);
    if (!KEEP && !failures.length) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    else console.log(`Data folder kept: ${dataDir}`);
  }
}

main().then(() => process.exit(failures.length ? 1 : 0), async (error) => {
  console.error(error);
  await stopServer();
  process.exit(1);
});
