import { ok, plural, ToolError, type AgentTool } from "../tools";
import type { DroppedEvidence, EvidenceQuote, VerifiedEvidence, WebQuote } from "./evidence";

// Verdicts: what a checker child submits for each (occurrence, cited work)
// pair it was given, through the SubmitVerdicts tool. The schema is strict
// and validated by runSubagents; the tool itself then checks the submission
// against the batch (every pair exactly once, evidence only from the work's
// own files) so mistakes go back to the child for its repair round.

export const VERDICTS = ["supported", "partially-supported", "not-supported", "contradicted", "cannot-verify", "source-missing"] as const;
export type Verdict = typeof VERDICTS[number];

/** Verdicts that assert something about the source, so they need evidence. */
const NEEDS_EVIDENCE: readonly Verdict[] = ["supported", "partially-supported", "contradicted"];

export const VERDICT_LABELS: Record<Verdict, string> = {
  supported: "supported",
  "partially-supported": "partially supported",
  "not-supported": "not supported",
  contradicted: "contradicted",
  "cannot-verify": "cannot verify",
  "source-missing": "source missing",
};

export type SubmittedVerdict = {
  occurrence: string;
  key: string;
  verdict: Verdict;
  evidence: EvidenceQuote[];
  webSources: WebQuote[];
  confidence: number;
  note: string;
  suggestedText?: string;
  suggestedCitation?: string;
};

/** A settled verdict for one (occurrence, work) pair, after evidence verification. */
export type CheckResult = {
  occurrence: string;
  key: string;
  entryId?: string;
  verdict: Verdict;
  /** The checker's verdict when verification changed it. */
  checkerVerdict?: Verdict;
  evidence: VerifiedEvidence[];
  webSources: WebQuote[];
  dropped: (DroppedEvidence | (WebQuote & { reason: string }))[];
  confidence: number;
  note: string;
  suggestedText?: string;
  suggestedCitation?: string;
  /** "checker" for a child's verdict, "static" for one decided without reading (no source to read). */
  origin: "checker" | "static";
};

export const SUBMIT_VERDICTS = "SubmitVerdicts";

const evidenceSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Library path of the source file the quote is from." },
    page: { type: "integer", minimum: 1, description: "PDF page number, as Read shows it (--- Page N ---)." },
    line: { type: "integer", minimum: 1, description: "Line number, for Markdown or text sources." },
    quote: { type: "string", minLength: 1, maxLength: 1_200, description: "The exact words from the source, copied, not paraphrased." },
  },
  required: ["path", "quote"],
  additionalProperties: false,
};

const webSourceSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, description: "A URL WebSearch returned as a cited page." },
    title: { type: "string" },
    quote: { type: "string", minLength: 1, maxLength: 1_200, description: "The exact words from that page's snippet or answer." },
  },
  required: ["url", "quote"],
  additionalProperties: false,
};

