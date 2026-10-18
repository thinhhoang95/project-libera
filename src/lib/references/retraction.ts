import { normalizeDoi } from "./identifiers";
import type { CrossrefWork } from "./resolve/crossref";
import type { HttpClient } from "./resolve/http";
import type { ReferenceEntry, RetractionStatus } from "./types";

// Retraction and correction checks (docs/references/plan.md §5, Phase 5).
//
// Crossref answers for every DOI it registered. Its REST API record of a
// work (GET /works/{doi}) carries:
//   - `updated-by`: the notices that amend this work, each
//     `{ DOI, type, label, source, updated: { date-parts }, record-id? }`.
//     Since Crossref took over the Retraction Watch database (2023), its
//     entries appear here too, with `source: "retraction-watch"`; notices
//     the publisher deposited have `source: "publisher"`. Verified on
//     10.1016/S0140-6736(97)11096-0 (October 2026): a `correction` (2004)
//     and a `retraction` (2010), both from Retraction Watch.
//   - `update-to`: on a notice, the work it amends. Some publishers
//     retract in place, so a work can list an update to its own DOI.
//   - `relation`: typed links to other works. Crossref's relation
//     vocabulary has no retraction type today; the handful of names below
//     are matched in case a publisher deposits one.
// Update types seen in the API: retraction, partial_retraction, withdrawal,
// removal, expression_of_concern, correction, corrigendum, erratum,
// addendum, clarification, new_version, reinstatement. A reinstatement
// newer than a retraction cancels it.
//
// The result is a RetractionStatus written to the entry by the
// `check-retractions` job (jobs.ts).

export type RetractionState = RetractionStatus["state"];

/** Crossref update types (lowercase, underscores) → retraction state. Types not listed (new_version…) are ignored. */
export const CROSSREF_UPDATE_STATES: Readonly<Record<string, Exclude<RetractionState, "none">>> = {
  retraction: "retracted",
  partial_retraction: "retracted",
  removal: "retracted",
  withdrawal: "withdrawn",
  expression_of_concern: "expression-of-concern",
  correction: "corrected",
  corrigendum: "corrected",
  erratum: "corrected",
  addendum: "corrected",
  clarification: "corrected",
};

/** Relation names that would mean "this work has such a notice". */
const RELATION_STATES: Readonly<Record<string, Exclude<RetractionState, "none">>> = {
  "is-retracted-by": "retracted",
  "has-retraction": "retracted",
  "is-withdrawn-by": "withdrawn",
  "has-withdrawal": "withdrawn",
  "has-expression-of-concern": "expression-of-concern",
  "is-corrected-by": "corrected",
  "has-correction": "corrected",
  "has-erratum": "corrected",
};

/** How serious a state is: the most serious notice wins. */
export const RETRACTION_SEVERITY: Readonly<Record<RetractionState, number>> = {
  none: 0,
  corrected: 1,
  "expression-of-concern": 2,
  withdrawn: 3,
  retracted: 4,
};

/** The badge text of a state. */
export const RETRACTION_LABELS: Readonly<Record<Exclude<RetractionState, "none">, string>> = {
  retracted: "Retracted",
  corrected: "Corrected",
  "expression-of-concern": "Expression of concern",
  withdrawn: "Withdrawn",
};

/** Retracted, withdrawn or under an expression of concern: citing it needs a warning. */
export function isConcerningRetraction(status: RetractionStatus | undefined | null) {
  return !!status && (status.state === "retracted" || status.state === "withdrawn" || status.state === "expression-of-concern");
}

/** The state shown for an entry, or null when there is nothing to show. */
export function retractionBadgeState(status: RetractionStatus | undefined | null): Exclude<RetractionState, "none"> | null {
  return status && status.state !== "none" ? status.state : null;
}

