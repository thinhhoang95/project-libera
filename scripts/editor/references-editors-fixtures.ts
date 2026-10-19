// Shared fixtures for the references-editors tests: a small library and a
// mocked fetch for the library, resolve and citation-index routes.

import type { CslItem, ReferenceEntry, ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

const NOW = "2026-10-18T00:00:00.000Z";

export function referenceEntry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

export const SMITH = referenceEntry("ref_1", "smith2020sparse", {
  title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] },
}, { attachments: [{ kind: "pdf", path: "Notes/papers/smith.pdf" }] });
export const SMYTHE = referenceEntry("ref_2", "smythe2021", {
  title: "Dense attention", author: [{ family: "Smythe" }, { family: "Lee" }, { family: "Kim" }], issued: { "date-parts": [[2021]] },
}, { status: "needs-review" });
export const LEE = referenceEntry("ref_3", "lee2019graphs", {
  title: "Graphs", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] },
}, { status: "unresolved" });

export function makeLibrary(entries: ReferenceEntry[] = [SMITH, SMYTHE, LEE], revision = 3): ReferenceLibrary {
  return { version: 1, revision, style: "apa", entries: Object.fromEntries(entries.map((value) => [value.id, value])) };
}

export type FetchLog = { method: string; url: string; body?: unknown }[];

export type MockServer = {
  libraries: Record<string, ReferenceLibrary>;
  requests: FetchLog;
  /** POST /api/references/resolve: return a body (status 200) or a status code. */
  resolve: (input: string) => { candidates: ReferenceEntryInput[]; duplicates: { candidateIndex: number; entryId: string }[] } | number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let added = 0;

function applyOps(library: ReferenceLibrary, ops: ReferenceLibraryOp[]) {
  const entries = { ...library.entries };
  for (const op of ops) {
    if (op.op !== "add") continue;
    added += 1;
    const family = op.entry.csl.author?.[0]?.family?.toLowerCase() ?? "stub";
    const year = op.entry.csl.issued?.["date-parts"]?.[0]?.[0] ?? "";
    const id = `ref_new${added}`;
    entries[id] = referenceEntry(id, `${family}${year}new${added}`, op.entry.csl, {
      identifiers: op.entry.identifiers ?? {}, status: op.entry.status ?? "confirmed", attachments: op.entry.attachments ?? [],
    });
  }
  return { ...library, revision: library.revision + 1, entries };
}

/** Install a fetch that serves the reference routes from `server`. */
export function installReferenceFetch(server: MockServer) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    server.requests.push({ method, url: url.pathname + url.search, body });
    if (url.pathname === "/api/references" && method === "GET") {
      const notebook = url.searchParams.get("notebook") ?? "";
      return json({ library: server.libraries[notebook] ?? makeLibrary([], 0) });
    }
    if (url.pathname === "/api/references" && method === "PATCH") {
      const notebook = String(body?.notebook);
      const next = applyOps(server.libraries[notebook] ?? makeLibrary([], 0), body?.ops as ReferenceLibraryOp[]);
      server.libraries[notebook] = next;
      return json({ library: next });
    }
    if (url.pathname === "/api/references/resolve" && method === "POST") {
      const result = server.resolve(String(body?.input));
      return typeof result === "number" ? json({ error: "Lookup failed." }, result) : json(result);
    }
    return json({ error: "Not found" }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
