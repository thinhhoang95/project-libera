"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { LatexSnippet } from "@/lib/latex/snippets";

/** Saved LaTeX snippets, loaded once per window and shared by every LaTeX
 * editor, its toolbar and its `/name` completion. */

const ENDPOINT = "/api/preferences/latex-snippets";
const NONE: LatexSnippet[] = [];
let snippets: LatexSnippet[] = NONE;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: LatexSnippet[]) {
  snippets = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getLatexSnippets() {
  return snippets;
}

export function loadLatexSnippets() {
  loading ??= apiRequest<{ snippets: LatexSnippet[] }>(ENDPOINT)
    .then((response) => publish(response.snippets))
    // A later call retries; the editor works without snippets meanwhile.
    .catch(() => { loading = null; });
  return loading;
}

export function useLatexSnippets() {
  useEffect(() => { void loadLatexSnippets(); }, []);
  return useSyncExternalStore(subscribe, getLatexSnippets, () => NONE);
}

export async function createLatexSnippet(name: string, body: string) {
  publish((await apiRequest<{ snippets: LatexSnippet[] }>(ENDPOINT, { method: "POST", body: JSON.stringify({ name, body }) })).snippets);
}

export async function renameLatexSnippet(id: string, name: string) {
  publish((await apiRequest<{ snippets: LatexSnippet[] }>(ENDPOINT, { method: "PATCH", body: JSON.stringify({ id, name }) })).snippets);
}

export async function deleteLatexSnippet(id: string) {
  publish((await apiRequest<{ snippets: LatexSnippet[] }>(`${ENDPOINT}?id=${encodeURIComponent(id)}`, { method: "DELETE" })).snippets);
}
