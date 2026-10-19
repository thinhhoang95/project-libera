// The version history panel in jsdom: revision list with kinds and authors,
// role gating of "Name this version…" and restore (the same `can()` the
// server enforces), a read-only revision view, the attributed diff against
// now through @codemirror/merge, and restore with its checkpoint result.

import { button, cleanup, click, dom, flush, render, selectValue, typeInto } from "./ui-support";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import * as Y from "yjs";

import type { RestoreRequest, Revision, UpdateRecord } from "../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { DocumentHistoryPanel } from "../../src/components/libera/collab/history/history-panel";
import { forgetProjectMembers } from "../../src/components/libera/collab/mentions/mention-textarea";
import type { HistoryApi } from "../../src/components/libera/collab/history/history-api";

for (const key of ["HTMLTextAreaElement", "Text", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
for (const target of [globalThis, dom.window]) Object.assign(target, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });

const ALICE = { id: "u-alice", displayName: "Alice", color: "#dc2626" };
const BOB = { id: "u-bob", displayName: "Bob", color: "#16a34a" };

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

/** A small update log: Alice writes the text, an AI rewrite on her behalf, then Bob types. */
function log() {
  const doc = new Y.Doc();
  const text = doc.getText(ContentKeys.source);
  const updates: UpdateRecord[] = [];
  const record = (actor: UpdateRecord["actor"], provenance: unknown, userId: string, change: () => void) => {
    const before = Y.encodeStateVector(doc);
    change();
    updates.push({ serverSeq: updates.length + 1, subdoc: "content", userId, clientId: "c", actor, provenance, receivedAt: "", update: base64(Y.encodeStateAsUpdate(doc, before)) });
  };
  record({ kind: "user", userId: ALICE.id }, { source: "typing" }, ALICE.id, () => text.insert(0, "Hello world.\n"));
  record({ kind: "ai", onBehalfOf: ALICE.id, feature: "rewrite" }, { source: "ai", feature: "rewrite" }, ALICE.id, () => { text.delete(6, 5); text.insert(6, "there"); });
  record({ kind: "user", userId: BOB.id }, { source: "typing" }, BOB.id, () => text.insert(text.length, "Bye.\n"));
  return { updates, final: text.toString() };
}

function revisions(): Revision[] {
  return [
    { id: "rev-2", docId: "d1", serverSeq: 3, label: null, kind: "session-end", createdBy: BOB, createdAt: "2026-10-18T09:00:00.000Z" },
    { id: "rev-1", docId: "d1", serverSeq: 1, label: "First draft", kind: "named", createdBy: ALICE, createdAt: "2026-10-18T08:00:00.000Z" },
  ];
}

function fakeApi(restores: RestoreRequest[]): HistoryApi {
  const { updates } = log();
  let list = revisions();
  return {
    revisions: async () => list,
    nameVersion: async (_docId, label) => {
      const revision: Revision = { id: "rev-named", docId: "d1", serverSeq: 3, label, kind: "named", createdBy: ALICE, createdAt: new Date().toISOString() };
      list = [revision, ...list];
      return revision;
    },
    content: async (_docId, revisionId) => ({ revision: list.find((item) => item.id === revisionId)!, text: revisionId === "rev-1" ? "Hello world.\n" : "Hello there.\nBye.\n" }),
    updates: async (_docId, params) => ({ updates: updates.filter((update) => update.serverSeq >= (params.fromSeq ?? 1) && (params.toSeq === undefined || update.serverSeq <= params.toSeq)), nextFromSeq: null, baseSnapshot: null }),
    restore: async (_docId, body) => {
      restores.push(body);
      list = [{ id: "rev-pre", docId: "d1", serverSeq: 3, label: null, kind: "pre-restore", createdBy: ALICE, createdAt: new Date().toISOString() }, ...list];
      return { serverSeq: 4, checkpointRevisionId: "rev-pre" };
    },
  };
}

function installMembers() {
  forgetProjectMembers();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async () => Response.json([{ ...ALICE, email: "a@x", role: "owner", joinedAt: "" }, { ...BOB, email: "b@x", role: "editor", joinedAt: "" }]),
  });
}

test("history panel: list, gating, diff with attribution, restore", async () => {
  installMembers();
  const restores: RestoreRequest[] = [];
  try {
    await render(createElement(DocumentHistoryPanel, { target: { docId: "d1", projectId: "p1", path: "Shared/a.md", role: "editor" }, onClose: () => {}, api: fakeApi(restores) }));
    await flush(4);
    const items = [...document.querySelectorAll("[data-revision-kind]")].map((item) => item.textContent);
    assert.equal(items.length, 2);
    assert.match(items[0] ?? "", /Session end.*Bob/);
    assert.match(items[1] ?? "", /First draft.*Named.*Alice/);
    assert.ok(button("Name this version"), "editors can name versions");
    assert.ok(button("Restore this version"));
    assert.ok(document.querySelector('[aria-label="Revision text"] .cm-content'), "a read-only CodeMirror view of the revision");
    assert.equal(document.querySelector('[aria-label="Revision text"] .cm-content')?.getAttribute("contenteditable"), "false");

    // Name a version.
    await click(button("Name this version"));
    await typeInto(document.querySelector('input[aria-label="Version name"]'), "Before review");
    await click(button("Save"));
    await flush(3);
    assert.match(document.body.textContent ?? "", /Saved “Before review”/);

    // Diff the first draft against now: the AI rewrite and Bob's line are attributed.
    await click([...document.querySelectorAll<HTMLButtonElement>("[data-revision-kind]")].find((item) => item.textContent?.includes("First draft")));
    await selectValue(document.querySelector('select[aria-label="Compare with"]'), "now");
    await flush(6);
    const legend = [...document.querySelectorAll('[aria-label="Authors of the changes"] li')].map((item) => item.textContent);
    assert.deepEqual(legend, ["AI rewrite · Alice", "Bob"]);
    const marks = [...document.querySelectorAll(".libera-history-author")].map((mark) => [mark.getAttribute("data-author"), mark.textContent]);
    assert.ok(marks.some(([author, text]) => author === "AI rewrite · Alice" && text === "there"), JSON.stringify(marks));
    assert.ok(marks.some(([author, text]) => author === "Bob" && text?.includes("Bye")), JSON.stringify(marks));
    assert.ok(document.querySelector(".cm-mergeView"));

    // Restore the whole version, with a confirmation and the checkpoint in the result.
    await selectValue(document.querySelector('select[aria-label="Compare with"]'), "none");
    await click(button("Restore this version"));
    await click(button(/^Restore$/));
    await flush(3);
    assert.deepEqual(restores, [{ revisionId: "rev-1" }]);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /restored from “First draft”.*checkpoint \(Before restore\)/);
  } finally {
    await cleanup();
  }
});

test("history panel: commenters can read history but neither name nor restore", async () => {
  installMembers();
  try {
    await render(createElement(DocumentHistoryPanel, { target: { docId: "d1", projectId: "p1", path: "Shared/a.md", role: "commenter" }, onClose: () => {}, api: fakeApi([]) }));
    await flush(4);
    assert.equal(document.querySelectorAll("[data-revision-kind]").length, 2);
    assert.equal(button("Name this version"), undefined);
    assert.equal(button("Restore this version"), undefined);
    assert.equal(button("Restore selection"), undefined);
    await act(async () => {});
  } finally {
    await cleanup();
  }
});
