import assert from "node:assert/strict";
import { mock, test } from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NextRequest } from "next/server";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { GET as getEvents } from "../../src/app/api/references/events/route";
import { useBibTether } from "../../src/components/libera/references/use-bib-tether";
import { resetReferenceLibraryCache, useReferenceLibrary } from "../../src/components/libera/references/use-reference-library";
import { BibTetherDialog } from "../../src/components/libera/references/bib-tether-dialog";
import type { TetherStatus } from "../../src/lib/references/bib-tether-types";
import { REFERENCES_UPDATED_EVENT } from "../../src/lib/references/types";
import { GET as getTether, POST as postTether } from "../../src/app/api/references/bib-tether/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import {
  BIB_TETHER_DEBOUNCE_MS,
  BIB_TETHER_SETTLE_MS,
  bibTetherStatePath,
  checkTether,
  getTetherStatus,
  moveTetheredFiles,
  previewTether,
  recreateTetheredFile,
  requestTetherSync,
  resetBibTethers,
  settleBibTether,
  tetherBibFile,
  tetherTargetFor,
  untetherBibFile,
} from "../../src/lib/references/bib-tether";
import { resetBibMirrorScheduler, writeBibMirror } from "../../src/lib/references/bib-mirror";
import { parseBibtex } from "../../src/lib/references/bibtex";
import { publishReferenceEvent, subscribeReferenceEvents, type ReferenceServerEvent } from "../../src/lib/references/library-events";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath, referenceLibraryPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";

// The tethered .bib on a real disk: tethering, both directions through the
// watcher and the debounce, atomic writes through symlinks with permissions
// kept, a file that disappears and comes back, unreadable files, and the route.

async function withLibrary(run: (directory: string) => Promise<void>) {
  const directory = await fsp.realpath(await mkdtemp(path.join(os.tmpdir(), "libera-bib-tether-")));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(directory, "data");
  try {
    await createNotebook("Notes");
    await run(directory);
  } finally {
    await settleBibTether("Notes").catch(() => undefined);
    resetBibTethers();
    resetBibMirrorScheduler();
    mock.restoreAll();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const SMITH = { key: "smith2020", csl: { type: "article-journal" as const, title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] as Array<[number]> }, "container-title": "Journal of Tests" } };
const DOE_BIB = "% Doe's refs\n@book{doe2019,\n  author = {Doe, John},\n  title = {A book},\n  year = {2019},\n  publisher = {Press},\n  owner = {jd}\n}\n";

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeout = 5_000): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await delay(50);
  }
}

// Some sandboxed macOS runners cannot create FSEvents watches (EMFILE).
// Exercise their supported focus fallback; callbacks themselves are tested below.
async function checkIfUnwatched() {
  await delay(30);
  if (!(await getTetherStatus("Notes"))?.watching) await checkTether("Notes");
}

const keysOf = async () => Object.values((await readReferenceLibrary("Notes")).entries).map((entry) => entry.key).sort();

test("paths: inside the notebook they stay relative, elsewhere absolute; only .bib files", async () => {
  await withLibrary(async (directory) => {
    const inside = path.join(notebookPath("Notes"), "tex", "refs.bib");
    assert.deepEqual(tetherTargetFor("Notes", inside), { kind: "notebook", path: "tex/refs.bib" });
    assert.deepEqual(tetherTargetFor("Notes", "Notes/tex/refs.bib"), { kind: "notebook", path: "tex/refs.bib" });
    const outside = path.join(directory, "elsewhere", "refs.bib");
    assert.deepEqual(tetherTargetFor("Notes", outside), { kind: "absolute", path: outside });
    assert.throws(() => tetherTargetFor("Notes", path.join(directory, "refs.txt")), /Only \.bib/);
    assert.throws(() => tetherTargetFor("Notes", path.join(notebookPath("Notes"), ".libera", "x.bib")), /Libera's own folders/);
    assert.throws(() => tetherTargetFor("Notes", "../../etc/x.bib"));
  });
});

test("tethering merges both sides, then file edits reach the library and library edits reach the file", async () => {
  await withLibrary(async (directory) => {
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    const file = path.join(directory, "thesis", "refs.bib");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, DOE_BIB);

    const preview = await previewTether("Notes", file);
    assert.equal(preview.toLibrary, 1);
    assert.equal(preview.toFile, 1);
    assert.equal(preview.exists, true);

    const status = await tetherBibFile("Notes", file, { prefer: "library" });
    assert.equal(status?.state, "synced");
    assert.equal(status?.entries, 2);
    assert.deepEqual(await keysOf(), ["doe2019", "smith2020"]);
    let text = await readFile(file, "utf8");
    assert.ok(text.startsWith(DOE_BIB.trimEnd()), "the user's entry is untouched");
    assert.match(text, /@article\{smith2020,/);

    // The file is edited elsewhere: the watcher picks it up.
    await writeFile(file, text.replace("{A book}", "{A better book}"));
    await checkIfUnwatched();
    await waitFor(async () => Object.values((await readReferenceLibrary("Notes")).entries).find((entry) => entry.csl.title === "A better book"), "the file edit in the library");

    // The library changes: the file follows after the debounce, in one write.
    const library = await readReferenceLibrary("Notes");
    const smith = Object.values(library.entries).find((entry) => entry.key === "smith2020")!;
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: smith.id, csl: { volume: "12" } }]);
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: smith.id, csl: { page: "1-9" } }]);
    await delay(BIB_TETHER_DEBOUNCE_MS / 2);
    assert.doesNotMatch(await readFile(file, "utf8"), /volume/, "not written before the debounce");
    text = await waitFor(async () => { const value = await readFile(file, "utf8"); return /pages\s*=\s*\{1-{1,2}9\}/.test(value) && value; }, "the library edits in the file");
    assert.match(text, /volume\s*=\s*\{12\}/);
    assert.match(text, /owner = \{jd\}/);
    assert.equal(parseBibtex(text).errors.length, 0);
  });
});

