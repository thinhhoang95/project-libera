// The local API calls behind suggestion decisions (plan M3.3), through the
// same `/api/collab/*` proxy as every other collaboration route. Kept apart
// from ui/client.ts so a test (or a window without the Next proxy) can talk
// to the host's control API directly by passing its own client.

import {
  ControlRoutes,
  type DecideSuggestionsLocalRequest,
  type DecideSuggestionsLocalResponse,
  type RevertSuggestionResponse,
  type SuggestionCommandStatus,
  type SuggestionInfo,
} from "../local-api";
import { createCollabClient, type CollabClient } from "../ui/client";

export interface SuggestionsApi {
  decide(docId: string, body: DecideSuggestionsLocalRequest): Promise<DecideSuggestionsLocalResponse>;
  command(docId: string, commandId: string): Promise<SuggestionCommandStatus>;
  revert(suggestionId: string): Promise<RevertSuggestionResponse>;
  /** The server mirror, including decided suggestions and who decided them. */
  history(docId: string): Promise<SuggestionInfo[]>;
}

export function createSuggestionsApi(client: Pick<CollabClient, "request"> = createCollabClient()): SuggestionsApi {
  return {
    decide: (docId, body) => client.request<DecideSuggestionsLocalResponse>("POST", ControlRoutes.docSuggestionDecisions(docId), body),
    command: (docId, commandId) => client.request<SuggestionCommandStatus>("GET", ControlRoutes.docSuggestionCommand(docId, commandId)),
    revert: (suggestionId) => client.request<RevertSuggestionResponse>("POST", ControlRoutes.suggestionRevert(suggestionId)),
    history: (docId) => client.request<SuggestionInfo[]>("GET", ControlRoutes.docSuggestions(docId)),
  };
}
