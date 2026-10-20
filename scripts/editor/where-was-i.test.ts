import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST, PUT } from "../../src/app/api/where-was-i/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { readRecapView, recordRecapSessions } from "../../src/lib/storage/where-was-i";
import { WhereWasITracker, whereWasITracker } from "../../src/components/libera/where-was-i-tracker";
import type { OpenTab } from "../../src/components/libera/types";
import type { LiberaFileNode, LiberaNotebookNode } from "../../src/lib/types";
import {
  MAX_RECAP_CROP_CHARS,
  changesSinceSession,
  decodeKnownFiles,
  encodeKnownFiles,
  hashRecapPath,
  normalizeRecapFileEntry,
  parseRecapBullets,
  rankRecapFiles,
  summarizeTextChange,
  type RecapSessionUpdate,
} from "../../src/lib/where-was-i";

test("a text change keeps its size and a clipped crop of each side", () => {
  const change = summarizeTextChange("# Plan\n\nOld goal.\n\nNotes\n", "# Plan\n\nShip the recap card by Friday.\n\nNotes\n");
  assert.ok(change);
  assert.deepEqual(change.crops, [{ removed: "Old goal.", added: "Ship the recap card by Friday." }]);
  assert.ok((change.added ?? 0) > 0 && (change.removed ?? 0) > 0);
  assert.equal(summarizeTextChange("same", "same"), null);

  const long = summarizeTextChange("start\n", `start\n${"word ".repeat(400)}\n`);
  assert.ok(long?.crops?.[0].added && long.crops[0].added.length <= MAX_RECAP_CROP_CHARS);
});

test("client entries are clamped and unsafe paths are dropped", () => {
  assert.equal(normalizeRecapFileEntry({ path: "../escape.md" }), null);
  const entry = normalizeRecapFileEntry({ path: "sub/a.md", edited: true, crops: [{ added: "x".repeat(1000) }, {}, { removed: "y" }, { added: "z" }], by: "nobody" });
  assert.equal(entry?.name, "a.md");
  assert.equal(entry?.crops?.length, 2);
  assert.equal(entry?.crops?.[0].added?.length, MAX_RECAP_CROP_CHARS);
  assert.equal(entry?.by, undefined);
});

test("model output becomes two to four plain bullets", () => {
  assert.deepEqual(parseRecapBullets("Here you go:\n- You **drafted** `plan.md`.\n* You reviewed notes.\n1. One\n2) Two\n- Five"), [
    "You drafted plan.md.", "You reviewed notes.", "One", "Two",
  ]);
});

