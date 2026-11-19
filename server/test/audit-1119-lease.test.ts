// Audit 2026-11-19, finding 40: a refused lease claim is a read. The contention
// timestamp (only ever read as "set or not") is written once, and the refusal
// tells the follower how long until the holder's lease runs out.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createProject, register, request, startApi, type ApiHarness } from "./support/api-harness.js";

let h: ApiHarness;
before(async () => {
  h = await startApi();
});
after(() => h.close());

test("a refused claim writes the contention timestamp once and reports the time left", async () => {
  const owner = await register(h, "lease-owner");
  const project = await createProject(h, owner, "Leased");
  const route = `/v1/projects/${project.id}/folder-lease`;
  const claim = (holder: string) => request(h, "POST", route, owner, { folderId: "fld_audit_1119", holder, ttlMs: 60_000 });
  const row = () =>
    h.context.db.selectFrom("folder_leases").select(["contended_at", "updated_at", "expires_at"]).where("project_id", "=", project.id).executeTakeFirstOrThrow();

  const granted = await claim("holder_a");
  assert.equal(granted.status, 200);
  assert.equal(granted.body.granted, true);
  assert.equal(granted.body.contended, false);
  assert.equal((await row()).contended_at, null);

  const first = await claim("holder_b");
  assert.equal(first.body.granted, false);
  assert.equal(first.body.holder, "holder_a");
  assert.equal(first.body.contended, true);
  assert.ok(first.body.retryAfterMs > 0 && first.body.retryAfterMs <= 60_000, `time left reported: ${first.body.retryAfterMs}`);
  const stamped = (await row()).contended_at;
  assert.ok(stamped, "the first contention is recorded");

  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = await claim("holder_b");
    assert.equal(again.body.granted, false);
    assert.equal(again.body.contended, true);
  }
  assert.equal((await row()).contended_at?.getTime(), stamped.getTime(), "later refusals do not rewrite the timestamp");

  // The holder still learns about the contender at its next renewal.
  const renewed = await claim("holder_a");
  assert.equal(renewed.body.granted, true);
  assert.equal(renewed.body.contended, true);
});

test("releasing a lease tells the account's other installations; a release of nothing does not", async () => {
  const owner = await register(h, "lease-release");
  const project = await createProject(h, owner, "Released");
  const route = `/v1/projects/${project.id}/folder-lease`;
  const claim = (holder: string) => request(h, "POST", route, owner, { folderId: "fld_release", holder, ttlMs: 60_000 });
  const release = (holder: string) => request(h, "DELETE", `${route}?folderId=fld_release&holder=${holder}`, owner);
  const heard = () => h.events.filter((event) => event.kind === "folder-lease.released" && (event.payload as { projectId?: string }).projectId === project.id);

  await claim("holder_a");
  await release("holder_b");
  assert.equal(heard().length, 0, "a holder that does not hold the lease releases nothing");
  await release("holder_a");
  assert.equal(heard().length, 1);
  assert.equal(heard()[0].scope, "user");
  assert.equal((await claim("holder_b")).body.granted, true, "the released lease is claimable at once");
});
