import { parseCitationToken, serializeCitation } from "@/lib/references/citation-syntax";
import { libraryEntriesByKey } from "@/lib/references/format";
import { locatorPages } from "@/lib/references/pages";
import type { CitationItem } from "@/lib/references/types";
import { addReviewComment } from "../skills/leave-review-comments";
import { hashContent } from "../snapshots";
import { suggestEditTool } from "../suggest-edit";
import { plural, ToolError, type ToolContext } from "../tools";
import type { ExistenceReport, ExistenceResult } from "./existence";
import { leafBlocks, type CitationListing, type CitationOccurrenceInfo, type SourceSummary } from "./list-citations";
import { VERDICT_LABELS, VERDICTS, type CheckResult, type Verdict } from "./verdicts";

// The fact-check's output: a review comment on each occurrence with a
// problem, a suggested edit where the fix is concrete (a wrong locator, an
// overstated claim, a wrong key, a missing citation), and the report the
// agent puts in its reply. Comments go into the run's LeaveComment review
// copy and suggestions through SuggestEdit, so the skill's finish pass saves
// both exactly as if the agent had written them.

export type NotChecked = { occurrence: string; key: string; reason: string };

/** A claim without a citation, from the missing-references check. */
export type UncitedClaim = {
  sentence: string;
  range: { start: number; end: number };
  /** Set when a verified passage supports it. */
  citation?: { key: string; locator?: string; quote: string; path: string; page?: number; line?: number };
  note: string;
};

export type FactCheckOutcome = {
  listing: CitationListing;
  checked: Set<string>;
  results: CheckResult[];
  notChecked: NotChecked[];
  existence: ExistenceReport | null;
  uncited: UncitedClaim[] | null;
  /** Why the missing-references check did not run or finish, if so. */
  uncitedNote?: string;
};

const COMMENT_QUOTE_CHARS = 280;

