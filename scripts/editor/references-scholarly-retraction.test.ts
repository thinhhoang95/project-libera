import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getLibrary } from "../../src/app/api/references/route";
import { POST as postRetractions } from "../../src/app/api/references/retractions/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { ReferenceJobRunner, RETRACTION_BATCH_SIZE, currentReferenceJobRunner, retractionStateFilePath, setReferenceJobRunner, type ReferenceJobRunnerDeps } from "../../src/lib/references/jobs";
import { RETRACTION_CHECK_INTERVAL_MS } from "../../src/lib/references/jobs-types";
import {
  checkRetraction,
  isConcerningRetraction,
  retractionChanged,
  retractionDescription,
  retractionFromCrossrefWork,
  retractionNoticeUrl,
  type CrossrefRetractionWork,
} from "../../src/lib/references/retraction";
import type { ReferenceLibraryOp } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";
import { fixture, testHttpClient, testSettings, type FetchLog } from "./references-resolve-helpers";
import type { FetchLike } from "../../src/lib/references/resolve/http";

// Retraction and correction checks: Crossref records (fixtures trimmed from
// the live API, plus representative ones for the other notice types), the
// check-retractions job, its schedule and route.

const CHECKED_AT = "2026-10-18T12:00:00.000Z";

function work(name: string): CrossrefRetractionWork {
  return (JSON.parse(fixture(name)) as { message: CrossrefRetractionWork }).message;
}

test("a retracted work: the retraction outranks the earlier correction, with the Retraction Watch notice", () => {
  const status = retractionFromCrossrefWork(work("crossref-retraction-retracted.json"), CHECKED_AT);
  assert.deepEqual(status, {
    state: "retracted",
    checkedAt: CHECKED_AT,
    notice: { doi: "10.1016/s0140-6736(10)60175-4", url: "https://doi.org/10.1016/s0140-6736(10)60175-4", date: "2010-02-06", label: "Retraction (Retraction Watch)" },
  });
  assert.equal(isConcerningRetraction(status), true);
  assert.equal(retractionNoticeUrl(status), "https://doi.org/10.1016/s0140-6736(10)60175-4");
  assert.equal(retractionDescription(status), "Retracted (Retraction (Retraction Watch), 2010-02-06)");
});

test("corrected, expression of concern and withdrawn works", () => {
  const corrected = retractionFromCrossrefWork(work("crossref-retraction-corrected.json"), CHECKED_AT);
  assert.equal(corrected.state, "corrected");
  assert.equal(corrected.notice?.doi, "10.1234/corrected.2019.1.corr2", "The newest notice of the same kind");
  assert.equal(corrected.notice?.label, "Correction");
  assert.equal(isConcerningRetraction(corrected), false);

  const concern = retractionFromCrossrefWork(work("crossref-retraction-concern.json"), CHECKED_AT);
  assert.equal(concern.state, "expression-of-concern", "A concern outranks a later correction");
  assert.equal(concern.notice?.date, "2022-08-09");
  assert.equal(isConcerningRetraction(concern), true);

  // Withdrawn in place: the work's own update-to names its own DOI.
  const withdrawn = retractionFromCrossrefWork(work("crossref-retraction-withdrawn.json"), CHECKED_AT);
  assert.deepEqual(withdrawn, { state: "withdrawn", checkedAt: CHECKED_AT, notice: { date: "2021-11-02", label: "Withdrawal" } });

  assert.deepEqual(retractionFromCrossrefWork(work("crossref-retraction-none.json"), CHECKED_AT), { state: "none", checkedAt: CHECKED_AT });
});