test("an untouched sync does not write; a file deleted outside pauses without touching the library, and can be recreated", async () => {
  await withLibrary(async (directory) => {
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    const file = path.join(directory, "refs.bib");
    await tetherBibFile("Notes", file, { prefer: "library", create: true });
    const before = await stat(file);
    await delay(20);
    const again = await requestTetherSync("Notes");
    assert.equal(again?.state, "synced");
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs, "nothing was rewritten");

    await rm(file);
    await checkIfUnwatched();
    const missing = await waitFor(async () => { const value = await getTetherStatus("Notes"); return value?.state === "missing" && value; }, "the missing state");
    assert.match(missing.message ?? "", /deleted or moved/);
    assert.deepEqual(await keysOf(), ["smith2020"], "the library keeps its entries");

    const recreated = await recreateTetheredFile("Notes");
    assert.equal(recreated?.state, "synced");
    assert.match(await readFile(file, "utf8"), /smith2020/);
  });
});

test("a file emptied outside asks before deleting the library, and restore puts the entries back", async () => {
  await withLibrary(async (directory) => {
    const ops = Array.from({ length: 6 }, (_, index) => ({ op: "add" as const, entry: { key: `k${index}`, csl: { type: "book" as const, title: `Book ${index}` } } }));
    await updateReferenceLibrary("Notes", null, ops);
    const file = path.join(directory, "refs.bib");
    await tetherBibFile("Notes", file, { prefer: "library", create: true });
    await writeFile(file, "");
    await checkIfUnwatched();
    const paused = await waitFor(async () => { const value = await getTetherStatus("Notes"); return value?.state === "paused" && value; }, "the paused state");
    assert.equal(paused.pendingDeletion?.count, 6);
    assert.equal((await keysOf()).length, 6);
    const restored = await requestTetherSync("Notes", { deletions: "restore", deletionToken: paused.pendingDeletion!.token });
    assert.equal(restored?.state, "synced");
    assert.equal(parseBibtex(await readFile(file, "utf8")).entries.length, 6);
  });
});

test("writes go through a symlink and keep the file's permissions", { skip: process.platform === "win32" }, async () => {
  await withLibrary(async (directory) => {
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    const real = path.join(directory, "real", "refs.bib");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, "");
    await chmod(real, 0o600);
    const link = path.join(directory, "link.bib");
    await symlink(real, link);
    await tetherBibFile("Notes", link, { prefer: "library" });
    assert.ok((await stat(link)).isFile());
    assert.match(await readFile(real, "utf8"), /smith2020/);
    assert.equal((await stat(real)).mode & 0o777, 0o600);
    // The link is still a link.
    const { lstat } = await import("node:fs/promises");
    assert.ok((await lstat(link)).isSymbolicLink());
  });
});

test("a file that is not UTF-8 is refused, and an unreadable block deletes nothing", async () => {
  await withLibrary(async (directory) => {
    const latin1 = path.join(directory, "latin1.bib");
    await writeFile(latin1, Buffer.from("@book{a,\n  title = {Caf\xe9}\n}\n", "latin1"));
    await assert.rejects(tetherBibFile("Notes", latin1, { prefer: "library" }), /not UTF-8/);
    assert.equal(await getTetherStatus("Notes"), null);

    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }, { op: "add", entry: { key: "lee2021", csl: { type: "book", title: "Lee" } } }]);
    const file = path.join(directory, "refs.bib");
    await tetherBibFile("Notes", file, { prefer: "library", create: true });
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/@book\{lee2021,/, "@book{lee2021,\n  title = {unclosed,"));
    await checkIfUnwatched();
    const warned = await waitFor(async () => { const value = await getTetherStatus("Notes"); return value?.warnings.some((warning) => warning.includes("could not be read")) && value; }, "the parse warning");
    assert.equal(warned.state, "error");
    assert.deepEqual(await keysOf(), ["lee2021", "smith2020"]);
  });
});