test("each computer records its own session file and the home shows the newest finished one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-where-was-i-"));
  const saved = { data: process.env.LIBERA_DATA_DIR, machine: process.env.LIBERA_MACHINE_ID, key: process.env.OPENROUTER_API_KEY, config: process.env.LIBERA_CONFIG_PATH };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  delete process.env.LIBERA_CONFIG_PATH;
  try {
    await mkdir(path.join(directory, "users", "admin", "Research"), { recursive: true });
    const file = { path: "plan.md", name: "plan.md", fileType: "markdown", lastAt: new Date().toISOString(), edited: true, added: 30, removed: 9, crops: [{ removed: "Old goal.", added: "Ship the recap card." }] };

    process.env.LIBERA_MACHINE_ID = "computer-a";
    await assert.rejects(recordRecapSessions({ sessionId: "invalid-date", startedAt: "2026-99-99T00:00:00Z", notebooks: { Research: [file] } }), /Invalid session/);
    await recordRecapSessions({ sessionId: "session-aaaa", startedAt: new Date(Date.now() - 3_600_000).toISOString(), notebooks: { Research: [file], Missing: [file] } });
    // The session still in progress is not "where you left off".
    assert.equal((await readRecapView("Research", "session-aaaa", false)).session, null);
    assert.equal((await readRecapView("Research", "session-bbbb", false)).session?.files[0].path, "plan.md");

    process.env.LIBERA_MACHINE_ID = "computer-b";
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordRecapSessions({ sessionId: "session-bbbb", startedAt: new Date().toISOString(), notebooks: { Research: [{ ...file, path: "draft.md", name: "draft.md", edited: false }] } });
    const recapDirectory = path.join(directory, "users", "admin", "Research", ".libera", "where-was-i");
    assert.deepEqual((await readdir(recapDirectory)).sort(), ["computer-a.json", "computer-b.json"]);
    // A notebook that does not exist is not created.
    await assert.rejects(readdir(path.join(directory, "users", "admin", "Missing")));

    process.env.LIBERA_MACHINE_ID = "computer-a";
    const fromA = await readRecapView("Research", "session-cccc", false);
    assert.equal(fromA.session?.id, "session-bbbb");
    assert.ok(fromA.deviceName);

    // Summaries: generated once, stored, and served from the file afterwards.
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: "- You skimmed draft.md.\n- You picked up where the plan left off." } }] });
    }) as typeof fetch;
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
    const post = () => POST(new NextRequest("http://localhost/api/where-was-i", { method: "POST", headers: { cookie }, body: JSON.stringify({ notebook: "Research", sessionId: "session-bbbb" }) }));
    const first = await (await post()).json();
    assert.deepEqual(first.summary.bullets, ["You skimmed draft.md.", "You picked up where the plan left off."]);
    assert.equal(first.summary.model, "deepseek/deepseek-v4.1-flash");
    await post();
    assert.equal(calls, 1);
    // Closing a tab in the current session creates a newer checkpoint. It
    // must not hide the cached summary of the previous session from POST.
    await recordRecapSessions({ sessionId: "session-cccc", startedAt: new Date().toISOString(), notebooks: { Research: [file] } });
    await post();
    assert.equal(calls, 1);
    const view = await (await GET(new NextRequest("http://localhost/api/where-was-i?notebook=Research&session=session-cccc", { headers: { cookie } }))).json();
    assert.equal(view.summary.sessionId, "session-bbbb");
    assert.equal(view.summariesEnabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: saved.data, LIBERA_MACHINE_ID: saved.machine, OPENROUTER_API_KEY: saved.key, LIBERA_CONFIG_PATH: saved.config })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("turned off in Preferences, nothing is recorded and the home shows no card", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-where-was-i-off-"));
  const saved = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_CONFIG_PATH = path.join(directory, "config.json");
  try {
    await writeFile(process.env.LIBERA_CONFIG_PATH, JSON.stringify({ aiFunctions: { whereWasI: { enabled: false } } }));
    await mkdir(path.join(directory, "users", "admin", "Research"), { recursive: true });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
    const file = { path: "plan.md", name: "plan.md", fileType: "markdown", lastAt: new Date().toISOString(), edited: true };
    const put = await PUT(new NextRequest("http://localhost/api/where-was-i", { method: "PUT", headers: { cookie }, body: JSON.stringify({ sessionId: "session-aaaa", startedAt: new Date().toISOString(), notebooks: { Research: [file] } }) }));
    assert.deepEqual(await put.json(), { ok: true, recorded: false });
    await assert.rejects(readdir(path.join(directory, "users", "admin", "Research", ".libera")));
    const view = await (await GET(new NextRequest("http://localhost/api/where-was-i?notebook=Research&session=session-bbbb", { headers: { cookie } }))).json();
    assert.deepEqual(view, { disabled: true });
  } finally {
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: saved.data, LIBERA_CONFIG_PATH: saved.config })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function fileNode(path: string, dates: { createdAt: string; updatedAt: string; changedAt?: string }): LiberaFileNode {
  return { kind: "file", name: path.split("/").at(-1)!, path: `Research/${path}`, notebook: "Research", fileType: path.endsWith(".md") ? "markdown" : "pdf", size: 1, ...dates };
}

test("known files round-trip as path hashes, and new unopened files are capped", () => {
  const known = decodeKnownFiles(encodeKnownFiles(["a.md", "sub/b.pdf", "a.md"]) ?? undefined);
  assert.deepEqual([...known!].sort(), [hashRecapPath("a.md"), hashRecapPath("sub/b.pdf")].sort());
  assert.equal(decodeKnownFiles("not base64!"), null);

  const uploads = Array.from({ length: 10 }, (_, index) => ({ path: `photo-${index}.jpg`, name: "", fileType: "image", lastAt: ago(index), edited: false, created: true, unopened: true }));
  const ranked = rankRecapFiles([...uploads, { path: "draft.md", name: "", fileType: "markdown", lastAt: ago(30), edited: true }, { path: "seen.pdf", name: "", fileType: "pdf", lastAt: ago(1), edited: false }]);
  assert.equal(ranked[0].path, "draft.md");
  assert.equal(ranked.filter((file) => file.unopened).length, 6);
  assert.equal(ranked.at(-1)?.path, "seen.pdf");
});