test("a notice is not its own target, reinstatements cancel retractions, titles and relations count", () => {
  // A retraction notice cites the work it retracts in update-to; the notice itself is fine.
  const notice = retractionFromCrossrefWork({ DOI: "10.1234/notice", title: ["Retraction notice"], "update-to": [{ DOI: "10.1234/original", type: "retraction" }] }, CHECKED_AT);
  assert.equal(notice.state, "none");
  const reinstated = retractionFromCrossrefWork({
    DOI: "10.1234/back",
    "updated-by": [
      { DOI: "10.1234/back.r", type: "retraction", updated: { "date-parts": [[2020, 1, 1]] } },
      { DOI: "10.1234/back.re", type: "reinstatement", updated: { "date-parts": [[2021, 1, 1]] } },
      { DOI: "10.1234/back.c", type: "Corrigendum", updated: { "date-parts": [[2021, 6, 1]] } },
    ],
  }, CHECKED_AT);
  assert.equal(reinstated.state, "corrected");
  const marked = retractionFromCrossrefWork({ DOI: "10.1234/m", title: ["RETRACTED ARTICLE: Something"] }, CHECKED_AT);
  assert.equal(marked.state, "retracted");
  const related = retractionFromCrossrefWork({ DOI: "10.1234/rel", relation: { "is-retracted-by": [{ "id-type": "doi", id: "10.1234/rel.notice" }] } }, CHECKED_AT);
  assert.equal(related.state, "retracted");
  assert.equal(related.notice?.doi, "10.1234/rel.notice");
  assert.equal(retractionChanged(reinstated, { ...reinstated, checkedAt: "2027-01-01T00:00:00.000Z" }), false, "Only state and notice count as changes");
  assert.equal(retractionChanged(undefined, reinstated), true);
});

