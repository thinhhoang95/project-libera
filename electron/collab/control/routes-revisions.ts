// Control routes: version history and restore (plan M2.4, M2.5). Proxies to
// the server's revisions, revision content, update feed and restore routes;
// the server rebuilds revision text and enforces who may name versions and
// restore (editors and owners, never an AI actor).
//
// A session-end checkpoint is queued as a `revision.create` command instead
// of being posted: it is sent when a window closes a tab, often while the
// network is gone or the window itself is going away, and the queue keeps it
// until the server has it. The server shares one checkpoint per state, so
// several windows ending their sessions at once create one revision.

import { randomBytes } from "node:crypto";

import { ApiRoutes, type CreateRevisionRequest, type RestoreRequest, type UpdatesPage } from "../../../src/lib/collab/protocol/api";
import { ControlRoutes, type EnqueueCommandResponse } from "../../../src/lib/collab/local-api";
import type { Router } from "./router";
import { requireApi } from "./routes-projects";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { bad, objectBody, optionalString, requiredString } from "./validate";

const pattern = {
  revisions: decodeURIComponent(ControlRoutes.revisions(":docId")),
  revisionContent: decodeURIComponent(ControlRoutes.revisionContent(":docId", ":revisionId")),
  docUpdates: decodeURIComponent(ControlRoutes.docUpdates(":docId")),
  restore: decodeURIComponent(ControlRoutes.restore(":docId")),
};

function integerQuery(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export function revisionBody(value: unknown): CreateRevisionRequest {
  const body = value === undefined ? {} : objectBody(value);
  const kind = body.kind;
  if (kind !== undefined && kind !== "named" && kind !== "auto" && kind !== "session-end") throw bad("kind must be named, auto or session-end.");
  const label = optionalString(body.label, "label", 200)?.trim();
  if ((kind ?? "named") === "named" && !label) throw bad("A named version needs a label.");
  return { ...(kind ? { kind } : {}), ...(label ? { label } : {}) };
}

export function restoreBody(value: unknown): RestoreRequest {
  const body = objectBody(value);
  const revisionId = requiredString(body.revisionId, "revisionId", 200);
  if (body.range === undefined || body.range === null) return { revisionId };
  if (typeof body.range !== "object") throw bad("range must be { start, end }.");
  const { start, end } = body.range as Record<string, unknown>;
  if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
    throw bad("range needs integer offsets with 0 <= start <= end.");
  }
  return { revisionId, range: { start: start as number, end: end as number } };
}

export function registerRevisionRoutes(router: Router, runtime: CollabRuntime): void {
  router.add("GET", pattern.revisions, async (request) => ({ body: await requireApi(runtime).listRevisions(request.params.docId) }));

  router.add("POST", pattern.revisions, async (request): Promise<{ status: number; body: unknown }> => {
    const body = revisionBody(request.body);
    if (body.kind === "session-end") {
      if (!runtime.accounts.account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
      const id = `cmd_${randomBytes(12).toString("base64url")}`;
      const queued = runtime.host.commands.enqueue({ id, kind: "revision.create", docId: request.params.docId, body });
      const response: EnqueueCommandResponse = { id, queued };
      return { status: 202, body: response };
    }
    return { status: 201, body: await requireApi(runtime).createRevision(request.params.docId, body) };
  });

  router.add("GET", pattern.revisionContent, async (request) => ({
    body: await requireApi(runtime).getRevisionContent(request.params.docId, request.params.revisionId),
  }));

  // The persisted update feed, for attribution in the diff view.
  router.add("GET", pattern.docUpdates, async (request) => {
    const query = {
      fromSeq: integerQuery(request.query, "fromSeq", 0, Number.MAX_SAFE_INTEGER),
      toSeq: integerQuery(request.query, "toSeq", 0, Number.MAX_SAFE_INTEGER),
      limit: integerQuery(request.query, "limit", 1, 1_000),
      subdoc: optionalString(request.query.get("subdoc") ?? undefined, "subdoc", 40),
    };
    const page = await requireApi(runtime).request<UpdatesPage>("GET", ApiRoutes.documentUpdates(request.params.docId), { query });
    return { body: page };
  });

  router.add("POST", pattern.restore, async (request) => ({
    body: await requireApi(runtime).restore(request.params.docId, restoreBody(request.body)),
  }));
}