test("check notices a change the watcher missed; untether stops syncing and keeps both sides", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    resetBibTethers(); // As after a restart: no watcher yet.
    await writeFile(file, DOE_BIB.replace("{Press}", "{New Press}"));
    const checked = await checkTether("Notes");
    assert.equal(checked?.state, "synced");
    assert.equal(Object.values((await readReferenceLibrary("Notes")).entries)[0].csl.publisher, "New Press");

    const events: ReferenceServerEvent[] = [];
    const unsubscribe = subscribeReferenceEvents((event) => events.push(event));
    await untetherBibFile("Notes");
    unsubscribe();
    assert.ok(events.some((event) => event.type === "tether" && event.status === null));
    await assert.rejects(readFile(bibTetherStatePath("Notes")));
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    await delay(BIB_TETHER_DEBOUNCE_MS + 300);
    assert.doesNotMatch(await readFile(file, "utf8"), /smith2020/);
  });
});

test("the route: auth, validation, preview, tether, status", async () => {
  await withLibrary(async (directory) => {
    const cookie = { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` };
    const post = (body: unknown, headers: Record<string, string> = cookie) => postTether(new NextRequest("http://localhost/api/references/bib-tether", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    assert.equal((await post({ notebook: "Notes", action: "sync" }, {})).status, 401);
    assert.equal((await post({ notebook: "Notes", action: "explode" })).status, 400);
    assert.equal((await post({ notebook: "Notes", action: "tether", path: path.join(directory, "x.bib"), prefer: "both" })).status, 400);
    assert.equal((await post({ notebook: "Notes", action: "tether", path: path.join(directory, "missing.bib"), prefer: "library" })).status, 404);
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    const preview = await (await post({ notebook: "Notes", action: "preview", path: file })).json() as { preview: { toLibrary: number } };
    assert.equal(preview.preview.toLibrary, 1);
    const tethered = await (await post({ notebook: "Notes", action: "tether", path: file, prefer: "library" })).json() as { tether: { state: string; fileName: string } };
    assert.equal(tethered.tether.state, "synced");
    assert.equal(tethered.tether.fileName, "refs.bib");
    const status = await (await getTether(new NextRequest("http://localhost/api/references/bib-tether?notebook=Notes", { headers: cookie }))).json() as { tether: { entries: number } };
    assert.equal(status.tether.entries, 1);
  });
});

test("CAS is checked after fsync, before any library commit, even with an old external mtime", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const entry = Object.values((await readReferenceLibrary("Notes")).entries)[0];
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: entry.id, csl: { volume: "3" } }]);
    await writeFile(file, DOE_BIB.replace("{Press}", "{First external}"));
    const originalOpen = fsp.open;
    let intervened = false;
    mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".libera-refs.bib.") && !intervened) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          intervened = true;
          await writeFile(file, DOE_BIB.replace("{Press}", "{Second external}").replace("{A book}", "{A new book}"));
          await fsp.utimes(file, new Date(0), new Date(0));
        };
      }
      return handle;
    });
    const events: ReferenceServerEvent[] = [];
    const unsubscribe = subscribeReferenceEvents((event) => events.push(event));
    const status = await requestTetherSync("Notes");
    unsubscribe();
    assert.equal(intervened, true);
    assert.equal(status?.state, "synced");
    const final = (await readReferenceLibrary("Notes")).entries[entry.id];
    assert.equal(final.csl.publisher, "Second external");
    assert.equal(final.csl.title, "A new book");
    assert.equal(final.csl.volume, "3");
    assert.equal(final.conflicts, undefined);
    assert.equal(events.filter((event) => event.type === "library").length, 1);
    assert.match(await readFile(file, "utf8"), /Second external/);
  });
});

test("a refused file write leaves incoming library changes and the sync base uncommitted", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const entry = Object.values((await readReferenceLibrary("Notes")).entries)[0];
    const edited = await updateReferenceLibrary("Notes", null, [{ op: "update", id: entry.id, csl: { volume: "3" } }]);
    await writeFile(file, DOE_BIB.replace("{Press}", "{External Press}"));
    const base = JSON.parse(await readFile(bibTetherStatePath("Notes"), "utf8")).base;
    const originalRename = fsp.rename;
    const failure = mock.method(fsp, "rename", async (...args: Parameters<typeof fsp.rename>) => {
      if (String(args[0]).includes(".libera-refs.bib.")) throw Object.assign(new Error("full"), { code: "ENOSPC" });
      return originalRename(...args);
    });
    assert.equal((await requestTetherSync("Notes"))?.state, "error");
    assert.deepEqual(await readReferenceLibrary("Notes"), edited);
    assert.deepEqual(JSON.parse(await readFile(bibTetherStatePath("Notes"), "utf8")).base, base);
    failure.mock.restore();
    assert.equal((await requestTetherSync("Notes"))?.state, "synced");
    const final = (await readReferenceLibrary("Notes")).entries[entry.id];
    assert.equal(final.csl.publisher, "External Press");
    assert.equal(final.conflicts, undefined);
  });
});

test("a file appearing during exclusive creation is merged instead of overwritten", async () => {
  await withLibrary(async (directory) => {
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    const file = path.join(directory, "refs.bib");
    const originalLink = fsp.link;
    let raced = false;
    mock.method(fsp, "link", async (...args: Parameters<typeof fsp.link>) => {
      if (!raced && String(args[1]) === file) { raced = true; await writeFile(file, DOE_BIB); }
      return originalLink(...args);
    });
    assert.equal((await tetherBibFile("Notes", file, { prefer: "library", create: true }))?.state, "synced");
    assert.equal(raced, true);
    assert.deepEqual(await keysOf(), ["doe2019", "smith2020"]);
    assert.match(await readFile(file, "utf8"), /owner = \{jd\}/);
  });
});

test("exclusive new-file creation works on file systems without hard links", async () => {
  await withLibrary(async (directory) => {
    mock.method(fsp, "link", async () => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); });
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    const file = path.join(directory, "refs.bib");
    assert.equal((await tetherBibFile("Notes", file, { prefer: "library", create: true }))?.state, "synced");
    assert.match(await readFile(file, "utf8"), /smith2020/);
  });
});

test("focus catches same-size changes whose mtime was preserved, without rewriting settled state", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const before = await stat(file);
    await writeFile(file, DOE_BIB.replace("{Press}", "{Other}"));
    await fsp.utimes(file, before.atime, before.mtime);
    await checkTether("Notes");
    assert.equal(Object.values((await readReferenceLibrary("Notes")).entries)[0].csl.publisher, "Other");
    const stateBefore = await stat(bibTetherStatePath("Notes"));
    const libraryBefore = await stat(referenceLibraryPath("Notes"));
    const fileBefore = await stat(file);
    await checkTether("Notes");
    assert.equal((await stat(bibTetherStatePath("Notes"))).mtimeMs, stateBefore.mtimeMs);
    assert.equal((await stat(referenceLibraryPath("Notes"))).mtimeMs, libraryBefore.mtimeMs);
    assert.equal((await stat(file)).mtimeMs, fileBefore.mtimeMs);
  });
});

test("pending deletion approval cannot apply to a file edited after the dialog was shown", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    await writeFile(file, "");
    const paused = await requestTetherSync("Notes");
    assert.equal(paused?.state, "paused");
    await writeFile(file, "% another edit\n");
    const result = await requestTetherSync("Notes", { deletions: "apply", deletionToken: paused!.pendingDeletion!.token });
    assert.equal(result?.state, "error");
    assert.deepEqual(await keysOf(), ["doe2019"]);
    const reviewed = await requestTetherSync("Notes");
    const restored = await requestTetherSync("Notes", { deletions: "restore", deletionToken: reviewed!.pendingDeletion!.token });
    assert.equal(restored?.state, "synced");
    assert.match(await readFile(file, "utf8"), /owner = \{jd\}/);
  });
});

test("recreating a missing file retains its saved custom fields", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    await rm(file);
    assert.equal((await recreateTetheredFile("Notes"))?.state, "synced");
    assert.match(await readFile(file, "utf8"), /owner = \{jd\}/);
  });
});

test("symlinks cannot bypass extension or system-folder validation, including new files", { skip: process.platform === "win32" }, async () => {
  await withLibrary(async (directory) => {
    const system = path.join(directory, ".LiBeRa-private");
    await mkdir(system);
    const hidden = path.join(system, "refs.bib");
    await writeFile(hidden, DOE_BIB);
    const alias = path.join(directory, "safe.bib");
    await symlink(hidden, alias);
    await assert.rejects(tetherBibFile("Notes", alias, { prefer: "library" }), /own folders/);
    const text = path.join(directory, "notes.txt");
    await writeFile(text, DOE_BIB);
    await rm(alias);
    await symlink(text, alias);
    await assert.rejects(previewTether("Notes", alias), /Only \.bib/);
    await rm(alias);
    await symlink(system, path.join(directory, "safe-folder"));
    await assert.rejects(tetherBibFile("Notes", path.join(directory, "safe-folder", "new.bib"), { prefer: "library", create: true }), /own folders/);
    await symlink(path.join(directory, "gone.bib"), alias);
    await assert.rejects(tetherBibFile("Notes", alias, { prefer: "library", create: true }), /symbolic link is broken/);
    assert.equal(await readFile(hidden, "utf8"), DOE_BIB);
    assert.equal(await readFile(text, "utf8"), DOE_BIB);
  });
});

test("corrupt/newer sync state stays in place; a missing or quarantined library never deletes the file", async () => {
  await withLibrary(async (directory) => {
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const state = await readFile(bibTetherStatePath("Notes"), "utf8");
    for (const bad of ['{"version":2}', JSON.stringify({ ...JSON.parse(state), base: { ...JSON.parse(state).base, entries: { bad: null } } })]) {
      await writeFile(bibTetherStatePath("Notes"), bad);
      await assert.rejects(getTetherStatus("Notes"), /damaged or from a newer/);
      assert.equal(await readFile(bibTetherStatePath("Notes"), "utf8"), bad);
      assert.equal(await readFile(file, "utf8"), DOE_BIB);
    }
    await writeFile(bibTetherStatePath("Notes"), state);
    await writeFile(referenceLibraryPath("Notes"), "{broken");
    assert.equal((await requestTetherSync("Notes"))?.state, "error");
    assert.equal(await readFile(file, "utf8"), DOE_BIB);
  });
});

test("the generated mirror yields to a tether on its main or fallback output", async () => {
  await withLibrary(async () => {
    const library = await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }, { op: "set-settings", settings: { bibMirror: true } }]);
    for (const name of ["references.bib", "references.libera.bib"]) {
      const file = path.join(notebookPath("Notes"), name);
      await writeFile(file, DOE_BIB);
      await tetherBibFile("Notes", file, { prefer: "file" });
      const before = await readFile(file, "utf8");
      assert.equal((await writeBibMirror("Notes", library)).status, "disabled");
      assert.equal(await readFile(file, "utf8"), before);
      await untetherBibFile("Notes");
    }
  });
});

class Watcher extends EventEmitter {
  closed = false;
  constructor(readonly directory: string, readonly changed: (event: string, name: string) => void) { super(); }
  close() { this.closed = true; }
}

function fakeWatchers() {
  const watchers: Watcher[] = [];
  mock.method(fs, "watch", (directory: string, _options: unknown, changed: Watcher["changed"]) => {
    const watcher = new Watcher(directory, changed);
    watchers.push(watcher);
    return watcher;
  });
  return {
    watchers,
    emit(directory: string, name: string) {
      const active = watchers.filter((watcher) => !watcher.closed && watcher.directory === directory);
      assert.ok(active.length, `watching ${directory}`);
      for (const watcher of active) watcher.changed("rename", name);
    },
  };
}

test("watch callbacks survive atomic saves, symlink retargeting, and a folder disappearing and returning", { skip: process.platform === "win32" }, async () => {
  await withLibrary(async (directory) => {
    const watched = fakeWatchers();
    const folder = path.join(directory, "folder");
    const otherFolder = path.join(directory, "other");
    await mkdir(folder);
    await mkdir(otherFolder);
    const file = path.join(folder, "refs.bib");
    const other = path.join(otherFolder, "other.bib");
    const alias = path.join(directory, "link.bib");
    await writeFile(file, DOE_BIB);
    await writeFile(other, DOE_BIB.replace("{Press}", "{Other Press}"));
    await symlink(file, alias);
    await tetherBibFile("Notes", alias, { prefer: "file" });
    const temporary = path.join(folder, "saved.bib");
    await writeFile(temporary, DOE_BIB.replace("{Press}", "{Atomic Press}"));
    await fsp.rename(temporary, file);
    watched.emit(folder, "refs.bib");
    await settleBibTether("Notes");
    assert.equal(Object.values((await readReferenceLibrary("Notes")).entries)[0].csl.publisher, "Atomic Press");
    await rm(alias);
    await symlink(other, alias);
    watched.emit(directory, "link.bib");
    await settleBibTether("Notes");
    assert.equal(Object.values((await readReferenceLibrary("Notes")).entries)[0].csl.publisher, "Other Press");
    assert.ok(watched.watchers.some((watcher) => watcher.directory === otherFolder && !watcher.closed));

    await untetherBibFile("Notes");
    await tetherBibFile("Notes", file, { prefer: "file" });
    await rm(folder, { recursive: true });
    watched.emit(folder, "folder");
    await settleBibTether("Notes");
    assert.equal((await getTetherStatus("Notes"))?.state, "missing");
    await mkdir(folder);
    await writeFile(file, DOE_BIB.replace("{Press}", "{Returned Press}"));
    watched.emit(directory, "folder");
    await settleBibTether("Notes");
    assert.equal((await getTetherStatus("Notes"))?.state, "synced");
    assert.equal(Object.values((await readReferenceLibrary("Notes")).entries)[0].csl.publisher, "Returned Press");
  });
});

test("two notebooks writing one target serialize their merges and converge", async () => {
  await withLibrary(async (directory) => {
    fakeWatchers();
    await createNotebook("Other");
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    await tetherBibFile("Other", file, { prefer: "file" });
    await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
    await updateReferenceLibrary("Other", null, [{ op: "add", entry: { key: "lee2021", csl: { type: "book", title: "Lee" } } }]);
    await Promise.all([requestTetherSync("Notes"), requestTetherSync("Other")]);
    await Promise.all([checkTether("Notes"), checkTether("Other")]);
    assert.deepEqual(await keysOf(), ["doe2019", "lee2021", "smith2020"]);
    assert.equal(parseBibtex(await readFile(file, "utf8")).entries.length, 3);
    const revision = (await readReferenceLibrary("Notes")).revision;
    await Promise.all([checkTether("Notes"), checkTether("Other")]);
    assert.equal((await readReferenceLibrary("Notes")).revision, revision);
    await settleBibTether("Other");
  });
});

test("dormant tethers follow moves, and a notebook rename leaves no old notebook behind", async () => {
  await withLibrary(async () => {
    fakeWatchers();
    const file = path.join(notebookPath("Notes"), "old.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    resetBibTethers();
    await fsp.rename(file, path.join(notebookPath("Notes"), "new.bib"));
    await moveTetheredFiles("Notes/old.bib", "Notes/new.bib");
    await settleBibTether("Notes");
    assert.equal((await getTetherStatus("Notes"))?.displayPath, "Notes/new.bib");
    const oldRoot = notebookPath("Notes");
    await fsp.rename(oldRoot, notebookPath("Renamed"));
    await moveTetheredFiles("Notes", "Renamed");
    await settleBibTether("Renamed");
    assert.equal((await getTetherStatus("Renamed"))?.displayPath, "Renamed/new.bib");
    assert.equal(await requestTetherSync("Notes"), null);
    await assert.rejects(stat(oldRoot), { code: "ENOENT" });
    await untetherBibFile("Renamed");
  });
});

test("Electron reference IPC accepts only the app's main frame and reveals files only", async () => {
  const source = await readFile(path.join(process.cwd(), "electron/main.cjs"), "utf8");
  const start = source.indexOf("function installDirectoryModeHandlers()");
  const end = source.indexOf("function installApplicationMenu()", start);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const profileSession = {};
  const mainFrame = { url: "http://localhost/app" };
  const sender = { session: profileSession, mainFrame };
  const mainWindow = { isDestroyed: () => false };
  let revealed = 0;
  vm.runInNewContext(source.slice(start, end) + "\ninstallDirectoryModeHandlers();", {
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
    BrowserWindow: { fromWebContents: (contents: unknown) => contents === sender ? mainWindow : null },
    mainWindow, childWindows: new Set(), getProfileSession: () => profileSession, nextServerUrl: "http://localhost",
    isSameOrigin: (left: string, right: string) => new URL(left).origin === new URL(right).origin,
    fs: { statSync: (file: string) => ({ isFile: () => file !== "/folder.bib" }) }, path,
    shell: { showItemInFolder: () => { revealed += 1; } }, chooseBibFile: () => "chosen.bib",
  });
  const reveal = handlers.get("references:reveal-bib")!;
  const event = { sender, senderFrame: mainFrame };
  assert.equal(reveal(event, "/safe.bib"), true);
  assert.equal(reveal({ sender, senderFrame: { url: "http://evil" } }, "/safe.bib"), false);
  assert.equal(reveal(event, "/folder.bib"), false);
  assert.equal(reveal(event, "/safe.txt"), false);
  assert.equal(revealed, 1);
  assert.equal(handlers.get("references:choose-bib")!({ sender: {}, senderFrame: mainFrame }), null);
});

test("SSE filters notebooks, bounds a stalled reader, and removes aborted streams", async () => {
  const cookie = { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` };
  assert.equal((await getEvents(new NextRequest("http://localhost/api/references/events?notebook=Notes"))).status, 401);
  const abort = new AbortController();
  const response = await getEvents(new NextRequest("http://localhost/api/references/events?notebook=Notes", { headers: cookie, signal: abort.signal }));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /connected/);
  publishReferenceEvent({ type: "library", notebook: "Other", revision: 1 });
  publishReferenceEvent({ type: "library", notebook: "Notes", revision: 2 });
  assert.match(decoder.decode((await reader.read()).value), /"revision":2/);
  for (let revision = 3; revision < 75; revision += 1) publishReferenceEvent({ type: "library", notebook: "Notes", revision });
  let buffered = 0;
  while (!(await reader.read()).done) buffered += 1;
  assert.equal(buffered, 64);
  abort.abort();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const closed = await getEvents(new NextRequest("http://localhost/api/references/events?notebook=Notes", { headers: cookie, signal: alreadyAborted.signal }));
  const closedReader = closed.body!.getReader();
  await closedReader.read();
  assert.equal((await closedReader.read()).done, true);
});

let createRoot: typeof import("react-dom/client").createRoot;

async function withDom(run: () => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  const keys = ["window", "document", "navigator", "CustomEvent", "EventSource", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of ["window", "document", "navigator", "CustomEvent"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  createRoot = (await import("react-dom/client")).createRoot;
  const fetch = globalThis.fetch;
  try { await run(); } finally {
    globalThis.fetch = fetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

test("the panel hears tether/untether in another window and ignores stale HTTP status responses", async () => {
  await withDom(async () => {
    class Source extends EventTarget {
      static instances: Source[] = [];
      closed = false;
      constructor(readonly url: string) { super(); Source.instances.push(this); }
      close() { this.closed = true; }
      tether(status: TetherStatus | null) { this.dispatchEvent(new MessageEvent("tether", { data: JSON.stringify({ type: "tether", notebook: "Notes", status }) })); }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
    let held: ((response: Response) => void) | null = null;
    let hold = false;
    let serverStatus: TetherStatus | null = null;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST" && hold) return new Promise<Response>((resolve) => { held = resolve; });
      return Response.json({ tether: serverStatus });
    };
    let api!: ReturnType<typeof useBibTether>;
    function Probe() { api = useBibTether("Notes"); return null; }
    const root = createRoot(document.getElementById("root")!);
    const snapshot = (): TetherStatus | null => api.status;
    const status: TetherStatus = { displayPath: "/refs.bib", fileName: "refs.bib", insideLibrary: false, dialect: "bibtex", state: "synced", tetheredAt: "2026-10-01T00:00:00.000Z", warnings: [], watching: true, entries: 1, libraryRevision: 1 };
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.equal(api.status, null);
      assert.equal(Source.instances.length, 1, "untethered panels also hear a tether made elsewhere");
      const source = Source.instances[0];
      await act(async () => source.tether(status));
      assert.equal(snapshot()?.libraryRevision, 1);
      hold = true;
      let request!: Promise<TetherStatus | null>;
      await act(async () => { request = api.run({ action: "check" }); });
      const newer = { ...status, libraryRevision: 3, state: "missing" as const };
      await act(async () => source.tether(newer));
      await act(async () => { held!(Response.json({ tether: status })); await request; });
      assert.equal(snapshot()?.libraryRevision, 3);
      assert.equal(snapshot()?.state, "missing");
      await act(async () => source.tether(null));
      assert.equal(api.status, null);
      assert.equal(source.closed, false);
      hold = false;
      serverStatus = { ...status, libraryRevision: 4 };
      await act(async () => source.dispatchEvent(new Event("open")));
      assert.equal(snapshot()?.libraryRevision, 4, "reconnect catches events missed while disconnected");
    } finally { await act(async () => root.unmount()); }
    assert.equal(Source.instances[0].closed, true);
  });
});

test("a library event during a pending fetch schedules one catch-up fetch", async () => {
  await withDom(async () => {
    resetReferenceLibraryCache();
    const requests: Array<(response: Response) => void> = [];
    globalThis.fetch = async () => new Promise<Response>((resolve) => { requests.push(resolve); });
    let api!: ReturnType<typeof useReferenceLibrary>;
    function Probe() { api = useReferenceLibrary("Notes"); return null; }
    const root = createRoot(document.getElementById("root")!);
    const library = { version: 1, revision: 1, style: "apa", entries: {} };
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.equal(requests.length, 1);
      await act(async () => window.dispatchEvent(new CustomEvent(REFERENCES_UPDATED_EVENT, { detail: { notebook: "Notes", revision: 2 } })));
      await act(async () => requests[0](Response.json({ library })));
      assert.equal(requests.length, 2);
      await act(async () => requests[1](Response.json({ library: { ...library, revision: 2 } })));
      assert.equal(api.library?.revision, 2);
      assert.equal(requests.length, 2);
    } finally {
      await act(async () => root.unmount());
      resetReferenceLibraryCache();
    }
  });
});

test("failed tether status reads are visible instead of looking untethered", async () => {
  await withDom(async () => {
    globalThis.fetch = async () => Response.json({ error: "The tether state is damaged." }, { status: 409 });
    let api!: ReturnType<typeof useBibTether>;
    function Probe() { api = useBibTether("Notes"); return null; }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.equal(api.loaded, true);
      assert.equal(api.error, "The tether state is damaged.");
    } finally { await act(async () => root.unmount()); }
  });
});

test("changing the chosen path invalidates an in-flight preview", async () => {
  await withDom(async () => {
    let finish!: (response: Response) => void;
    globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(BibTetherDialog, { open: true, notebook: "Notes", status: null, run: async () => null, onClose() {}, onDone() {} })));
      const input = document.querySelector("input")!;
      const change = (value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      };
      await act(async () => change("Notes/old.bib"));
      await act(async () => document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
      await act(async () => change("Notes/new.bib"));
      await act(async () => finish(Response.json({ preview: { displayPath: "Notes/old.bib", fileName: "old.bib", exists: true, dialect: "bibtex", fileEntries: 1, libraryEntries: 0, toLibrary: 1, toFile: 0, differing: 0, warnings: [] } })));
      const tether = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Tether")!;
      assert.equal(tether.disabled, true);
      assert.equal(document.querySelector('[aria-label="What tethering does"]'), null);
    } finally { await act(async () => root.unmount()); }
  });
});

