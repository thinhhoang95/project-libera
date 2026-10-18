// Version history calls on the local collaboration API (`/api/collab/*` →
// the host's revision routes → the server).

import { ControlRoutes, type DocUpdatesQuery } from "@/lib/collab/local-api";
import type { RestoreRequest, RestoreResponse, Revision, RevisionContent, UpdateRecord, UpdatesPage } from "@/lib/collab/protocol/api";
import { collabClient, type CollabClient } from "@/lib/collab/ui/client";

type Request = CollabClient["request"];

function query(params: DocUpdatesQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface HistoryApi {
  revisions(docId: string): Promise<Revision[]>;
  nameVersion(docId: string, label: string): Promise<Revision>;
  content(docId: string, revisionId: string): Promise<RevisionContent>;
  updates(docId: string, params: DocUpdatesQuery): Promise<UpdatesPage>;
  restore(docId: string, body: RestoreRequest): Promise<RestoreResponse>;
}

export function createHistoryApi(request: Request = collabClient.request): HistoryApi {
  return {
    revisions: (docId) => request<Revision[]>("GET", ControlRoutes.revisions(docId)),
    nameVersion: (docId, label) => request<Revision>("POST", ControlRoutes.revisions(docId), { kind: "named", label }),
    content: (docId, revisionId) => request<RevisionContent>("GET", ControlRoutes.revisionContent(docId, revisionId)),
    updates: (docId, params) => request<UpdatesPage>("GET", `${ControlRoutes.docUpdates(docId)}${query(params)}`),
    restore: (docId, body) => request<RestoreResponse>("POST", ControlRoutes.restore(docId), body),
  };
}

export const historyApi: HistoryApi = createHistoryApi();

/** Every content update up to `toSeq` (all when null), following the feed's pages. */
export async function contentUpdates(api: HistoryApi, docId: string, toSeq: number | null): Promise<{ updates: UpdateRecord[]; baseSnapshot: UpdatesPage["baseSnapshot"] }> {
  const updates: UpdateRecord[] = [];
  let baseSnapshot: UpdatesPage["baseSnapshot"] = null;
  let fromSeq: number | null = 1;
  for (let page = 0; fromSeq !== null && page < 10_000; page++) {
    const result: UpdatesPage = await api.updates(docId, { fromSeq, subdoc: "content", limit: 1000, ...(toSeq === null ? {} : { toSeq }) });
    if (page === 0) baseSnapshot = result.baseSnapshot ?? null;
    updates.push(...result.updates);
    fromSeq = result.nextFromSeq;
  }
  return { updates, baseSnapshot };
}