test("changed since you left: the known list catches copies that keep old dates; dates are the fallback", () => {
  const endedAt = ago(60);
  const files = [
    fileNode("old.md", { createdAt: ago(600), updatedAt: ago(600), changedAt: ago(5) }), // metadata touched by a sync client
    fileNode("edited.md", { createdAt: ago(600), updatedAt: ago(10), changedAt: ago(10) }),
    fileNode("copied.pdf", { createdAt: ago(900), updatedAt: ago(900), changedAt: ago(3) }), // a Finder copy
    fileNode("opened.md", { createdAt: ago(600), updatedAt: ago(2) }),
  ];
  const exclude = new Set(["Research/opened.md"]);

  const withList = changesSinceSession(files, "Research", { endedAt, knownFiles: encodeKnownFiles(["old.md", "edited.md", "opened.md"])! }, { exclude });
  assert.deepEqual(withList.map(({ file, kind }) => [file.name, kind]), [["copied.pdf", "new"], ["edited.md", "updated"]]);

  // Without a list, the inode change time still finds the copy, at the cost of the metadata-only change.
  const byDates = changesSinceSession(files, "Research", { endedAt }, { exclude });
  assert.deepEqual(byDates.map(({ file, kind }) => [file.name, kind]), [["copied.pdf", "new"], ["old.md", "new"], ["edited.md", "updated"]]);
});

test("corrupt synced dates cannot crash the changed-since list", () => {
  assert.deepEqual(changesSinceSession([], "Research", { endedAt: "invalid" }), []);
  assert.deepEqual(changesSinceSession([], "Research", { endedAt: "2026-99-99T00:00:00Z" }), []);
  const entry = normalizeRecapFileEntry({ path: "a.md", lastAt: "2026-99-99T00:00:00Z" });
  assert.ok(Number.isFinite(Date.parse(entry!.lastAt)));
});

test("quit waits for a close checkpoint and persists the newer snapshot last", async () => {
  const originalFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;
  if (!hadWindow) Object.assign(globalThis, { window: {} });
  const sent: RecapSessionUpdate[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    if (sent.length === 1) await blocked;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const tracker = new WhereWasITracker();
    const node = fileNode("a.md", { createdAt: ago(600), updatedAt: ago(600) });
    const tab = (id: string, saved: string): OpenTab => ({ id, file: { ...node, path: `Research/${id}`, name: id }, saved, draft: saved, status: "clean" });
    tracker.syncTabs([tab("a.md", "before"), tab("b.md", "before")], () => false);
    tracker.syncTabs([tab("a.md", "after"), tab("b.md", "before")], () => false);
    tracker.syncTabs([tab("b.md", "before")], () => false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
    let finished = false;
    const quit = tracker.flush(() => "new final text").then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
    assert.equal(finished, false);
    release();
    await quit;
    assert.equal(sent.length, 2);
    const final = sent[1].notebooks.Research.find((file) => file.path === "b.md");
    assert.equal(final?.edited, true);
    assert.match(final?.crops?.[0].added ?? "", /new final text/);
  } finally {
    release();
    globalThis.fetch = originalFetch;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  }
});

test("a disabled write can be recorded after enabling without further edits", async () => {
  const originalFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;
  if (!hadWindow) Object.assign(globalThis, { window: {} });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json(calls === 1 ? { ok: true, recorded: false } : { ok: true });
  }) as typeof fetch;
  try {
    const tracker = new WhereWasITracker();
    const file = fileNode("a.md", { createdAt: ago(600), updatedAt: ago(600) });
    tracker.syncTabs([{ id: file.path, file, saved: "unchanged", draft: "unchanged", status: "clean" }], () => false);
    await tracker.flush(() => "unchanged");
    await tracker.flush(() => "unchanged");
    assert.equal(calls, 2);
    await tracker.flush(() => "unchanged");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  }
});