test("untethering during a sync closes watchers installed by that sync", async () => {
  await withLibrary(async (directory) => {
    const watched = fakeWatchers();
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const entry = Object.values((await readReferenceLibrary("Notes")).entries)[0];
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: entry.id, csl: { volume: "9" } }]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalOpen = fsp.open;
    mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".libera-refs.bib.")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); entered(); await gate; };
      }
      return handle;
    });
    const syncing = requestTetherSync("Notes");
    await started;
    const untethering = untetherBibFile("Notes");
    release();
    await Promise.all([syncing, untethering]);
    assert.equal(watched.watchers.every((watcher) => watcher.closed), true);
    assert.equal(await getTetherStatus("Notes"), null);
  });
});

test("a library revision conflict replans before writing the file", async () => {
  await withLibrary(async (directory) => {
    fakeWatchers();
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    await writeFile(file, DOE_BIB.replace("{Press}", "{New Press}"));
    const originalRead = fsp.readFile;
    let intervened = false;
    mock.method(fsp, "readFile", async (...args: Parameters<typeof fsp.readFile>) => {
      const result = await originalRead(...args);
      if (String(args[0]) === referenceLibraryPath("Notes") && !intervened) {
        intervened = true;
        await updateReferenceLibrary("Notes", null, [{ op: "add", entry: SMITH }]);
      }
      return result;
    });
    assert.equal((await requestTetherSync("Notes"))?.state, "synced");
    assert.equal(intervened, true);
    assert.deepEqual(await keysOf(), ["doe2019", "smith2020"]);
    assert.match(await readFile(file, "utf8"), /New Press/);
    assert.match(await readFile(file, "utf8"), /smith2020/);
  });
});

