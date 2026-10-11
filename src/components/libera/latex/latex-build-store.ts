"use client";

import { useSyncExternalStore } from "react";
import type { LatexBuildResult } from "@/lib/latex/build";
import type { LatexEngineSetting } from "@/lib/latex/project";

/* Builds are kept per main file outside React, so switching tabs or splitting
 * panes shows the last PDF immediately instead of compiling again. At most one
 * compile per main file is in flight; requests made meanwhile coalesce into
 * one follow-up compile with the newest drafts. */

export type LatexCompilePayload = { engine: LatexEngineSetting; drafts: Record<string, string> };

export type LatexBuildEntry = {
  rootPath: string;
  compiling: boolean;
  /** The newest finished compile. */
  result: LatexBuildResult | null;
  /** Snapshot shown in the viewer: the newest one that produced a PDF. */
  buildId: string | null;
  /** Increments for every finished compile, including failed ones. */
  version: number;
  requestError: string;
};

type Listener = () => void;
export type LatexCompileHooks = {
  /** Called right before the request is sent; returns what to compile. */
  read: () => LatexCompilePayload;
  /** Marks the text the compile saw. */
  onStart?: () => void;
  /** Called synchronously when this compile finishes, before any queued one starts. */
  onFinish?: (result: LatexBuildResult | null) => void;
};
type QueuedCompile = LatexCompileHooks & { resolvers: ((result: LatexBuildResult | null) => void)[] };

const entries = new Map<string, LatexBuildEntry>();
const listeners = new Map<string, Set<Listener>>();
const queued = new Map<string, QueuedCompile>();
const controllers = new Map<string, AbortController>();

function emptyEntry(rootPath: string): LatexBuildEntry {
  return { rootPath, compiling: false, result: null, buildId: null, version: 0, requestError: "" };
}

export function getLatexBuild(rootPath: string) {
  return entries.get(rootPath) ?? emptyEntry(rootPath);
}

function setEntry(rootPath: string, update: (entry: LatexBuildEntry) => LatexBuildEntry) {
  const next = update(getLatexBuild(rootPath));
  entries.set(rootPath, next);
  for (const listener of listeners.get(rootPath) ?? []) listener();
}

function subscribe(rootPath: string, listener: Listener) {
  const set = listeners.get(rootPath) ?? new Set();
  set.add(listener);
  listeners.set(rootPath, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(rootPath);
  };
}

const emptyEntries = new Map<string, LatexBuildEntry>();

export function useLatexBuild(rootPath: string) {
  return useSyncExternalStore(
    (listener) => subscribe(rootPath, listener),
    () => entries.get(rootPath) ?? (emptyEntries.get(rootPath) ?? emptyEntries.set(rootPath, emptyEntry(rootPath)).get(rootPath)!),
    () => emptyEntries.get(rootPath) ?? emptyEntries.set(rootPath, emptyEntry(rootPath)).get(rootPath)!,
  );
}

export function latexPdfUrl(rootPath: string, buildId: string, download = false) {
  return `/api/latex/pdf?path=${encodeURIComponent(rootPath)}&build=${encodeURIComponent(buildId)}${download ? "&download=1" : ""}`;
}

async function runCompile(rootPath: string, job: QueuedCompile) {
  const controller = new AbortController();
  controllers.set(rootPath, controller);
  setEntry(rootPath, (entry) => ({ ...entry, compiling: true, requestError: "" }));
  job.onStart?.();
  const payload = job.read();
  let result: LatexBuildResult | null = null;

  try {
    const response = await fetch("/api/latex/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath, engine: payload.engine, drafts: payload.drafts }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as LatexBuildResult & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Compile failed.");
    result = body;
    setEntry(rootPath, (entry) => ({
      ...entry,
      result: body,
      buildId: body.buildId ?? entry.buildId,
      version: entry.version + 1,
      requestError: "",
    }));
  } catch (error) {
    if (!controller.signal.aborted) {
      setEntry(rootPath, (entry) => ({ ...entry, version: entry.version + 1, requestError: error instanceof Error ? error.message : "Compile failed." }));
    }
  } finally {
    if (controllers.get(rootPath) === controller) controllers.delete(rootPath);
    job.onFinish?.(result);
    for (const resolve of job.resolvers) resolve(result);
    const next = queued.get(rootPath);
    if (next) {
      queued.delete(rootPath);
      void runCompile(rootPath, next);
    } else {
      setEntry(rootPath, (entry) => ({ ...entry, compiling: false }));
    }
  }
}

/** Compile `rootPath`. A request made while another compile runs replaces
 * any queued one, so the follow-up uses the drafts as they are when it starts. */
export function requestLatexCompile(rootPath: string, hooks: LatexCompileHooks) {
  return new Promise<LatexBuildResult | null>((resolve) => {
    if (controllers.has(rootPath)) {
      const existing = queued.get(rootPath);
      queued.set(rootPath, { ...hooks, resolvers: [...(existing?.resolvers ?? []), resolve] });
      return;
    }
    void runCompile(rootPath, { ...hooks, resolvers: [resolve] });
  });
}

export function isLatexCompiling(rootPath: string) {
  return controllers.has(rootPath);
}

export function cancelLatexCompile(rootPath: string) {
  queued.delete(rootPath);
  controllers.get(rootPath)?.abort();
}