test("shared edits closed before the tab mirror updates keep their text and authorship", async () => {
  const originalFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;
  if (!hadWindow) Object.assign(globalThis, { window: {} });
  const sent: RecapSessionUpdate[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    for (const local of [false, true]) {
      const tracker = new WhereWasITracker();
      const file = fileNode("shared.md", { createdAt: ago(600), updatedAt: ago(600) });
      tracker.syncTabs([{ id: file.path, file, saved: "stale local copy", draft: "stale local copy", status: "clean" }], () => true);
      tracker.sharedAttached(file.path, "shared baseline");
      tracker.sharedEdited(file.path, local, "shared baseline with the last edit");
      // No debounced saved/draft update has reached the tab yet.
      tracker.syncTabs([], () => true);
      await tracker.flush(() => null);
      const entry = sent.at(-1)!.notebooks.Research[0];
      assert.equal(entry.edited, true);
      assert.equal(entry.by, local ? "you" : "others");
      assert.match(entry.crops?.[0].added ?? "", /last edit/);
      assert.equal(sent.length, local ? 2 : 1, "quit should not write a duplicate checkpoint");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  }
});

test("an incomplete inventory clears a formerly complete known-file list", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-recap-inventory-"));
  const savedData = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await mkdir(path.join(directory, "users", "admin", "Research"), { recursive: true });
    const update: RecapSessionUpdate = {
      sessionId: "inventory-session", startedAt: ago(60),
      notebooks: { Research: [{ path: "a.md", name: "a.md", fileType: "markdown", lastAt: ago(5), edited: false }] },
      knownFiles: { Research: encodeKnownFiles(["a.md"])! },
    };
    await recordRecapSessions(update);
    assert.ok((await readRecapView("Research", "next-session", false)).session?.knownFiles);
    await recordRecapSessions({ ...update, knownFiles: undefined });
    assert.ok((await readRecapView("Research", "next-session", false)).session?.knownFiles, "omission preserves inventories for older clients");
    await recordRecapSessions({ ...update, knownFiles: { Research: null } });
    const session = (await readRecapView("Research", "next-session", false)).session!;
    assert.equal(session.knownFiles, undefined);
    assert.deepEqual(changesSinceSession([
      fileNode("old-but-unlisted.md", { createdAt: ago(600), updatedAt: ago(600) }),
    ], "Research", session), []);
  } finally {
    if (savedData === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = savedData;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the tracker records new files, opened or not, with the notebook's known files", async () => {
  const originalFetch = globalThis.fetch;
  const sent: RecapSessionUpdate[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }) as typeof fetch;
  // The keep-alive choice reads `window`, which Node lacks.
  const hadWindow = "window" in globalThis;
  if (!hadWindow) Object.assign(globalThis, { window: {} });
  try {
    const sessionId = whereWasITracker.sessionId; // starts the session now
    assert.ok(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = new Date().toISOString();
    const files = [
      fileNode("old.md", { createdAt: ago(600), updatedAt: ago(600) }),
      fileNode("chapter-4.md", { createdAt: now, updatedAt: now }),
      fileNode("scan.pdf", { createdAt: now, updatedAt: now }),
    ];
    const library = [{ kind: "notebook", name: "Research", path: "Research", children: files } as unknown as LiberaNotebookNode];
    whereWasITracker.setLibrary(() => library);

    const tab = (saved: string): OpenTab => ({ id: "Research/chapter-4.md", file: files[1], draft: saved, saved, status: "clean" });
    whereWasITracker.syncTabs([tab("# Chapter 4\n")], () => false);
    whereWasITracker.syncTabs([tab("# Chapter 4\n\nThe pilot study failed because the survey was too long.\n")], () => false);
    whereWasITracker.syncTabs([], () => false); // closing an edited file writes
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sent.length, 1);
    const recorded = sent[0].notebooks.Research;
    assert.deepEqual(recorded.map((file) => [file.path, file.edited, file.created ?? false, file.unopened ?? false]), [
      ["chapter-4.md", true, true, false],
      ["scan.pdf", false, true, true],
    ]);
    assert.match(recorded[0].crops?.[0].added ?? "", /pilot study failed/);
    assert.equal(decodeKnownFiles(sent[0].knownFiles?.Research)?.size, 3);

    // Quitting with nothing new writes nothing again.
    await whereWasITracker.flush(() => null);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    whereWasITracker.setLibrary(() => []);
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  }
});