/** The address of the notice: its URL, else its DOI. */
export function retractionNoticeUrl(status: RetractionStatus | undefined | null) {
  const notice = status?.notice;
  if (!notice) return undefined;
  if (notice.url && /^https?:\/\//i.test(notice.url)) return notice.url;
  return notice.doi ? `https://doi.org/${notice.doi}` : undefined;
}

/** A sentence for tooltips: "Retracted (Retraction, 2010-02-06)". */
export function retractionDescription(status: RetractionStatus | undefined | null) {
  const state = retractionBadgeState(status);
  if (!state) return "";
  const details = [status?.notice?.label, status?.notice?.date].filter(Boolean).join(", ");
  return details ? `${RETRACTION_LABELS[state]} (${details})` : RETRACTION_LABELS[state];
}

type CrossrefUpdate = {
  DOI?: string;
  type?: string;
  label?: string;
  source?: string;
  updated?: { "date-parts"?: (number | null)[][] };
};

/** The work fields the check reads. */
export type CrossrefRetractionWork = Pick<CrossrefWork, "DOI" | "title" | "relation"> & {
  "update-to"?: CrossrefUpdate[];
  "updated-by"?: CrossrefUpdate[];
};

function updateType(type: string | undefined) {
  return (type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isoDate(value: CrossrefUpdate["updated"]) {
  const parts = value?.["date-parts"]?.[0]?.filter((part): part is number => typeof part === "number");
  if (!parts?.length) return undefined;
  const [year, month, day] = parts;
  return [String(year).padStart(4, "0"), month ? String(month).padStart(2, "0") : undefined, month && day ? String(day).padStart(2, "0") : undefined].filter(Boolean).join("-");
}

function humanType(type: string) {
  const text = type.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Candidate = { state: Exclude<RetractionState, "none">; notice: NonNullable<RetractionStatus["notice"]>; date: string };

function better(candidate: Candidate, current: Candidate | null) {
  if (!current) return true;
  const severity = RETRACTION_SEVERITY[candidate.state] - RETRACTION_SEVERITY[current.state];
  if (severity !== 0) return severity > 0;
  // The newest notice of the same kind is the one to show.
  return candidate.date > current.date;
}

/** Retracted titles from publishers that mark the article itself ("RETRACTED: …", "WITHDRAWN: …"). */
const TITLE_MARKS: Array<[RegExp, Exclude<RetractionState, "none">]> = [
  [/^\s*retracted(?:\s+article)?\s*[:.\-–]/i, "retracted"],
  [/^\s*withdrawn(?:\s+article)?\s*[:.\-–]/i, "withdrawn"],
];

/** The retraction status a Crossref work record shows. */
export function retractionFromCrossrefWork(work: CrossrefRetractionWork, checkedAt: string): RetractionStatus {
  const doi = normalizeDoi(work.DOI);
  const updates = [
    ...(work["updated-by"] ?? []),
    // A notice deposited on the work's own DOI (in-place retraction).
    ...(work["update-to"] ?? []).filter((update) => doi && normalizeDoi(update.DOI) === doi),
  ];
  const reinstated = updates
    .filter((update) => updateType(update.type) === "reinstatement")
    .map((update) => isoDate(update.updated) ?? "")
    .sort()
    .at(-1);

  let best: Candidate | null = null;
  for (const update of updates) {
    const type = updateType(update.type);
    const state = CROSSREF_UPDATE_STATES[type];
    if (!state) continue;
    const date = isoDate(update.updated) ?? "";
    // A later reinstatement cancels a retraction or withdrawal.
    if ((state === "retracted" || state === "withdrawn") && reinstated !== undefined && reinstated >= date) continue;
    const noticeDoi = normalizeDoi(update.DOI);
    const label = update.label?.trim() || humanType(type);
    const notice: Candidate["notice"] = {
      ...(noticeDoi && noticeDoi !== doi ? { doi: noticeDoi, url: `https://doi.org/${noticeDoi}` } : {}),
      ...(date ? { date } : {}),
      label: update.source === "retraction-watch" ? `${label} (Retraction Watch)` : label,
    };
    const candidate = { state, notice, date };
    if (better(candidate, best)) best = candidate;
  }

  for (const [name, relations] of Object.entries(work.relation ?? {})) {
    const state = RELATION_STATES[name.toLowerCase()];
    if (!state) continue;
    for (const relation of relations ?? []) {
      const noticeDoi = relation["id-type"]?.toLowerCase() === "doi" ? normalizeDoi(relation.id) : undefined;
      const candidate: Candidate = { state, notice: { ...(noticeDoi ? { doi: noticeDoi, url: `https://doi.org/${noticeDoi}` } : {}), label: humanType(name.replace(/-/g, "_")) }, date: "" };
      if (better(candidate, best)) best = candidate;
    }
  }

  if (!best) {
    const title = work.title?.[0] ?? "";
    const mark = TITLE_MARKS.find(([pattern]) => pattern.test(title));
    if (mark && !reinstated) best = { state: mark[1], notice: { label: "Marked in the title" }, date: "" };
  }

  return best ? { state: best.state, checkedAt, notice: best.notice } : { state: "none", checkedAt };
}

export type RetractionCheckContext = {
  http: HttpClient;
  signal?: AbortSignal;
  /** Sent as `mailto` only when the user set one in Preferences. */
  contactEmail?: string;
  now: () => Date;
  /** Runs one network lookup (the jobs runner limits how many run at once). */
  network?: <T>(task: () => Promise<T>) => Promise<T>;
};

const API = "https://api.crossref.org";

/**
 * Check one DOI against Crossref. null when Crossref does not know the DOI
 * (DataCite and other agencies' DOIs). Responses are not cached: a notice
 * can appear at any time.
 */
export async function checkRetraction(doi: string, ctx: RetractionCheckContext): Promise<RetractionStatus | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const url = new URL(`${API}/works/${encodeURIComponent(normalized)}`);
  if (ctx.contactEmail) url.searchParams.set("mailto", ctx.contactEmail);
  const request = () => ctx.http.getJson<{ message?: CrossrefRetractionWork }>(url.toString(), { signal: ctx.signal, cache: false });
  const payload = await (ctx.network ? ctx.network(request) : request());
  if (!payload?.message) return null;
  return retractionFromCrossrefWork(payload.message, ctx.now().toISOString());
}

/** The DOI the check uses for an entry, or undefined. */
export function entryDoi(entry: Pick<ReferenceEntry, "identifiers" | "csl">) {
  return normalizeDoi(entry.identifiers?.doi) ?? normalizeDoi(typeof entry.csl?.DOI === "string" ? entry.csl.DOI : undefined) ?? undefined;
}

/** Whether a new check result differs from what the entry has, so it needs writing. */
export function retractionChanged(previous: RetractionStatus | undefined, next: RetractionStatus) {
  if (!previous) return true;
  if (previous.state !== next.state) return true;
  const a = previous.notice ?? {};
  const b = next.notice ?? {};
  return a.doi !== b.doi || a.url !== b.url || a.date !== b.date || a.label !== b.label;
}
