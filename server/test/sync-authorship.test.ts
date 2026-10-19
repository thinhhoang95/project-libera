// Annotation authorship is enforced for every role, not only commenters:
// records are created in the sender's name, never re-attributed, and a
// suggestion's actor is its creator (or an AI acting for the creator).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type * as Y from "yjs";

import { AnnotationKeys, type AnchorRecord, type SuggestionRecord } from "../src/protocol.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

let env: SyncEnv;
before(async () => {
  env = await startSyncEnv();
});
after(async () => {
  await env.close();
});

const set = (map: string, key: string, value: unknown) => (doc: Y.Doc) => doc.getMap(map).set(key, value);

function anchor(id: string, createdBy: string): AnchorRecord {
  return { id, kind: "comment", start: { assoc: 0 }, end: { assoc: 0 }, createdBy, createdAt: Date.now() };
}

function suggestion(id: string, createdBy: string, actor: SuggestionRecord["actor"]): SuggestionRecord {
  return {
    id,
    actor,
    createdBy,
    start: { assoc: 0 },
    end: { assoc: 0 },
    baseQuote: "",
    replacement: "x",
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("editors cannot create or re-attribute annotations in another member's name", async () => {
  const owner = await env.connect();
  try {
    await owner.open(env.docId);
    const me = env.owner.id;
    const forged = await owner.rejected(owner.edit(env.docId, "annotations", set(AnnotationKeys.anchors, "a1", anchor("a1", "acc_someone_else"))));
    assert.equal(forged.reason, "annotation-ownership");
    await owner.rollback(env.docId);

    await owner.acked(owner.edit(env.docId, "annotations", set(AnnotationKeys.anchors, "a2", anchor("a2", me))));
    const reattributed = await owner.rejected(owner.edit(env.docId, "annotations", set(AnnotationKeys.anchors, "a2", anchor("a2", "acc_someone_else"))));
    assert.equal(reattributed.reason, "annotation-ownership");
    await owner.rollback(env.docId);

    const wrongActor = await owner.rejected(
      owner.edit(env.docId, "annotations", set(AnnotationKeys.suggestions, "s1", suggestion("s1", me, { kind: "user", userId: "acc_someone_else" }))),
    );
    assert.equal(wrongActor.reason, "annotation-ownership");
    await owner.rollback(env.docId);
    const aiForOther = await owner.rejected(
      owner.edit(env.docId, "annotations", set(AnnotationKeys.suggestions, "s2", suggestion("s2", me, { kind: "ai", onBehalfOf: "acc_someone_else", feature: "rewrite" }))),
    );
    assert.equal(aiForOther.reason, "annotation-ownership");
    await owner.rollback(env.docId);

    await owner.acked(owner.edit(env.docId, "annotations", set(AnnotationKeys.suggestions, "s3", suggestion("s3", me, { kind: "user", userId: me }))));
    await owner.acked(
      owner.edit(env.docId, "annotations", set(AnnotationKeys.suggestions, "s4", suggestion("s4", me, { kind: "ai", onBehalfOf: me, feature: "agentic-review" }))),
    );
    // Editors may still remove another member's anchor (deleting a thread).
    await owner.acked(owner.edit(env.docId, "annotations", (doc) => doc.getMap(AnnotationKeys.anchors).delete("a2")));
  } finally {
    await owner.close();
  }
});
