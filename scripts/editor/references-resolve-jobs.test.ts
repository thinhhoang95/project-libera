import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getJobs, POST as postJobs } from "../../src/app/api/references/jobs/route";
import { POST as postResolve } from "../../src/app/api/references/resolve/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { ReferenceJobRunner, currentReferenceJobRunner, referenceJobsFilePath, setReferenceJobRunner, type ReferenceJobRunnerDeps } from "../../src/lib/references/jobs";
import type { ReferenceJobStatus } from "../../src/lib/references/jobs-types";
import type { ResolveOptions, ResolveResult } from "../../src/lib/references/resolve/pipeline";
import type { ReferenceEntryInput } from "../../src/lib/references/types";
import { writeUploadedFile } from "../../src/lib/storage/files";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";
import { testOptions, testSettings } from "./references-resolve-helpers";

async function withLibrary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-jobs-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Notes");
    await run(directory);
  } finally {
    // A runner created along the way (uploads create one) may still hold
    // debounced automatic additions; their timers must not fire after the
    // data directory changes, or they write into the next test's library.
    const active = currentReferenceJobRunner();
    active?.dispose();
    await active?.idle("Notes");
    setReferenceJobRunner(undefined);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function addFiles(...relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    const target = path.join(notebookPath("Notes"), ...relativePath.split("/").slice(1));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `%PDF-1.4 ${relativePath}`);
  }
}

function candidateFor(relativePath: string, extra: Partial<ReferenceEntryInput> = {}): ReferenceEntryInput {
  return { csl: { type: "article-journal", title: `Paper ${relativePath}` }, status: "needs-review", attachments: [{ kind: "pdf", path: relativePath }], ...extra };
}

function result(candidates: ReferenceEntryInput[]): ResolveResult {
  return { candidates, duplicates: [], updates: [], warnings: [] };
}

function runner(deps: Partial<ReferenceJobRunnerDeps>) {
  return new ReferenceJobRunner({ settings: () => testSettings({ useAi: false }), listNotebooks: async () => ["Notes"], ...deps });
}

async function until(check: () => Promise<boolean> | boolean, timeout = 5_000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for the job.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("resolve-pdfs resolves every PDF without an entry, outside the archive, one transaction per file", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/a.pdf", "Notes/sub/b.pdf", "Notes/_archive/old.pdf", "Notes/attached.pdf", "Notes/.hidden/x.pdf", "Notes/readme.md");
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: { csl: { type: "book", title: "Attached" }, attachments: [{ kind: "pdf", path: "Notes/attached.pdf" }] } }]);
    const resolved: string[] = [];
    const jobs = runner({
      resolvePdf: async (relativePath) => {
        resolved.push(relativePath);
        return result([candidateFor(relativePath, relativePath.includes("sub") ? { status: "unresolved" } : { status: "confirmed" })]);
      },
    });
    const job = await jobs.enqueue("Notes", "resolve-pdfs");
    assert.ok(job.state === "queued" || job.state === "running");
    assert.equal((await jobs.enqueue("Notes", "resolve-pdfs")).id, job.id, "asking again while it waits is the same job");
    await jobs.idle("Notes");
    assert.deepEqual(resolved.sort(), ["Notes/a.pdf", "Notes/sub/b.pdf"]);
    const [status] = await jobs.list("Notes");
    assert.equal(status.state, "done");
    assert.equal(status.total, 2);
    assert.equal(status.done, 2);
    assert.equal(status.failed, 0);
    assert.equal(status.createdEntryIds.length, 2);
    assert.ok(status.startedAt && status.finishedAt);
    const library = await readReferenceLibrary("Notes");
    assert.equal(library.revision, 3, "one transaction per file");
    const created = status.createdEntryIds.map((id) => library.entries[id]);
    assert.deepEqual(created.map((entry) => entry.status).sort(), ["needs-review", "unresolved"], "never confirmed automatically");
    assert.ok(created.every((entry) => entry.attachments[0].kind === "pdf" && /^[0-9a-f]{64}$/.test((entry.attachments[0] as { sha256?: string }).sha256 ?? "")));
    const stored = JSON.parse(await readFile(referenceJobsFilePath("Notes"), "utf8"));
    assert.equal(stored.jobs[0].state, "done");
  });
});