export const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          occurrence: { type: "string", pattern: "^c[0-9]+$", description: "The occurrence id, e.g. \"c3\"." },
          key: { type: "string", minLength: 1, description: "The cited work's key, as listed for the occurrence." },
          verdict: { type: "string", enum: [...VERDICTS] },
          evidence: { type: "array", maxItems: 6, items: evidenceSchema, description: "Quotes from the source that show the verdict; required for supported, partially-supported and contradicted." },
          webSources: { type: "array", maxItems: 4, items: webSourceSchema, description: "Web evidence, only from pages WebSearch returned; [] when none." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          note: { type: "string", maxLength: 600, description: "One or two factual sentences: what the source says compared with the claim." },
          suggestedText: { type: "string", maxLength: 2_000, description: "Optional: the claim sentence rewritten to match the source, keeping its citation." },
          suggestedCitation: { type: "string", maxLength: 300, description: "Optional: the corrected citation token, e.g. \"[@smith2020, p. 7]\"." },
        },
        required: ["occurrence", "key", "verdict", "evidence", "webSources", "confidence", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

/** One pair a checker must judge, with the files its evidence may come from. */
export type Assignment = { occurrence: string; key: string; files: string[] };

function samePath(left: string, right: string) {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/** The submit tool for one batch: checks the submission covers exactly the batch's pairs. */
export function submitVerdictsTool(assignments: Assignment[]): AgentTool {
  const pairs = new Map(assignments.map((assignment) => [`${assignment.occurrence}|${assignment.key}`, assignment]));
  return {
    name: SUBMIT_VERDICTS,
    kind: "read",
    description: `Submits your verdicts and ends the check. Call it once, with one verdict for every occurrence and cited work you were given (${plural(assignments.length, "verdict")} in all).

- verdict: supported (the source says what the claim says), partially-supported (part of it, or a weaker or narrower statement), not-supported (the source does not say it), contradicted (the source says otherwise), cannot-verify (the files cannot settle it), source-missing (the source's text is not available).
- evidence: exact quotes from the source with their PDF page (or line for text files). Copy the words; never paraphrase. Required for supported, partially-supported and contradicted.
- webSources: only pages WebSearch returned, with a quote from them; [] otherwise.
- note: one or two short factual sentences.
- suggestedText: when the claim overstates or misstates the source, the claim sentence rewritten to match it, keeping the citation token.
- suggestedCitation: when the locator or key is wrong, the corrected citation token, e.g. "[@smith2020, p. 7]".`,
    parameters: VERDICTS_SCHEMA,
    describe: (args) => `Submitting ${plural(Array.isArray(args.verdicts) ? args.verdicts.length : 0, "verdict")}`,
    async run(args) {
      const verdicts = args.verdicts as SubmittedVerdict[];
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const verdict of verdicts) {
        const id = `${verdict.occurrence}|${verdict.key.replace(/^@/, "")}`;
        const assignment = pairs.get(id);
        if (!assignment) { problems.push(`${verdict.occurrence} / @${verdict.key} was not part of this check.`); continue; }
        if (seen.has(id)) problems.push(`${verdict.occurrence} / @${verdict.key} has more than one verdict.`);
        seen.add(id);
        for (const item of verdict.evidence) {
          if (!assignment.files.some((file) => samePath(file, item.path.trim()))) {
            problems.push(`Evidence for ${verdict.occurrence} / @${verdict.key} cites ${item.path}, which is not a file of @${assignment.key}${assignment.files.length ? ` (${assignment.files.join(", ")})` : ""}.`);
          }
        }
        if (NEEDS_EVIDENCE.includes(verdict.verdict) && !verdict.evidence.length && !verdict.webSources.length) {
          problems.push(`${verdict.occurrence} / @${verdict.key} is ${verdict.verdict} but has no evidence. Quote the passage, or use cannot-verify.`);
        }
      }
      const missing = [...pairs.keys()].filter((id) => !seen.has(id)).map((id) => id.replace("|", " / @"));
      if (missing.length) problems.push(`Missing verdicts for: ${missing.join(", ")}.`);
      if (problems.length) throw new ToolError(problems.join("\n"));
      return ok(`Received ${plural(verdicts.length, "verdict")}. The check is complete.`, plural(verdicts.length, "verdict"));
    },
  };
}

/**
 * Settles a submitted verdict after evidence verification: quotes that were
 * not found are dropped, and a verdict that loses all its evidence becomes
 * cannot-verify ("evidence not found in source").
 */
export function settleVerdict(
  submitted: SubmittedVerdict,
  entryId: string | undefined,
  local: { kept: VerifiedEvidence[]; dropped: DroppedEvidence[] },
  web: { kept: WebQuote[]; dropped: (WebQuote & { reason: string })[] },
): CheckResult {
  const had = submitted.evidence.length + submitted.webSources.length;
  const kept = local.kept.length + web.kept.length;
  const lostAll = (had > 0 && kept === 0) || (NEEDS_EVIDENCE.includes(submitted.verdict) && kept === 0);
  return {
    occurrence: submitted.occurrence,
    key: submitted.key.replace(/^@/, ""),
    ...(entryId ? { entryId } : {}),
    verdict: lostAll ? "cannot-verify" : submitted.verdict,
    ...(lostAll && submitted.verdict !== "cannot-verify" ? { checkerVerdict: submitted.verdict } : {}),
    evidence: local.kept,
    webSources: web.kept,
    dropped: [...local.dropped, ...web.dropped],
    confidence: lostAll ? 0 : submitted.confidence,
    note: lostAll ? "evidence not found in source" : submitted.note.trim(),
    ...(!lostAll && submitted.suggestedText?.trim() ? { suggestedText: submitted.suggestedText.trim() } : {}),
    ...(!lostAll && submitted.suggestedCitation?.trim() ? { suggestedCitation: submitted.suggestedCitation.trim() } : {}),
    origin: "checker",
  };
}