test("JSON preparation failure happens before publishing any file changes", async () => {
  await withLibrary(async (directory) => {
    fakeWatchers();
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const entry = Object.values((await readReferenceLibrary("Notes")).entries)[0];
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: entry.id, csl: { volume: "9" } }]);
    const external = DOE_BIB.replace("{Press}", "{New Press}");
    await writeFile(file, external);
    const before = await readReferenceLibrary("Notes");
    const originalWrite = fsp.writeFile;
    mock.method(fsp, "writeFile", async (...args: Parameters<typeof fsp.writeFile>) => {
      if (String(args[0]).startsWith(referenceLibraryPath("Notes") + ".")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return originalWrite(...args);
    });
    assert.equal((await requestTetherSync("Notes"))?.state, "error");
    assert.deepEqual(await readReferenceLibrary("Notes"), before);
    assert.equal(await readFile(file, "utf8"), external);
  });
});

test("oversized files and snapshots that never settle are refused without changing either side", async () => {
  await withLibrary(async (directory) => {
    const huge = path.join(directory, "huge.bib");
    const handle = await fsp.open(huge, "w");
    await handle.truncate(17 * 1024 * 1024);
    await handle.close();
    await assert.rejects(previewTether("Notes", huge), /larger than 16 MB/);
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    const originalStat = fsp.stat;
    let clock = 0;
    mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
      const result = await originalStat(...args);
      return String(args[0]) === file ? Object.assign(Object.create(result), { mtimeMs: ++clock }) : result;
    });
    await assert.rejects(tetherBibFile("Notes", file, { prefer: "file" }), /keeps changing/);
    assert.deepEqual(await keysOf(), []);
    assert.equal(await readFile(file, "utf8"), DOE_BIB);
    assert.equal(await getTetherStatus("Notes"), null);
  });
});