test("an exact identifier match attaches the PDF to the existing entry; a fuzzy match creates a new one", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/federer.pdf", "Notes/similar.pdf");
    const library = await updateReferenceLibrary("Notes", null, [
      { op: "add", entry: { csl: { type: "article-journal", title: "A self-organizing short-term dynamical memory network", DOI: "10.1016/j.neunet.2018.06.008" }, identifiers: { doi: "10.1016/j.neunet.2018.06.008" }, status: "confirmed" } },
    ]);
    const existingId = Object.keys(library.entries)[0];
    const pages: Record<string, string> = {
      "Notes/federer.pdf": "A self-organizing short-term dynamical memory network\nCallie Federer, Joel Zylberberg\ndoi:10.1016/j.neunet.2018.06.008",
    };
    const base = testOptions();
    const jobs = runner({
      resolveOptions: { http: base.http, now: base.now, pdf: { readText: async (relativePath) => ({ pages: [{ pageNumber: 1, text: pages[relativePath] ?? "" }] }), readMetadata: async () => ({ dois: [] }) } },
      resolvePdf: async (relativePath, options) => {
        if (relativePath === "Notes/similar.pdf") {
          // Same title, no identifier: a fuzzy duplicate.
          return { ...result([candidateFor(relativePath, { csl: { type: "article-journal", title: "A self-organizing short-term dynamical memory network" } })]) };
        }
        const { resolvePdf } = await import("../../src/lib/references/resolve/pipeline");
        return resolvePdf(relativePath, options);
      },
    });
    const job = await jobs.enqueue("Notes", "resolve-paths", { paths: ["Notes/federer.pdf", "Notes/similar.pdf"] });
    await jobs.idle("Notes");
    const [status] = await jobs.list("Notes");
    assert.equal(status.id, job.id);
    assert.deepEqual(status.updatedEntryIds, [existingId]);
    assert.equal(status.createdEntryIds.length, 1);
    const after = await readReferenceLibrary("Notes");
    assert.equal(Object.keys(after.entries).length, 2);
    assert.deepEqual(after.entries[existingId].attachments.map((attachment) => attachment.kind === "pdf" && attachment.path), ["Notes/federer.pdf"]);
    assert.equal(after.entries[existingId].status, "confirmed", "attaching leaves the entry as it was");
    const fuzzy = after.entries[status.createdEntryIds[0]];
    assert.equal(fuzzy.conflicts, undefined, "the fuzzy duplicate is left to the panel's Duplicates filter");
  });
});

test("the queue persists: an interrupted job resumes after a restart with only its unfinished files", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/a.pdf", "Notes/b.pdf");
    const first = runner({
      resolvePdf: (relativePath) => relativePath === "Notes/a.pdf"
        ? Promise.resolve(result([candidateFor(relativePath)]))
        : new Promise<ResolveResult>(() => undefined), // the app quits while this one is in progress
    });
    const job = await first.enqueue("Notes", "resolve-paths", { paths: ["Notes/a.pdf", "Notes/b.pdf"] });
    await until(async () => (await first.list("Notes"))[0].done === 1);
    await first.flush("Notes");
    const stored = JSON.parse(await readFile(referenceJobsFilePath("Notes"), "utf8"));
    assert.equal(stored.jobs[0].state, "running");
    assert.deepEqual(stored.jobs[0].pending, ["Notes/b.pdf"]);

    const resumedPaths: string[] = [];
    const second = runner({ resolvePdf: async (relativePath) => { resumedPaths.push(relativePath); return result([candidateFor(relativePath)]); } });
    await second.resumeAll();
    await second.idle("Notes");
    assert.deepEqual(resumedPaths, ["Notes/b.pdf"]);
    const [status] = await second.list("Notes");
    assert.equal(status.id, job.id);
    assert.equal(status.state, "done");
    assert.equal(status.done, 2);
    assert.equal(status.createdEntryIds.length, 2);
    assert.equal(Object.keys((await readReferenceLibrary("Notes")).entries).length, 2);
  });
});

test("cancelling keeps the files already resolved; a queued job is cancelled at once", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/a.pdf", "Notes/b.pdf", "Notes/c.pdf");
    let aborted = false;
    const resolvePdf = (relativePath: string, options: ResolveOptions) => {
      if (relativePath === "Notes/a.pdf") return Promise.resolve(result([candidateFor(relativePath)]));
      return new Promise<ResolveResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };
    const jobs = runner({ resolvePdf });
    const running = await jobs.enqueue("Notes", "resolve-paths", { paths: ["Notes/a.pdf", "Notes/b.pdf"] });
    const queued = await jobs.enqueue("Notes", "resolve-paths", { paths: ["Notes/c.pdf"] });
    await until(async () => (await jobs.list("Notes"))[0].done === 1);
    const cancelledQueued = await jobs.cancel("Notes", queued.id);
    assert.equal(cancelledQueued?.state, "cancelled");
    const cancelled = await jobs.cancel("Notes", running.id);
    assert.equal(cancelled?.state, "cancelled");
    assert.ok(aborted, "the lookup in progress was aborted");
    assert.equal(cancelled?.done, 1);
    assert.equal(cancelled?.failed, 0, "a cancelled file is not a failure");
    assert.equal(cancelled?.createdEntryIds.length, 1);
    const library = await readReferenceLibrary("Notes");
    assert.deepEqual(Object.values(library.entries).map((entry) => (entry.attachments[0] as { path: string }).path), ["Notes/a.pdf"]);
    assert.equal(await jobs.cancel("Notes", "job_unknown"), null);
  });
});

