// Client calls for reconciliations: the Next routes under /api/collab mirror
// the host's control routes one to one (local-api.ts).

import { ControlRoutes, LOCAL_API_PREFIX, type Reconciliation, type ResolveReconciliationRequest } from "@/lib/collab/local-api";

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LOCAL_API_PREFIX}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | T | null;
  if (!response.ok) {
    const error = (body as { error?: { message?: string } | string } | null)?.error;
    throw new Error(typeof error === "string" ? error : error?.message ?? `Request failed (${response.status}).`);
  }
  return body as T;
}

export function listReconciliations(): Promise<Reconciliation[]> {
  return request<Reconciliation[]>(ControlRoutes.reconciliations);
}

/** Keeps `text` as the document's content; the host applies it as the user's edits and rewrites the file. */
export function resolveReconciliation(id: string, text: string): Promise<{ docId: string; text: string }> {
  const body: ResolveReconciliationRequest = { text };
  return request(ControlRoutes.reconciliation(id), { method: "POST", body: JSON.stringify(body) });
}