function clip(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function printedPage(source: SourceSummary | undefined, pdfPage: number) {
  return source?.printed ? source.printed.first + pdfPage - 1 : undefined;
}

function pageLabel(source: SourceSummary | undefined, page: number | undefined, line: number | undefined) {
  if (page !== undefined) {
    const printed = printedPage(source, page);
    return printed !== undefined && printed !== page ? `PDF p. ${page}, printed p. ${printed}` : `p. ${page}`;
  }
  return line !== undefined ? `line ${line}` : "";
}

function evidenceLines(result: CheckResult, source: SourceSummary | undefined) {
  return [
    ...result.evidence.slice(0, 2).map((item) => `  > “${clip(item.quote, COMMENT_QUOTE_CHARS)}” (${[item.path, pageLabel(source, item.page, item.line)].filter(Boolean).join(", ")})`),
    ...result.webSources.slice(0, 1).map((item) => `  > “${clip(item.quote, COMMENT_QUOTE_CHARS)}” (web evidence: ${item.title ? `${clip(item.title, 80)}, ` : ""}${item.url})`),
  ];
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

function editDistance(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length];
}

/** The library key an unknown key was most likely meant to be: the only key or alias within two edits (or equal ignoring case). */
export function closestKey(listing: CitationListing, key: string) {
  const keys = Object.keys(libraryEntriesByKey(listing.library));
  const scored = keys.map((candidate) => ({ candidate, distance: candidate.toLowerCase() === key.toLowerCase() ? 0 : editDistance(candidate.toLowerCase(), key.toLowerCase()) }))
    .filter((item) => item.distance <= 2).sort((left, right) => left.distance - right.distance);
  if (!scored.length || (scored[1] && scored[1].distance === scored[0].distance)) return undefined;
  const entry = libraryEntriesByKey(listing.library)[scored[0].candidate];
  return entry?.key ?? scored[0].candidate;
}

function plainItems(items: CitationOccurrenceInfo["items"]): CitationItem[] {
  return items.map((item) => {
    const copy: CitationItem & { entryId?: string } = { ...item };
    delete copy.entryId;
    return copy;
  });
}

/** A citation token the checker proposed, if it parses and cites only library keys. */
function validCitation(listing: CitationListing, token: string | undefined) {
  if (!token) return undefined;
  const parsed = parseCitationToken(token.trim());
  if (!parsed?.items.length) return undefined;
  const byKey = libraryEntriesByKey(listing.library);
  return parsed.items.every((item) => Object.prototype.hasOwnProperty.call(byKey, item.key)) ? serializeCitation(parsed) : undefined;
}

/** The occurrence's citation with each item's locator (or key) replaced as `change` says. */
function rewriteItems(occurrence: CitationOccurrenceInfo, change: (item: CitationItem, index: number) => CitationItem) {
  return serializeCitation({ items: plainItems(occurrence.items).map(change) });
}

/** Whether verified PDF evidence lies on the pages the item's locator names (as PDF pages or printed pages). */
function locatorMatches(item: CitationItem, result: CheckResult, source: SourceSummary | undefined) {
  const wanted = new Set(locatorPages(item));
  if (!wanted.size) return true;
  const pages = result.evidence.flatMap((evidence) => evidence.page === undefined ? [] : [evidence.page]);
  if (!pages.length) return true;
  return pages.some((page) => wanted.has(page) || wanted.has(printedPage(source, page) ?? -1));
}

// ---------------------------------------------------------------------------
// Writing comments and suggestions
// ---------------------------------------------------------------------------

/** The smallest passage around [start, end) that occurs once in the text: the range itself, its sentence, then its block. */
function uniquePassage(text: string, candidates: { start: number; end: number }[]) {
  for (const range of candidates) {
    const passage = text.slice(range.start, range.end);
    if (!passage.trim()) continue;
    const first = text.indexOf(passage);
    if (first === range.start && text.indexOf(passage, first + 1) === -1) return range;
  }
  return null;
}

async function suggest(context: ToolContext, listing: CitationListing, candidates: { start: number; end: number }[], replace: (passage: string, range: { start: number; end: number }) => string, reason: string, comment: string) {
  const range = uniquePassage(listing.text, candidates);
  if (!range) return false;
  const before = listing.text.slice(range.start, range.end);
  const after = replace(before, range);
  if (after === before) return false;
  // SuggestEdit wants a prior Read; the check read the document itself.
  const proxy: ToolContext = { ...context, fileState: new Map([[listing.path, { hash: hashContent(listing.text), partial: false }]]) };
  try {
    await suggestEditTool.run({ path: listing.path, before, after, reason, comment }, proxy);
    return true;
  } catch (error) {
    if (error instanceof ToolError) return false;
    throw error;
  }
}

function comment(context: ToolContext, listing: CitationListing, offset: number, text: string) {
  try {
    addReviewComment(context, listing.path, listing.text, offset, text);
    return true;
  } catch (error) {
    if (error instanceof ToolError) return false;
    throw error;
  }
}

function existenceLine(result: ExistenceResult) {
  const lines: string[] = [];
  if (result.possiblyHallucinated) lines.push(`- @${result.key}: ${result.message}`);
  if (result.mismatch) lines.push(`- @${result.key}: metadata/attachment mismatch. ${result.mismatch.message}`);
  return lines;
}

type Written = { comments: number; suggestions: number; unplaced: string[] };

/** Writes a comment (or a suggestion with its comment) for each occurrence with a problem. */
export async function writeFindings(context: ToolContext, outcome: FactCheckOutcome): Promise<Written> {
  const { listing } = outcome;
  const written: Written = { comments: 0, suggestions: 0, unplaced: [] };
  const notChecked = new Set(outcome.notChecked.map((item) => item.occurrence));
  const existenceByKey = new Map<string, ExistenceResult>();
  for (const result of outcome.existence?.results ?? []) existenceByKey.set(result.entryId, result);

  for (const occurrence of listing.occurrences) {
    if (!outcome.checked.has(occurrence.id) || notChecked.has(occurrence.id)) continue;
    const results = outcome.results.filter((result) => result.occurrence === occurrence.id);
    const lines: string[] = [];
    let rewrite: string | undefined;
    let correction: string | undefined;
    let correctionWhy = "";
    for (const item of occurrence.items) {
      const result = results.find((candidate) => candidate.key === item.key);
      const source = item.entryId ? listing.sources.get(item.entryId) : undefined;
      for (const problem of occurrence.problems.filter((candidate) => candidate.key === item.key)) {
        if (problem.kind === "unknown-key") {
          const near = closestKey(listing, item.key);
          lines.push(`- ${problem.message}${near ? ` Did you mean @${near}?` : ""}`);
          if (near && !correction) {
            correction = rewriteItems(occurrence, (candidate) => candidate.key === item.key ? { ...candidate, key: near } : candidate);
            correctionWhy = `@${item.key} is not in the library; @${near} is.`;
          }
        } else if (problem.kind !== "entry-without-attachment" || !result || result.origin === "static") lines.push(`- ${problem.message}`);
      }
      const existence = item.entryId ? existenceByKey.get(item.entryId) : undefined;
      if (existence) lines.push(...existenceLine(existence));
      if (!result) continue;
      if (result.verdict === "supported" && locatorMatches(item, result, source)) continue;
      if (result.verdict !== "supported" && !(result.origin === "static" && occurrence.problems.some((problem) => problem.key === item.key))) {
        lines.push(`- @${item.key}: ${VERDICT_LABELS[result.verdict]}. ${result.note}`.trimEnd());
        lines.push(...evidenceLines(result, source));
      }
      // A passage on other pages than the locator names: correct the locator.
      if ((result.verdict === "supported" || result.verdict === "partially-supported") && !locatorMatches(item, result, source)) {
        const page = result.evidence.find((evidence) => evidence.page !== undefined)!.page!;
        const locator = String(printedPage(source, page) ?? page);
        if (result.verdict === "supported") {
          lines.push(`- @${item.key}: the passage is on ${pageLabel(source, page, undefined)}, not p. ${item.locator}.`);
          lines.push(...evidenceLines(result, source));
        }
        if (!correction) {
          correction = validCitation(listing, result.suggestedCitation) ?? rewriteItems(occurrence, (candidate) => candidate.key === item.key ? { ...candidate, locator, label: candidate.label ?? "page" } : candidate);
          correctionWhy = `The cited passage is on p. ${locator}, not p. ${item.locator}.`;
        }
      } else if (!correction && result.suggestedCitation && result.verdict !== "supported") {
        const proposed = validCitation(listing, result.suggestedCitation);
        if (proposed && proposed !== occurrence.raw) { correction = proposed; correctionWhy = `The checker proposes ${proposed}.`; }
      }
      if (!rewrite && result.suggestedText && (result.verdict === "partially-supported" || result.verdict === "not-supported" || result.verdict === "contradicted")) {
        rewrite = result.suggestedText;
      }
    }
    if (!lines.length) continue;
    const commentText = [`Citation check: ${occurrence.raw}`, ...lines].join("\n");
    const sentence = occurrence.claimRange;
    const candidates = [sentence, occurrence.blockRange];
    let suggested = false;
    if (rewrite) {
      const token = correction ?? occurrence.raw;
      let replacement = rewrite.includes(occurrence.raw) ? rewrite.replace(occurrence.raw, token) : rewrite;
      if (!replacement.includes(token)) replacement = /[.!?]["'”’)]*$/.test(replacement) ? replacement.replace(/([.!?]["'”’)]*)$/, ` ${token}$1`) : `${replacement} ${token}`;
      suggested = await suggest(context, listing, [sentence], () => replacement, "Reworded to match what the cited source says.", commentText)
        || await suggest(context, listing, [occurrence.blockRange], (passage) => {
          const offset = sentence.start - occurrence.blockRange.start;
          return passage.slice(0, offset) + replacement + passage.slice(offset + (sentence.end - sentence.start));
        }, "Reworded to match what the cited source says.", commentText);
    }
    if (!suggested && correction) {
      const tokenRange = { start: occurrence.start, end: occurrence.end };
      suggested = await suggest(context, listing, [tokenRange, ...candidates], (passage, range) => {
        const offset = occurrence.start - range.start;
        return passage.slice(0, offset) + correction + passage.slice(offset + occurrence.raw.length);
      }, correctionWhy, commentText);
    }
    if (suggested) { written.suggestions++; continue; }
    if (comment(context, listing, occurrence.blockRange.end, commentText)) written.comments++;
    else written.unplaced.push(occurrence.id);
  }

  for (const claim of outcome.uncited ?? []) {
    const block = leafBlocks(listing.text).find((candidate) => candidate.start <= claim.range.start && claim.range.start < candidate.end) ?? claim.range;
    if (claim.citation) {
      const token = `[@${claim.citation.key}${claim.citation.locator ? `, p. ${claim.citation.locator}` : ""}]`;
      const where = [claim.citation.path, claim.citation.page !== undefined ? `p. ${claim.citation.page}` : claim.citation.line !== undefined ? `line ${claim.citation.line}` : ""].filter(Boolean).join(", ");
      const commentText = `Uncited claim. A source in this notebook supports it:\n  > “${clip(claim.citation.quote, COMMENT_QUOTE_CHARS)}” (${where})`;
      const added = await suggest(context, listing, [claim.range], (passage) => /[.!?]["'”’)]*\s*$/.test(passage)
        ? passage.replace(/([.!?]["'”’)]*)(\s*)$/, ` ${token}$1$2`) : `${passage} ${token}`, `Adds a citation for this claim: ${token}.`, commentText);
      if (added) { written.suggestions++; continue; }
    }
    if (comment(context, listing, block.end, "uncited claim — no source found in this notebook")) written.comments++;
  }
  return written;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function buildReport(outcome: FactCheckOutcome, written: Written) {
  const { listing } = outcome;
  const counts = new Map<Verdict, number>();
  for (const result of outcome.results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  const lines = [`**Fact-check of ${listing.path}**`, ""];
  const checkedOccurrences = [...outcome.checked].filter((id) => !outcome.notChecked.some((item) => item.occurrence === id)).length;
  lines.push(`Checked ${plural(outcome.results.length, "citation")} in ${plural(checkedOccurrences, "occurrence")} (of ${listing.occurrences.length}).`);
  const verdictCounts = VERDICTS.filter((verdict) => counts.get(verdict)).map((verdict) => `${VERDICT_LABELS[verdict]} ${counts.get(verdict)}`);
  lines.push(`- **Verdicts:** ${verdictCounts.length ? verdictCounts.join(" · ") : "none"}`);

  const missingLocal = new Map<string, string>();
  for (const occurrence of listing.occurrences) {
    if (!outcome.checked.has(occurrence.id)) continue;
    for (const problem of occurrence.problems) {
      if (problem.kind === "unknown-key") missingLocal.set(problem.key, "not in the library");
      if (problem.kind === "entry-without-attachment" && !missingLocal.has(problem.key)) missingLocal.set(problem.key, "no readable attached file");
    }
  }
  lines.push(`- **Sources not found locally:** ${missingLocal.size ? [...missingLocal].map(([key, why]) => `@${key} (${why})`).join(", ") : "none"}`);

  const existence = outcome.existence;
  const hallucinated = existence?.results.filter((result) => result.possiblyHallucinated) ?? [];
  const mismatches = existence?.results.filter((result) => result.mismatch) ?? [];
  const unreachable = existence?.results.filter((result) => result.status === "unreachable") ?? [];
  if (existence && !existence.online) lines.push(`- **Possibly hallucinated references:** ${existence.note}`);
  else lines.push(`- **Possibly hallucinated references:** ${hallucinated.length ? hallucinated.map((result) => `@${result.key} (${result.message.replace(/^Possibly hallucinated reference: /, "")})`).join("; ") : "none"}`);
  lines.push(`- **Metadata/attachment mismatches:** ${mismatches.length ? mismatches.map((result) => `@${result.key} (${result.mismatch!.message})`).join("; ") : "none"}`);
  if (unreachable.length) lines.push(`- **Existence not checked:** ${unreachable.map((result) => `@${result.key}`).join(", ")} (${unreachable[0].message.replace(/^existence not checked /, "")})`);

  if (outcome.uncited) {
    const cited = outcome.uncited.filter((claim) => claim.citation).length;
    lines.push(`- **Uncited claims:** ${outcome.uncited.length ? `${outcome.uncited.length} (${cited} with a suggested citation)` : "none found"}`);
  } else if (outcome.uncitedNote) lines.push(`- **Uncited claims:** not checked (${outcome.uncitedNote})`);

  const corrected = outcome.results.flatMap((result) => result.evidence.filter((evidence) => evidence.pageCorrected).map(() => result));
  const dropped = outcome.results.reduce((sum, result) => sum + result.dropped.length, 0);
  if (dropped) lines.push(`- **Evidence discarded:** ${plural(dropped, "quote")} could not be found in the cited source${corrected.length ? `; ${plural(corrected.length, "page number")} corrected` : ""}.`);
  lines.push(`- **Written:** ${plural(written.comments, "review comment")} and ${plural(written.suggestions, "suggested edit")} in ${listing.path}${written.unplaced.length ? `; could not place comments for ${written.unplaced.join(", ")}` : ""}.`);

  if (outcome.notChecked.length) {
    const byOccurrence = new Map<string, string>();
    for (const item of outcome.notChecked) if (!byOccurrence.has(item.occurrence)) byOccurrence.set(item.occurrence, item.reason);
    const ids = [...byOccurrence.keys()];
    const raw = new Map(listing.occurrences.map((occurrence) => [occurrence.id, occurrence.raw]));
    lines.push(`- **Not checked:** ${ids.map((id) => `${id} ${raw.get(id) ?? ""}`.trim()).join(", ")} (${[...new Set(byOccurrence.values())].join("; ")}). Say “Continue” to check only these.`);
  }
  return lines.join("\n");
}