test("per-path errors are reported and only the last 20 finished jobs are kept", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/bad.pdf");
    const jobs = runner({ resolvePdf: async () => { throw new Error("The PDF is damaged."); } });
    await jobs.enqueue("Notes", "resolve-paths", { paths: ["Notes/bad.pdf", "Notes/notes.txt", "Other/x.pdf"] });
    await jobs.idle("Notes");
    const [status] = await jobs.list("Notes");
    assert.equal(status.failed, 3);
    assert.deepEqual([...status.errors].sort((a, b) => a.path.localeCompare(b.path)), [
      { path: "Notes/bad.pdf", message: "The PDF is damaged." },
      { path: "Notes/notes.txt", message: "Only PDF and Markdown files can be resolved." },
      { path: "Other/x.pdf", message: "The file is not in this notebook." },
    ]);
    for (let index = 0; index < 21; index += 1) await jobs.enqueue("Notes", "resolve-paths", { paths: ["Notes/notes.txt"] });
    await jobs.idle("Notes");
    const all = await jobs.list("Notes");
    assert.equal(all.length, 20);
    assert.ok(!all.some((job) => job.id === status.id), "the oldest finished job was dropped");
  });
});

test("new PDFs are batched into one automatic job when the notebook or the preference asks for it", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/one.pdf", "Notes/two.pdf");
    let preference = false;
    const jobs = new ReferenceJobRunner({
      settings: () => testSettings({ autoCreateForPdfs: preference }),
      listNotebooks: async () => ["Notes"],
      autoCreateDebounceMs: 150,
      resolvePdf: async (relativePath) => result([candidateFor(relativePath)]),
    });
    jobs.notifyFilesAdded(["Notes/one.pdf"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(await jobs.list("Notes"), [], "off by default");

    await updateReferenceLibrary("Notes", null, [{ op: "set-settings", settings: { autoCreateForPdfs: true } }]);
    jobs.notifyFilesAdded(["Notes/one.pdf"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    jobs.notifyFilesAdded(["Notes/two.pdf", "Notes/readme.md"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    jobs.notifyFilesAdded(["Notes/two.pdf"]);
    await until(async () => (await jobs.list("Notes")).length === 1);
    await jobs.idle("Notes");
    const [job] = await jobs.list("Notes");
    assert.equal(job.kind, "resolve-paths");
    assert.equal(job.total, 2, "one job for the burst");
    assert.equal(job.state, "done");

    preference = true;
    await updateReferenceLibrary("Notes", null, [{ op: "set-settings", settings: { autoCreateForPdfs: false } }]);
    assert.equal(await (jobs.notifyFilesAdded(["Notes/one.pdf"]), jobs.flushAutoCreate("Notes")), null, "the notebook's setting overrides the preference");
  });
});

test("uploading a PDF notifies the jobs runner", async () => {
  await withLibrary(async () => {
    const notified: string[][] = [];
    const spy = runner({});
    spy.notifyFilesAdded = (paths) => { notified.push(paths); };
    setReferenceJobRunner(spy);
    await writeUploadedFile("Notes", new File([new Uint8Array([37, 80, 68, 70])], "upload.pdf"));
    await writeUploadedFile("Notes", new File(["# note"], "note.md"));
    assert.deepEqual(notified, [["Notes/upload.pdf"]]);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });

function post(handler: (request: NextRequest) => Promise<Response>, url: string, body: unknown, authenticated = true) {
  return handler(new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authenticated ? cookie() : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("the jobs API checks auth and validates requests", async () => {
  await withLibrary(async () => {
    await addFiles("Notes/a.pdf");
    setReferenceJobRunner(runner({ resolvePdf: async (relativePath) => result([candidateFor(relativePath)]) }));
    const jobsUrl = "http://localhost/api/references/jobs";
    assert.equal((await getJobs(new NextRequest(`${jobsUrl}?notebook=Notes`))).status, 401);
    assert.equal((await post(postJobs, jobsUrl, { notebook: "Notes", action: "resolve-pdfs" }, false)).status, 401);
    assert.equal((await getJobs(new NextRequest(`${jobsUrl}?notebook=Missing`, { headers: cookie() }))).status, 404);
    assert.equal((await getJobs(new NextRequest(`${jobsUrl}?notebook=..%2Fx`, { headers: cookie() }))).status, 400);
    for (const [body, status] of [
      ["{ not json", 400],
      [{ action: "resolve-pdfs" }, 400],
      [{ notebook: "Notes", action: "explode" }, 400],
      [{ notebook: "Notes", action: "resolve-paths" }, 400],
      [{ notebook: "Notes", action: "resolve-paths", paths: ["Other/a.pdf"] }, 400],
      [{ notebook: "Notes", action: "resolve-paths", paths: ["Notes/../x.pdf"] }, 400],
      [{ notebook: "Notes", action: "resolve-paths", paths: ["Notes/a.docx"] }, 400],
      [{ notebook: "Notes", action: "resolve-pdfs", webSearch: "yes" }, 400],
      [{ notebook: "Notes", action: "cancel" }, 400],
      [{ notebook: "Notes", action: "cancel", jobId: "job_missing" }, 404],
      [{ notebook: "Missing", action: "resolve-pdfs" }, 404],
    ] as [unknown, number][]) {
      const response = await post(postJobs, jobsUrl, body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(typeof (await response.json()).error, "string");
    }
    const started = await post(postJobs, jobsUrl, { notebook: "Notes", action: "resolve-paths", paths: ["Notes/a.pdf"], webSearch: true });
    assert.equal(started.status, 200);
    const { job } = await started.json() as { job: ReferenceJobStatus };
    assert.equal(job.kind, "resolve-paths");
    assert.equal(job.webSearch, true);
    const listed = await getJobs(new NextRequest(`${jobsUrl}?notebook=Notes`, { headers: cookie() }));
    const { jobs } = await listed.json() as { jobs: ReferenceJobStatus[] };
    assert.equal(jobs[0].id, job.id);
    assert.deepEqual(Object.keys(jobs[0]).sort(), ["createdAt", "createdEntryIds", "done", "errors", "failed", "id", "kind", "notebook", "state", "total", "updatedEntryIds", "webSearch", ...(jobs[0].startedAt ? ["startedAt"] : []), ...(jobs[0].finishedAt ? ["finishedAt"] : []), ...(jobs[0].current ? ["current"] : [])].sort());
  });
});

test("the resolve API checks auth, validates input and never writes", async () => {
  await withLibrary(async () => {
    const keys = ["LIBERA_REFERENCES_LOOKUP_ONLINE", "LIBERA_REFERENCES_USE_AI", "LIBERA_CONFIG_PATH"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.LIBERA_REFERENCES_LOOKUP_ONLINE = "false";
    process.env.LIBERA_REFERENCES_USE_AI = "false";
    delete process.env.LIBERA_CONFIG_PATH;
    try {
      const url = "http://localhost/api/references/resolve";
      assert.equal((await post(postResolve, url, { notebook: "Notes", input: "10.1000/x" }, false)).status, 401);
      for (const [body, status] of [
        ["nope", 400],
        [{ input: "10.1000/x" }, 400],
        [{ notebook: "Notes" }, 400],
        [{ notebook: "Notes", input: "x", path: "Notes/a.pdf" }, 400],
        [{ notebook: "Notes", input: "   " }, 400],
        [{ notebook: "Notes", input: 5 }, 400],
        [{ notebook: "Notes", input: "x", webSearch: 1 }, 400],
        [{ notebook: "Notes", path: "Other/a.pdf" }, 400],
        [{ notebook: "Notes", path: "Notes/a.txt" }, 400],
        [{ notebook: "Missing", input: "10.1000/x" }, 404],
      ] as [unknown, number][]) {
        const response = await post(postResolve, url, body);
        assert.equal(response.status, status, JSON.stringify(body));
        assert.equal(typeof (await response.json()).error, "string");
      }
      const response = await post(postResolve, url, { notebook: "Notes", input: "doi:10.1000/xyz123" });
      assert.equal(response.status, 200);
      const payload = await response.json() as ResolveResult;
      assert.equal(payload.candidates.length, 1);
      assert.equal(payload.candidates[0].status, "unresolved");
      assert.equal(payload.candidates[0].identifiers?.doi, "10.1000/xyz123");
      assert.deepEqual(payload.duplicates, []);
      assert.ok(payload.warnings.some((warning) => /turned off/.test(warning)));
      assert.equal((await readReferenceLibrary("Notes")).revision, 0, "resolving writes nothing");
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  });
});
