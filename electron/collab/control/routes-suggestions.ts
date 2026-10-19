// Control routes: suggestion decisions, revert and the server's suggestion
// mirror (plan M3.3). Thin proxies to the collab server for the signed-in
// account, plus the offline path: a decision made while the server cannot be
// reached is persisted as a `suggestions.decide` command in the host's
// pending queue and replayed on reconnect. The server checks every decision
// against the text as it is when the decision runs (a replayed accept whose
// text changed comes back "stale"), so queueing never needs a local check.
//
// Settled replays are pushed to every window as `suggestions-settled` host
// events and kept for GET …/commands/:commandId, so a window that missed the
// event (opened later, reloaded) can still learn the outcome.

import { randomUUID } from "node:crypto";

import type { AiActorHint } from "../../../src/lib/collab/protocol/actor";
import type { DecideSuggestionsRequest, DecideSuggestionsResponse, DecisionKind } from "../../../src/lib/collab/protocol/api";
import {
  ControlRoutes,
  type DecideSuggestionsLocalResponse,
  type SuggestionCommandStatus,
} from "../../../src/lib/collab/local-api";
import { ApiClientError } from "../core/api-client";
import type { CollabHost } from "../core/host";
import type { Router } from "./router";
import { requireApi } from "./routes-projects";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { aiFeature, bad, objectBody, optionalString, requiredString } from "./validate";

const pattern = {
  suggestions: decodeURIComponent(ControlRoutes.docSuggestions(":docId")),
  decisions: decodeURIComponent(ControlRoutes.docSuggestionDecisions(":docId")),
  command: decodeURIComponent(ControlRoutes.docSuggestionCommand(":docId", ":commandId")),
  revert: decodeURIComponent(ControlRoutes.suggestionRevert(":suggestionId")),
};

/** Same shape the server accepts for client-made ids (ids.ts isClientId). */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_DECISIONS = 1000;
/** Settled results kept for windows that missed the event. */
const MAX_RESULTS = 500;

type Settled = Extract<SuggestionCommandStatus, { state: "settled" }>;

function decisionsBody(value: unknown): DecideSuggestionsRequest & { commandId: string } {
  const body = objectBody(value);
  const raw = body.decisions;
  if (!Array.isArray(raw) || raw.length === 0) throw bad("decisions must be a non-empty array.");
  if (raw.length > MAX_DECISIONS) throw bad(`At most ${MAX_DECISIONS} decisions per request.`);
  const decisions = raw.map((item, index) => {
    if (!item || typeof item !== "object") throw bad(`decisions[${index}] must be an object.`);
    const { suggestionId, decision } = item as Record<string, unknown>;
    if (typeof suggestionId !== "string" || !CLIENT_ID.test(suggestionId)) throw bad(`decisions[${index}].suggestionId is not a valid id.`);
    if (decision !== "accept" && decision !== "reject") throw bad(`decisions[${index}].decision must be accept or reject.`);
    return { suggestionId, decision: decision as DecisionKind };
  });
  if (body.checkpoint !== undefined && typeof body.checkpoint !== "boolean") throw bad("checkpoint must be a boolean.");
  const commandId = optionalString(body.commandId, "commandId", 80) ?? `cmd_${randomUUID()}`;
  if (!CLIENT_ID.test(commandId)) throw bad("commandId is not a valid id.");
  // An AI hint is forwarded only so the server refuses it (ai-cannot-decide).
  let ai: AiActorHint | undefined;
  if (body.ai !== undefined && body.ai !== null) {
    if (typeof body.ai !== "object") throw bad("ai must be an object.");
    ai = { feature: aiFeature((body.ai as Record<string, unknown>).feature, "ai.feature") };
  }
  return { decisions, ...(body.checkpoint === undefined ? {} : { checkpoint: body.checkpoint }), ...(ai ? { ai } : {}), commandId };
}

