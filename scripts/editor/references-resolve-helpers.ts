import { readFileSync } from "node:fs";
import path from "node:path";
import { HttpClient, type FetchLike } from "../../src/lib/references/resolve/http";
import type { CompletionFn } from "../../src/lib/references/resolve/llm";
import type { ResolveOptions } from "../../src/lib/references/resolve/pipeline";
import { DEFAULT_REFERENCE_SETTINGS, type ReferenceResolveSettings } from "../../src/lib/references/resolve/settings";

// Shared by the resolution tests: recorded upstream responses (fixtures
// under scripts/editor/fixtures/references, fetched once from the live
// services) served by a fake fetch, and mocked model replies.

export const FIXTURE_DIRECTORY = path.join(process.cwd(), "scripts", "editor", "fixtures", "references");

export function fixture(name: string) {
  return readFileSync(path.join(FIXTURE_DIRECTORY, name), "utf8");
}

export type Route = { match: (url: URL) => boolean; respond: (url: URL) => Response | Promise<Response> };

function json(name: string) {
  return () => new Response(fixture(name), { headers: { "content-type": "application/json" } });
}

function text(name: string, contentType: string) {
  return () => new Response(fixture(name), { headers: { "content-type": contentType } });
}

const notFound = () => new Response(JSON.stringify({ status: "error", message: "Resource not found." }), { status: 404 });

/** Every recorded response, routed by host and path; anything else is a 404. */
export const RECORDED_ROUTES: Route[] = [
  { match: (url) => url.host === "api.crossref.org" && decodeURIComponent(url.pathname) === "/works/10.1016/j.neunet.2018.06.008", respond: json("crossref-work-neunet-2018.json") },
  { match: (url) => url.host === "api.crossref.org" && decodeURIComponent(url.pathname) === "/works/10.1016/j.neunet.2014.09.003", respond: json("crossref-work-neunet-2014.json") },
  { match: (url) => url.host === "api.crossref.org" && url.pathname === "/works" && url.searchParams.has("query.bibliographic"), respond: json("crossref-query-overview.json") },
  { match: (url) => url.host === "api.datacite.org" && decodeURIComponent(url.pathname) === "/dois/10.5061/dryad.8515", respond: json("datacite-dryad-8515.json") },
  { match: (url) => url.host === "export.arxiv.org" && url.searchParams.get("id_list") === "1404.7828", respond: text("arxiv-1404.7828.xml", "application/atom+xml") },
  { match: (url) => url.host === "api.openalex.org" && decodeURIComponent(url.pathname) === "/works/doi:10.1016/j.neunet.2014.09.003", respond: json("openalex-work-neunet-2014.json") },
  { match: (url) => url.host === "api.openalex.org" && url.pathname === "/works" && url.searchParams.has("search"), respond: json("openalex-search-overview.json") },
  { match: (url) => url.host === "eutils.ncbi.nlm.nih.gov" && url.pathname.endsWith("/esummary.fcgi") && url.searchParams.get("id") === "23193287", respond: json("pubmed-esummary-23193287.json") },
  { match: (url) => url.host === "eutils.ncbi.nlm.nih.gov" && url.pathname.endsWith("/efetch.fcgi") && url.searchParams.get("id") === "23193287", respond: text("pubmed-efetch-23193287.xml", "text/xml") },
  { match: (url) => url.host === "eutils.ncbi.nlm.nih.gov" && url.pathname.endsWith("/esearch.fcgi") && url.searchParams.get("term") === "PMC3531190[pmcid]", respond: json("pubmed-esearch-PMC3531190.json") },
  { match: (url) => url.host === "openlibrary.org" && url.pathname === "/isbn/9780131103627.json", respond: json("openlibrary-isbn-9780131103627.json") },
  { match: (url) => url.host === "openlibrary.org" && url.pathname === "/authors/OL946967A.json", respond: json("openlibrary-author-OL946967A.json") },
  { match: (url) => url.host === "arxiv.org" && url.pathname === "/abs/1404.7828", respond: text("arxiv-abs-1404.7828.html", "text/html; charset=utf-8") },
];

export type FetchLog = { url: string; init?: RequestInit }[];

/** A fetch that serves `routes` (then the recorded ones) and logs every request. */
export function fixtureFetch(log: FetchLog = [], routes: Route[] = []): FetchLike {
  return async (input, init) => {
    log.push({ url: input, init });
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const url = new URL(input);
    const route = [...routes, ...RECORDED_ROUTES].find((item) => item.match(url));
    return route ? route.respond(url) : notFound();
  };
}

/** A client without waits, so tests never sleep through arXiv's three-second spacing. */
export function testHttpClient(fetch: FetchLike) {
  return new HttpClient({ fetch, sleep: async (_ms, signal) => { if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
}

export function testSettings(overrides: Partial<ReferenceResolveSettings> = {}): ReferenceResolveSettings {
  return { ...DEFAULT_REFERENCE_SETTINGS, ...overrides };
}

export const FIXED_NOW = new Date("2026-10-18T12:00:00.000Z");

/** Options for the pipeline with recorded responses, AI off unless a model double is given. */
export function testOptions(overrides: Partial<ResolveOptions> & { log?: FetchLog; routes?: Route[] } = {}): ResolveOptions {
  const { log, routes, ...rest } = overrides;
  return {
    http: testHttpClient(fixtureFetch(log, routes)),
    settings: testSettings({ useAi: !!overrides.complete }),
    now: () => FIXED_NOW,
    ...rest,
  };
}

export type ModelCall = { messages: { role: string; content: unknown }[]; options?: Parameters<CompletionFn>[1] };

/** A model double: replies in order (the last one repeats) and records each call. */
export function mockModel(replies: (string | { content: string; webCitations?: { url: string }[] })[], calls: ModelCall[] = []): CompletionFn {
  return async (messages, options) => {
    calls.push({ messages, options });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof reply === "string" ? { content: reply } : reply;
  };
}
