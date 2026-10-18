// Control routes: formal review (plan M3.5) and the project audit log (M3.6).
// Thin proxies to the server's review and audit routes for the signed-in
// account; the server enforces who may request (editors and owners), decide
// (assignees, never an AI actor), close, and read the audit log (owners).
//
// A review decision made while the server cannot be reached is queued as a
// `review.decide` command and replayed on reconnect, like suggestion
// decisions. The server binds the decision to the revision the reviewer read
// (or the latest one), so a replay records what was approved even when the
// text moved on meanwhile; a later change in scope then shows as outdated.
// The renderer learns the replay's outcome from the `command-settled` event.

import { randomUUID } from "node:crypto";

import type { AuditEntry, CreateReviewRequest, DecideReviewRequest, ReviewScope } from "../../../src/lib/collab/protocol/api";
import { ControlRoutes, type AuditPage, type DecideReviewLocalResponse } from "../../../src/lib/collab/local-api";
import { ApiClientError } from "../core/api-client";
import type { Router } from "./router";
import { requireApi } from "./routes-projects";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { bad, objectBody, optionalString, requiredString, stringList } from "./validate";

const pattern = {
  reviews: decodeURIComponent(ControlRoutes.reviews(":docId")),
  decision: decodeURIComponent(ControlRoutes.reviewDecision(":reviewId")),
  close: decodeURIComponent(ControlRoutes.reviewClose(":reviewId")),
  audit: decodeURIComponent(ControlRoutes.audit(":projectId")),
};

/** Same shape the server accepts for client-made ids (ids.ts isClientId). */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** Server pages read per audit request when an action filter skips entries. */
const MAX_AUDIT_SCANS = 10;

function scopeValue(value: unknown): ReviewScope {
  if (!value || typeof value !== "object") throw bad("scope must be { kind: \"document\" } or { kind: \"range\", anchorId, quote }.");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "document") return { kind: "document" };
  if (raw.kind !== "range") throw bad("scope.kind must be document or range.");
  const anchorId = requiredString(raw.anchorId, "scope.anchorId", 80);
  if (!CLIENT_ID.test(anchorId)) throw bad("scope.anchorId is not a valid id.");
  const quote = typeof raw.quote === "string" ? raw.quote : "";
  if (quote.length > 10_000) throw bad("scope.quote is too long.");
  return { kind: "range", anchorId, quote };
}

export function createReviewBody(value: unknown): CreateReviewRequest {
  const body = objectBody(value);
  const assignees = stringList(body.assignees, "assignees", 50);
  if (!assignees?.length) throw bad("Pick at least one reviewer.");
  const note = optionalString(body.note, "note", 5_000)?.trim();
  return { scope: scopeValue(body.scope), assignees: [...new Set(assignees)], ...(note ? { note } : {}) };
}

export function decideReviewBody(value: unknown): DecideReviewRequest & { commandId: string } {
  const body = objectBody(value);
  if (body.decision !== "approved" && body.decision !== "changes-requested") throw bad("decision must be approved or changes-requested.");
  const revisionId = optionalString(body.revisionId, "revisionId", 200);
  const comment = optionalString(body.comment, "comment", 5_000)?.trim();
  const commandId = optionalString(body.commandId, "commandId", 80) ?? `cmd_${randomUUID()}`;
  if (!CLIENT_ID.test(commandId)) throw bad("commandId is not a valid id.");
  return { decision: body.decision, ...(revisionId ? { revisionId } : {}), ...(comment ? { comment } : {}), commandId };
}

function integerQuery(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

/** "review" matches review.request, review.decide and review.close; "review.decide" only itself. */
export function auditActionMatches(action: string, filter: string | undefined): boolean {
  return !filter || action === filter || action.startsWith(`${filter}.`);
}

/** Errors that mean "try again later" rather than "the server said no". */
function unreachable(error: unknown): boolean {
  return error instanceof ApiClientError ? error.transient || error.code === "needs-sign-in" || error.code === "network" : !(error instanceof ControlError);
}

export function registerReviewRoutes(router: Router, runtime: CollabRuntime): void {
  router.add("GET", pattern.reviews, async (request) => ({ body: await requireApi(runtime).listReviews(request.params.docId) }));

  router.add("POST", pattern.reviews, async (request) => ({
    status: 201,
    body: await requireApi(runtime).createReview(request.params.docId, createReviewBody(request.body)),
  }));

  router.add("POST", pattern.decision, async (request): Promise<{ status: number; body: DecideReviewLocalResponse }> => {
    const reviewId = requiredString(request.params.reviewId, "reviewId", 200);
    const { commandId, ...body } = decideReviewBody(request.body);
    if (!runtime.accounts.account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    const host = runtime.host;
    const queue = () => {
      host.commands.enqueue({ id: commandId, kind: "review.decide", reviewId, body });
      return { status: 202, body: { queued: true as const, commandId } };
    };
    const api = host.api;
    // Offline: queue at once rather than waiting for a request to time out.
    if (!api || !runtime.accounts.session || host.connectionState !== "connected") return queue();
    try {
      return { status: 200, body: { queued: false, commandId, review: await api.decideReview(reviewId, body) } };
    } catch (error) {
      if (unreachable(error)) return queue();
      throw error;
    }
  });

  router.add("POST", pattern.close, async (request) => ({ body: await requireApi(runtime).closeReview(request.params.reviewId) }));

  router.add("GET", pattern.audit, async (request): Promise<{ body: AuditPage }> => {
    const api = requireApi(runtime);
    const limit = integerQuery(request.query, "limit", 1, 200) ?? 50;
    const action = optionalString(request.query.get("action") ?? undefined, "action", 100)?.trim() || undefined;
    let before = optionalString(request.query.get("before") ?? undefined, "before", 40);
    if (before !== undefined && !/^\d+$/.test(before)) throw bad("before must be an audit entry id.");
    // The server pages by id without filtering; a filter keeps reading pages
    // until it has a full page of matches (or has read enough to answer).
    const entries: AuditEntry[] = [];
    for (let scan = 0; scan < MAX_AUDIT_SCANS && entries.length < limit; scan++) {
      const page = await api.audit(request.params.projectId, { limit: action ? 200 : limit, ...(before ? { before } : {}) });
      for (const entry of page) {
        before = entry.id;
        if (!auditActionMatches(entry.action, action)) continue;
        entries.push(entry);
        if (entries.length === limit) break;
      }
      if (page.length < (action ? 200 : limit)) {
        // The end of the log, unless the page was cut short by a full result.
        if (entries.length < limit || page.at(-1)?.id === before) return { body: { entries, nextBefore: null } };
        break;
      }
    }
    return { body: { entries, nextBefore: entries.length ? before ?? null : null } };
  });
}
