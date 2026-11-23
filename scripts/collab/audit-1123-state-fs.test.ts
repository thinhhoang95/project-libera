// Three-way sync review, package NX2 (H23, L6, M18): state.json validation and
// the exclusive-publication edges of fs-ops.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DestinationTakenError, movePathExclusive, writeFileExclusive } from "../../electron/collab/notebooks/fs-ops";
import { readState } from "../../electron/collab/notebooks/state";
import { diffManifestPaths } from "../../electron/collab/notebooks/transition-log";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "libera-audit-1123-"));
}

function putState(root: string, state: unknown): void {
  mkdirSync(path.join(root, ".libera", "collab"), { recursive: true });
  writeFileSync(path.join(root, ".libera", "collab", "state.json"), JSON.stringify(state));
}

const HASH = "a".repeat(64);
const base = () => ({ version: 1, layout: {}, reconciliations: [] as unknown[] });
const record = (extra: Record<string, unknown>) => ({ path: "a.png", kind: "blob", hash: HASH, size: 3, ...extra });

test("H23: a pre-1970 mtimeMs is a valid baseline, not an invalid state.json", async () => {
  const root = scratch();
  try {
    putState(root, { ...base(), layout: { f1: record({ mtimeMs: -86_400_000, previous: [{ hash: HASH, mtimeMs: -5 }] }) } });
    const state = await readState(root);
    assert.equal(state.externalAdoptionRequired, undefined, "a valid state is not quarantined");
    assert.equal(state.layout.f1.mtimeMs, -86_400_000);
    // size and detectedAt stay non-negative.
    putState(root, { ...base(), layout: { f1: record({ size: -1 }) } });
    assert.equal((await readState(root)).externalAdoptionReason, "invalid-state");
    putState(root, { ...base(), layout: { f1: record({ mtimeMs: Number.NaN }) } });
    assert.equal((await readState(root)).externalAdoptionReason, "invalid-state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L6: a malformed displaced or remoteRespells is rejected, a well-formed one is kept", async () => {
  const root = scratch();
  try {
    const good = { ...base(), displaced: [{ fileId: "displaced-1", from: "a.md", to: "_archive/a.md", at: 5 }], remoteRespells: { f1: { path: "a.md", at: 5 } } };
    putState(root, good);
    const kept = await readState(root);
    assert.equal(kept.externalAdoptionRequired, undefined);
    assert.equal(kept.displaced?.length, 1);
    for (const bad of [
      { displaced: "nope" },
      { displaced: [null] },
      { displaced: [{ fileId: "x", from: "a", to: 3, at: 1 }] },
      { remoteRespells: [] },
      { remoteRespells: "nope" },
      { remoteRespells: { f1: null } },
      { remoteRespells: { f1: { path: 3, at: 1 } } },
    ]) {
      putState(root, { ...base(), ...bad });
      assert.equal((await readState(root)).externalAdoptionReason, "invalid-state", JSON.stringify(bad));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M21: a manifest that has caught up with the server and is legitimately empty records its removals", () => {
  const recorded = new Map([["f1", { path: "a.md", kind: "file" as const }]]);
  assert.deepEqual(diffManifestPaths(recorded, new Map(), 7), { upserts: [], removals: [], transitions: [] }, "not synced: an empty list may be a manifest that has not loaded");
  const synced = diffManifestPaths(recorded, new Map(), 7, true);
  assert.deepEqual(synced.removals, ["f1"]);
  assert.deepEqual(synced.transitions.map(({ fileId, from, to }) => [fileId, from, to]), [["f1", "a.md", null]]);
});

/** Runs `work` with a stand-in for one `fs.promises` function. */
async function patched<K extends keyof typeof fsp>(name: K, replacement: (typeof fsp)[K], work: () => Promise<void>): Promise<void> {
  const original = fsp[name];
  (fsp as unknown as Record<string, unknown>)[name] = replacement;
  try { await work(); } finally { (fsp as unknown as Record<string, unknown>)[name] = original; }
}

test("M18: when the source cannot be unlinked the link made for the destination is dropped", async () => {
  const root = scratch();
  try {
    const from = path.join(root, "from.png");
    const to = path.join(root, "to.png");
    writeFileSync(from, "bytes");
    const unlink = fsp.unlink.bind(fsp);
    await patched("unlink", (async (target: Parameters<typeof fsp.unlink>[0]) => {
      if (target === from) throw Object.assign(new Error("in use"), { code: "EACCES" });
      return unlink(target);
    }) as typeof fsp.unlink, async () => {
      await assert.rejects(movePathExclusive(from, to), { code: "EACCES" });
    });
    assert.equal(readFileSync(from, "utf8"), "bytes");
    assert.equal(existsSync(to), false, "from and to must not share an inode");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M18: on Windows a folder moved onto an existing folder is DestinationTakenError (so a unique name is tried)", async () => {
  const root = scratch();
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  try {
    mkdirSync(path.join(root, "from"));
    writeFileSync(path.join(root, "from", "x.md"), "X");
    mkdirSync(path.join(root, "to"));
    const rename = fsp.rename.bind(fsp);
    Object.defineProperty(process, "platform", { value: "win32" });
    // What Windows reports for a rename onto an existing folder.
    await patched("rename", (async (a: Parameters<typeof fsp.rename>[0], b: Parameters<typeof fsp.rename>[1]) => {
      if (b === path.join(root, "to")) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return rename(a, b);
    }) as typeof fsp.rename, async () => {
      await assert.rejects(movePathExclusive(path.join(root, "from"), path.join(root, "to")), DestinationTakenError);
    });
    assert.equal(readFileSync(path.join(root, "from", "x.md"), "utf8"), "X");
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(root, { recursive: true, force: true });
  }
});

test("M18: without hard links, a failed rename does not delete a file another actor put at the destination", async () => {
  const root = scratch();
  try {
    const target = path.join(root, "note.md");
    const link = fsp.link;
    const rename = fsp.rename.bind(fsp);
    (fsp as unknown as Record<string, unknown>).link = async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); };
    try {
      await patched("rename", (async (a: Parameters<typeof fsp.rename>[0], b: Parameters<typeof fsp.rename>[1]) => {
        if (b === target) {
          // Someone replaces the claim with a real file, then our rename fails.
          rmSync(target);
          writeFileSync(target, "theirs");
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return rename(a, b);
      }) as typeof fsp.rename, async () => {
        await assert.rejects(writeFileExclusive(target, Buffer.from("mine")), { code: "EACCES" });
      });
    } finally { (fsp as unknown as Record<string, unknown>).link = link; }
    assert.equal(readFileSync(target, "utf8"), "theirs");
    assert.deepEqual(readdirSync(root), ["note.md"], "no staged temp file is left");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M18: without hard links, a failed rename still removes the claim it made", async () => {
  const root = scratch();
  try {
    const target = path.join(root, "note.md");
    const link = fsp.link;
    (fsp as unknown as Record<string, unknown>).link = async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); };
    try {
      await patched("rename", (async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as typeof fsp.rename, async () => {
        await assert.rejects(writeFileExclusive(target, Buffer.from("mine")), { code: "EACCES" });
      });
    } finally { (fsp as unknown as Record<string, unknown>).link = link; }
    assert.equal(existsSync(target), false);
    assert.equal(statSync(root).isDirectory(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