/** Crossref for every DOI: a record from `records` (by DOI), else 404. */
function crossrefFetch(records: Record<string, CrossrefRetractionWork | ((doi: string) => CrossrefRetractionWork)>, log: FetchLog = []): FetchLike {
  return async (input, init) => {
    log.push({ url: input, init });
    const url = new URL(input);
    const doi = decodeURIComponent(url.pathname.replace(/^\/works\//, ""));
    const record = records[doi] ?? records["*"];
    if (url.host !== "api.crossref.org" || !record) return new Response("{}", { status: 404 });
    const message = typeof record === "function" ? record(doi) : record;
    return Response.json({ status: "ok", message });
  };
}

test("checkRetraction asks Crossref without caching, with the contact email, and returns null for unknown DOIs", async () => {
  const log: FetchLog = [];
  const http = testHttpClient(crossrefFetch({ "10.1016/s0140-6736(97)11096-0": work("crossref-retraction-retracted.json") }, log));
  const ctx = { http, now: () => new Date(CHECKED_AT), contactEmail: "me@example.org" };
  assert.equal((await checkRetraction("https://doi.org/10.1016/S0140-6736(97)11096-0", ctx))?.state, "retracted");
  assert.equal((await checkRetraction("10.1016/S0140-6736(97)11096-0", ctx))?.state, "retracted");
  assert.equal(log.length, 2, "Not cached: a notice can appear any day");
  assert.match(log[0].url, /mailto=me%40example.org/);
  assert.equal(await checkRetraction("10.5061/dryad.8515", ctx), null);
  assert.equal(await checkRetraction("not a doi", ctx), null);
});

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-retractions-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Notes");
    await run();
  } finally {
    const active = currentReferenceJobRunner();
    active?.dispose();
    await active?.idle("Notes");
    setReferenceJobRunner(undefined);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function addEntries(count: number, withoutDoi = 0) {
  const ops: ReferenceLibraryOp[] = [];
  for (let index = 0; index < count; index += 1) {
    ops.push({ op: "add", entry: { key: `paper${index}`, csl: { type: "article-journal", title: `Paper ${index}`, DOI: `10.1234/paper.${index}` }, identifiers: { doi: `10.1234/paper.${index}` } } });
  }
  for (let index = 0; index < withoutDoi; index += 1) ops.push({ op: "add", entry: { key: `book${index}`, csl: { type: "book", title: `Book ${index}` } } });
  return updateReferenceLibrary("Notes", null, ops);
}

type Clock = { now: Date };

function runner(clock: Clock, fetch: FetchLike, overrides: Partial<ReferenceJobRunnerDeps> = {}, writes: number[] = []) {
  return new ReferenceJobRunner({
    settings: () => testSettings({ useAi: false }),
    listNotebooks: async () => ["Notes"],
    now: () => clock.now,
    resolveOptions: { http: testHttpClient(fetch) },
    updateLibrary: (notebook, ops) => {
      writes.push(ops.length);
      return updateReferenceLibrary(notebook, null, ops);
    },
    ...overrides,
  });
}

const retracted = (doi: string): CrossrefRetractionWork => ({ DOI: doi, "updated-by": [{ DOI: `${doi}.notice`, type: "retraction", label: "Retraction", source: "publisher", updated: { "date-parts": [[2025, 3, 4]] } }] });

test("check-retractions checks every DOI and writes changed statuses in batches of 20", async () => {
  await withLibrary(async () => {
    await addEntries(25, 2);
    const clock = { now: new Date(CHECKED_AT) };
    const writes: number[] = [];
    const log: FetchLog = [];
    const jobs = runner(clock, crossrefFetch({ "*": retracted }, log), {}, writes);
    const { job } = await jobs.scheduleRetractionCheck("Notes");
    assert.ok(job);
    assert.equal(job.kind, "check-retractions");
    assert.equal(job.webSearch, false);
    await jobs.idle("Notes");
    const [finished] = await jobs.list("Notes");
    assert.equal(finished.state, "done");
    assert.equal(finished.total, 25, "Entries without a DOI are not checked");
    assert.equal(finished.done, 25);
    assert.equal(finished.failed, 0);
    assert.equal(finished.updatedEntryIds.length, 25);
    assert.equal(log.length, 25);
    assert.deepEqual(writes, [RETRACTION_BATCH_SIZE, 5], "One transaction per 20 update ops");
    const library = await readReferenceLibrary("Notes");
    const paper = Object.values(library.entries).find((entry) => entry.key === "paper3")!;
    assert.deepEqual(paper.retraction, { state: "retracted", checkedAt: CHECKED_AT, notice: { doi: "10.1234/paper.3.notice", url: "https://doi.org/10.1234/paper.3.notice", date: "2025-03-04", label: "Retraction" } });
    assert.equal(Object.values(library.entries).find((entry) => entry.key === "book0")!.retraction, undefined);
    const state = JSON.parse(await readFile(retractionStateFilePath("Notes"), "utf8"));
    assert.deepEqual(state, { version: 1, lastCheckedAt: CHECKED_AT });

    // A forced re-check with the same answers writes nothing.
    writes.length = 0;
    clock.now = new Date(Date.parse(CHECKED_AT) + 60_000);
    const again = await jobs.scheduleRetractionCheck("Notes", { force: true });
    assert.ok(again.job);
    await jobs.idle("Notes");
    assert.deepEqual(writes, []);
    assert.equal((await jobs.list("Notes")).at(-1)?.updatedEntryIds.length, 0);
  });
});

test("checks run at most once per 7 days unless forced, and only with online lookups on", async () => {
  await withLibrary(async () => {
    const clock = { now: new Date(CHECKED_AT) };
    const fetch = crossrefFetch({ "*": (doi) => ({ DOI: doi }) });
    let lookupOnline = true;
    const jobs = runner(clock, fetch, { settings: () => testSettings({ useAi: false, lookupOnline }) });
    assert.deepEqual(await jobs.scheduleRetractionCheck("Notes"), { job: null, skipped: "no-dois" }, "Nothing to check");
    await addEntries(2);
    const first = await jobs.scheduleRetractionCheck("Notes");
    assert.ok(first.job);
    // Asked again while it runs: the same job.
    assert.equal((await jobs.scheduleRetractionCheck("Notes", { force: true })).job?.id, first.job.id);
    await jobs.idle("Notes");

    clock.now = new Date(Date.parse(CHECKED_AT) + RETRACTION_CHECK_INTERVAL_MS - 1);
    const early = await jobs.scheduleRetractionCheck("Notes");
    assert.deepEqual(early, { job: null, lastCheckedAt: CHECKED_AT, skipped: "not-due" });
    const forced = await jobs.scheduleRetractionCheck("Notes", { force: true });
    assert.ok(forced.job, "force skips the 7-day rule");
    await jobs.idle("Notes");

    clock.now = new Date(Date.parse(CHECKED_AT) + 2 * RETRACTION_CHECK_INTERVAL_MS);
    lookupOnline = false;
    assert.equal((await jobs.scheduleRetractionCheck("Notes", { force: true })).skipped, "lookups-off");
    lookupOnline = true;
    const due = await jobs.scheduleRetractionCheck("Notes");
    assert.ok(due.job, "Due again after 7 days");
    await jobs.idle("Notes");
    assert.equal((await jobs.list("Notes")).filter((job) => job.kind === "check-retractions").length, 3);
  });
});

test("a check started before lookups were turned off fails, one with lookup errors reports them, cancel keeps what was found", async () => {
  await withLibrary(async () => {
    await addEntries(3);
    const clock = { now: new Date(CHECKED_AT) };
    let lookupOnline = true;
    const offline = runner(clock, crossrefFetch({ "*": retracted }), { settings: () => testSettings({ useAi: false, lookupOnline }) });
    const queued = await offline.enqueue("Notes", "check-retractions");
    lookupOnline = false;
    await offline.idle("Notes");
    const failed = (await offline.list("Notes")).find((job) => job.id === queued.id)!;
    assert.equal(failed.state, "failed");
    assert.match(failed.errors[0].message, /Online lookups are turned off/);
    offline.dispose();

    const broken = runner(clock, async () => new Response("nope", { status: 400 }));
    await broken.enqueue("Notes", "check-retractions");
    await broken.idle("Notes");
    const [, withErrors] = await broken.list("Notes");
    assert.equal(withErrors.state, "done");
    assert.equal(withErrors.failed, 3);
    assert.deepEqual(withErrors.errors.map((error) => error.path).sort(), ["paper0", "paper1", "paper2"]);

    // Cancelling while lookups hang: entries found so far stay, the job is cancelled.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slow = runner(clock, async (input, init) => {
      calls += 1;
      if (calls > 1) {
        await Promise.race([gate, new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))]);
      }
      const doi = decodeURIComponent(new URL(input).pathname.replace(/^\/works\//, ""));
      return Response.json({ message: retracted(doi) });
    });
    const job = await slow.enqueue("Notes", "check-retractions");
    for (let tries = 0; calls < 2 && tries < 500; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = await slow.cancel("Notes", job.id);
    release();
    assert.equal(cancelled?.state, "cancelled");
    const library = await readReferenceLibrary("Notes");
    assert.equal(Object.values(library.entries).filter((entry) => entry.retraction?.state === "retracted").length, 1, "The finished lookup was written");
  });
});

const cookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });

