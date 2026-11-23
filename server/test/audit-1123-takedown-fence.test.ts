// Three-way sync audit 2026-11-23, C5 part 5: a delete that carries export evidence (the recovery report or the
// manifest sequence it exported at) belongs to a fenced takedown. When another owner device lifted the fence
// (reopen), text and comments written after that export must not be deleted unchecked.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { json } from "./helpers.js";
import { createProject, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

let env: SyncEnv;
before(async () => { env = await startSyncEnv(); });
after(() => env.close());

const route = (projectId: string) => `/v1/projects/${projectId}`;
const noRecovery = { threads: 0, messages: 0, suggestions: 0, reviews: 0 };

describe("takedown delete needs the fence it was exported under", () => {
  test("a delete with a recovery report is refused after another device lifted the fence", async () => {
    const project = await createProject(env.db, env.owner.id);
    const fenced = await json(env.server.url, `${route(project.id)}/closing`, { method: "POST", token: env.owner.token, body: {} });
    assert.equal(fenced.status, 200);
    const lifted = await json(env.server.url, `${route(project.id)}/closing`, { method: "DELETE", token: env.owner.token });
    assert.ok(lifted.status < 300, `lift ${lifted.status}`);

    const refused = await json(env.server.url, route(project.id), { method: "DELETE", token: env.owner.token, body: { recovery: noRecovery } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await json(env.server.url, route(project.id), { token: env.owner.token })).status, 200, "the project stays");
  });

  test("a delete with an expected manifest sequence is refused without a fence", async () => {
    const project = await createProject(env.db, env.owner.id);
    const refused = await json(env.server.url, route(project.id), { method: "DELETE", token: env.owner.token, body: { expectedManifestSeq: 0 } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await json(env.server.url, route(project.id), { token: env.owner.token })).status, 200);
  });

  test("a fenced delete still checks the recovery report, and a plain delete is unchanged", async () => {
    const fencedProject = await createProject(env.db, env.owner.id);
    await json(env.server.url, `${route(fencedProject.id)}/closing`, { method: "POST", token: env.owner.token, body: {} });
    const ok = await json(env.server.url, route(fencedProject.id), { method: "DELETE", token: env.owner.token, body: { recovery: noRecovery, expectedManifestSeq: 0 } });
    assert.equal(ok.status, 204, JSON.stringify(ok.body));

    const plain = await createProject(env.db, env.owner.id);
    const removed = await json(env.server.url, route(plain.id), { method: "DELETE", token: env.owner.token, body: {} });
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
  });
});
