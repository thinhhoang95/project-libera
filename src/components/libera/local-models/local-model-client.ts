"use client";

import { apiRequest } from "@/components/libera/api-client";

export type LocalModelId = "search" | "reading" | "read-aloud";

export type LocalModelStatus = {
  id: LocalModelId;
  name: string;
  license: string;
  state: "missing" | "downloading" | "ready" | "error";
  directory: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
};

export function fetchLocalModelStatus(id: LocalModelId) {
  return apiRequest<LocalModelStatus>(`/api/local-models/${id}`);
}

export function startLocalModelDownload(id: LocalModelId) {
  return apiRequest<LocalModelStatus>(`/api/local-models/${id}`, { method: "POST" });
}

export function cancelLocalModelDownload(id: LocalModelId) {
  return apiRequest<LocalModelStatus>(`/api/local-models/${id}`, { method: "DELETE" });
}

// One prompt for the whole app: features ask for a model, and the dialog
// (mounted once) offers its download and shows progress until it is ready.
type GateState = { model: LocalModelId | null };
let gateState: GateState = { model: null };
const gateListeners = new Set<() => void>();
let gateWaiters: Array<{ model: LocalModelId; resolve: (ready: boolean) => void }> = [];

function setGate(next: GateState) {
  gateState = next;
  for (const listener of gateListeners) listener();
}

export function subscribeLocalModelGate(listener: () => void) {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

export function getLocalModelGate() {
  return gateState;
}

/**
 * Called by the dialog when its model became ready (true) or the user closed
 * it (false). A feature waiting for another model gets its turn next.
 */
export function settleLocalModelGate(ready: boolean) {
  const model = gateState.model;
  const settled = gateWaiters.filter((waiter) => waiter.model === model);
  gateWaiters = gateWaiters.filter((waiter) => waiter.model !== model);
  setGate({ model: gateWaiters[0]?.model ?? null });
  for (const waiter of settled) waiter.resolve(ready);
}

/** Resolve true once the model is installed, offering its download first when needed. */
export async function ensureLocalModel(id: LocalModelId): Promise<boolean> {
  try {
    if ((await fetchLocalModelStatus(id)).state === "ready") return true;
  } catch {
    // Show the dialog; it reports the error.
  }

  return new Promise<boolean>((resolve) => {
    gateWaiters.push({ model: id, resolve });
    if (!gateState.model) setGate({ model: id });
  });
}

/** Ask for a model without waiting, such as from a Search panel notice. */
export function openLocalModelDialog(id: LocalModelId) {
  void ensureLocalModel(id);
}