function post(body: unknown) {
  return new NextRequest("http://localhost/api/references/retractions", { method: "POST", headers: { "content-type": "application/json", ...cookie() }, body: JSON.stringify(body) });
}

test("POST /api/references/retractions enqueues the job; reading the library starts a due check once", async () => {
  await withLibrary(async () => {
    await addEntries(2);
    const clock = { now: new Date(CHECKED_AT) };
    const log: FetchLog = [];
    let lookupOnline = true;
    const jobs = runner(clock, crossrefFetch({ "*": retracted }, log), { settings: () => testSettings({ useAi: false, lookupOnline }) });
    setReferenceJobRunner(jobs);

    const unauthorized = await postRetractions(new NextRequest("http://localhost/api/references/retractions", { method: "POST", body: "{}" }));
    assert.equal(unauthorized.status, 401);
    assert.equal((await postRetractions(post({ notebook: "Nope" }))).status, 404);
    assert.equal((await postRetractions(post({ notebook: "Notes", force: "yes" }))).status, 400);

    // Opening the library starts the first check without waiting for it.
    const opened = await getLibrary(new NextRequest("http://localhost/api/references?notebook=Notes", { headers: cookie() }));
    assert.equal(opened.status, 200);
    for (let tries = 0; !(await jobs.list("Notes")).length && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await jobs.idle("Notes");
    assert.equal((await jobs.list("Notes")).length, 1);
    assert.equal(log.length, 2);
    // A second read within the debounce window does nothing, even a week later.
    clock.now = new Date(Date.parse(CHECKED_AT) + 60_000);
    assert.equal(jobs.requestRetractionCheck("Notes"), null);

    const notDue = await postRetractions(post({ notebook: "Notes" }));
    assert.deepEqual(await notDue.json(), { job: null, lastCheckedAt: CHECKED_AT, skipped: "not-due" });
    const forced = await postRetractions(post({ notebook: "Notes", force: true }));
    assert.equal(forced.status, 200);
    const { job } = await forced.json() as { job: { kind: string; state: string } };
    assert.equal(job.kind, "check-retractions");
    await jobs.idle("Notes");

    lookupOnline = false;
    const off = await postRetractions(post({ notebook: "Notes", force: true }));
    assert.equal(off.status, 409);
    assert.match((await off.json()).error, /Online lookups are turned off/);
  });
});