function assertKnownDoc(runtime: CollabRuntime, docId: string): void {
  const store = runtime.host.store;
  if (!store.getDoc(docId) && !store.getDocMeta(docId)) throw new ControlError(404, "unknown-doc", `Document ${docId} is not shared with this machine.`);
}

/** Errors that mean "try again later" rather than "the server said no". */
function unreachable(error: unknown): boolean {
  return error instanceof ApiClientError ? error.transient || error.code === "needs-sign-in" || error.code === "network" : !(error instanceof ControlError);
}

export function registerSuggestionRoutes(router: Router, runtime: CollabRuntime): void {
  const results = new Map<string, Settled>();
  const commandDocs = new Map<string, string>();
  let watched: { host: CollabHost; off: () => void } | null = null;

  const remember = (commandId: string, settled: Settled) => {
    results.set(commandId, settled);
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
  };

  /**
   * Follows the current host's command queue. The host is replaced when the
   * account changes, so this is checked on every request; commands queued by
   * an earlier run of the host are picked up from the persisted queue.
   */
  const watch = (): CollabHost => {
    const host = runtime.host;
    if (watched?.host === host) return host;
    watched?.off();
    for (const row of host.commands.list()) if (row.command.kind === "suggestions.decide") commandDocs.set(row.id, row.command.docId);
    const off = host.on((event) => {
      if (event.source !== "commands" || event.event.type !== "settled" || event.event.kind !== "suggestions.decide") return;
      const { id, ok, status, body, error } = event.event;
      const docId = commandDocs.get(id);
      commandDocs.delete(id);
      const settled: Settled = {
        state: "settled",
        ok,
        status,
        ...(ok && body && typeof body === "object" ? { response: body as DecideSuggestionsResponse } : {}),
        ...(error ? { error } : {}),
      };
      remember(id, settled);
      if (docId) runtime.emit({ t: "suggestions-settled", docId, commandId: id, status: settled });
    });
    watched = { host, off };
    return host;
  };

  // The server mirror: pending, stale and decided suggestions with who decided.
  router.add("GET", pattern.suggestions, async (request) => {
    assertKnownDoc(runtime, request.params.docId);
    watch();
    return { body: await requireApi(runtime).listSuggestions(request.params.docId) };
  });

  router.add("POST", pattern.decisions, async (request): Promise<{ status: number; body: DecideSuggestionsLocalResponse }> => {
    const docId = requiredString(request.params.docId, "docId", 200);
    const { commandId, ...body } = decisionsBody(request.body);
    if (!runtime.accounts.account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    assertKnownDoc(runtime, docId);
    const host = watch();
    const queue = () => {
      commandDocs.set(commandId, docId);
      host.commands.enqueue({ id: commandId, kind: "suggestions.decide", docId, body });
      return { status: 202, body: { queued: true as const, commandId } };
    };
    const api = runtime.host.api;
    // Offline: queue at once rather than waiting for a request to time out.
    if (!api || !runtime.accounts.session || runtime.host.connectionState !== "connected") return queue();
    try {
      const response = await api.decideSuggestions(docId, body);
      return { status: 200, body: { queued: false, commandId, ...response } };
    } catch (error) {
      if (unreachable(error)) return queue();
      throw error;
    }
  });

  router.add("GET", pattern.command, (request): { body: SuggestionCommandStatus } => {
    const host = watch();
    const { commandId } = request.params;
    const settled = results.get(commandId);
    if (settled) return { body: settled };
    if (host.commands.list().some((row) => row.id === commandId)) return { body: { state: "pending" } };
    return { body: { state: "unknown" } };
  });

  // "Undo acceptance": the server restores baseQuote if the accepted text is
  // still there and reports a conflict otherwise. There is no offline form.
  router.add("POST", pattern.revert, async (request) => {
    const suggestionId = request.params.suggestionId;
    if (!CLIENT_ID.test(suggestionId)) throw bad("suggestionId is not a valid id.");
    return { body: await requireApi(runtime).revertSuggestion(suggestionId) };
  });
}
