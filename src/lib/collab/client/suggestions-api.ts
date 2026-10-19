// The local API calls behind suggestion decisions (plan M3.3), through the
// same `/api/collab/*` proxy as every other collaboration route. Kept apart
// from ui/client.ts so a test (or a window without the Next proxy) can talk
// to the host's control API directly by passing its own client.

import {
  ControlRoutes,
  type CreateSuggestionsRequest,
  type CreateSuggestionsResponse,
  type DecideSuggestionsLocalRequest,
  type DecideSuggestionsLocalResponse,
  type RevertSuggestionResponse,
  type SuggestionCommandStatus,
  type SuggestionInfo,
  type WithdrawSuggestionsRequest,
  type WithdrawSuggestionsResponse,
} from "../local-api";
import { createCollabClient, type CollabClient } from "../ui/client";

export interface SuggestionsApi {
  decide(docId: string, body: DecideSuggestionsLocalRequest): Promise<DecideSuggestionsLocalResponse>;
  command(docId: string, commandId: string): Promise<SuggestionCommandStatus>;
  revert(suggestionId: string): Promise<RevertSuggestionResponse>;
  /** The server mirror, including decided suggestions and who decided them. */
  history(docId: string): Promise<SuggestionInfo[]>;
  /** Creates overlay suggestions through the host (agentic review: edits on a session snapshot). */
  create(docId: string, body: CreateSuggestionsRequest): Promise<CreateSuggestionsResponse>;
  /** Withdraws your own pending suggestions through the host. */
  withdraw(docId: string, body: WithdrawSuggestionsRequest): Promise<WithdrawSuggestionsResponse>;
}

export function createSuggestionsApi(client: Pick<CollabClient, "request"> = createCollabClient()): SuggestionsApi {
  return {
    decide: (docId, body) => client.request<DecideSuggestionsLocalResponse>("POST", ControlRoutes.docSuggestionDecisions(docId), body),
    command: (docId, commandId) => client.request<SuggestionCommandStatus>("GET", ControlRoutes.docSuggestionCommand(docId, commandId)),
    revert: (suggestionId) => client.request<RevertSuggestionResponse>("POST", ControlRoutes.suggestionRevert(suggestionId)),
    history: (docId) => client.request<SuggestionInfo[]>("GET", ControlRoutes.docSuggestions(docId)),
    create: (docId, body) => client.request<CreateSuggestionsResponse>("POST", ControlRoutes.docSuggestions(docId), body),
    withdraw: (docId, body) => client.request<WithdrawSuggestionsResponse>("POST", ControlRoutes.docSuggestionsWithdraw(docId), body),
  };
}