test("unchanged focus checks and untethered notebooks perform no lock or state writes", async () => {
  await withLibrary(async (directory) => {
    const watched = fakeWatchers();
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const originalOpen = fsp.open;
    let writes = 0;
    mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      if (args[1] !== "r") writes += 1;
      return originalOpen(...args);
    });
    const originalWrite = fsp.writeFile;
    mock.method(fsp, "writeFile", async (...args: Parameters<typeof fsp.writeFile>) => { writes += 1; return originalWrite(...args); });
    await checkTether("Notes");
    assert.equal(writes, 0);
    watched.emit(path.dirname(file), path.basename(file));
    await delay(BIB_TETHER_SETTLE_MS + 100);
    assert.equal(writes, 0, "self-triggered file events also avoid lock writes");
    await createNotebook("Empty");
    writes = 0;
    await checkTether("Empty");
    await requestTetherSync("Empty");
    assert.equal(writes, 0);
    await assert.rejects(stat(path.dirname(bibTetherStatePath("Empty"))), { code: "ENOENT" });
    await untetherBibFile("Gone");
    await requestTetherSync("Gone");
    await assert.rejects(recreateTetheredFile("Gone"), /Notebook was not found/);
    await assert.rejects(stat(notebookPath("Gone")), { code: "ENOENT" });
  });
});

test("older tether state gains raw snapshots even when neither side has changed", async () => {
  await withLibrary(async (directory) => {
    fakeWatchers();
    const file = path.join(directory, "refs.bib");
    await writeFile(file, DOE_BIB);
    await tetherBibFile("Notes", file, { prefer: "file" });
    const state = JSON.parse(await readFile(bibTetherStatePath("Notes"), "utf8"));
    for (const entry of Object.values(state.base.entries) as Array<Record<string, unknown>>) {
      for (const field of ["fileFields", "raw", "restore", "libraryHash"]) delete entry[field];
    }
    await writeFile(bibTetherStatePath("Notes"), JSON.stringify(state));
    await checkTether("Notes");
    const upgraded = JSON.parse(await readFile(bibTetherStatePath("Notes"), "utf8"));
    assert.ok(Object.values(upgraded.base.entries).every((entry) => (entry as { restore?: string }).restore));
    await rm(file);
    await recreateTetheredFile("Notes");
    assert.match(await readFile(file, "utf8"), /owner = \{jd\}/);
  });
});
