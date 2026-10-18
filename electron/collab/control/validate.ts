// Request validation for control routes. Next forwards bodies as they came
// from the renderer or the agent, so every field is checked here.

import { AI_FEATURES, type AiFeature, type Provenance, type ProvenanceSource } from "../../../src/lib/collab/protocol/actor";
import { isRole, type Role } from "../../../src/lib/collab/protocol/roles";
import type { TextEdit } from "../../../src/lib/collab/local-api";
import { ControlError } from "./types";

export function bad(message: string): ControlError {
  return new ControlError(400, "bad-request", message);
}

export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Expected a JSON object body.");
  return body as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim()) throw bad(`${name} is required.`);
  if (value.length > max) throw bad(`${name} is too long.`);
  return value;
}

export function optionalString(value: unknown, name: string, max = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw bad(`${name} must be a string.`);
  if (value.length > max) throw bad(`${name} is too long.`);
  return value;
}

export function roleValue(value: unknown, allowOwner: boolean): Role {
  if (!isRole(value) || (!allowOwner && value === "owner")) throw bad("role must be editor, commenter or viewer.");
  return value;
}

export const MAX_EDITS = 10_000;

/**
 * Edits against the current text, ascending and non-overlapping (an
 * insertion may sit at the end of the previous edit).
 */
export function textEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw bad("edits must be a non-empty array.");
  if (value.length > MAX_EDITS) throw bad(`At most ${MAX_EDITS} edits per request.`);
  const edits: TextEdit[] = [];
  let previousEnd = 0;
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") throw bad(`edits[${index}] must be an object.`);
    const { start, end, text, before } = raw as Record<string, unknown>;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
      throw bad(`edits[${index}] needs integer offsets with 0 <= start <= end.`);
    }
    if (typeof text !== "string") throw bad(`edits[${index}].text must be a string.`);
    if (before !== undefined && typeof before !== "string") throw bad(`edits[${index}].before must be a string.`);
    if ((start as number) < previousEnd) throw bad(`edits[${index}] overlaps or precedes the previous edit; send edits in ascending order.`);
    previousEnd = end as number;
    edits.push({ start: start as number, end: end as number, text, ...(before === undefined ? {} : { before }) });
  });
  return edits;
}

const SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>([
  "typing",
  "paste",
  "ai",
  "external-file",
  "restore",
  "import",
  "suggestion",
  "undo",
  "reconcile",
  "system",
]);

export function aiFeature(value: unknown, name: string): AiFeature {
  if (typeof value !== "string" || !AI_FEATURES.includes(value as AiFeature)) throw bad(`${name} must be one of ${AI_FEATURES.join(", ")}.`);
  return value as AiFeature;
}

/**
 * Keeps the descriptive fields of a provenance. suggestionId and
 * suggestedBy are dropped: only the server applies accepted suggestions.
 */
export function provenanceValue(value: unknown): Provenance {
  if (!value || typeof value !== "object") throw bad("provenance is required.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.source !== "string" || !SOURCES.has(raw.source as ProvenanceSource)) throw bad("provenance.source is not valid.");
  const provenance: Provenance = { source: raw.source as ProvenanceSource };
  if (raw.feature !== undefined) provenance.feature = aiFeature(raw.feature, "provenance.feature");
  if (provenance.source === "ai" && !provenance.feature) throw bad("AI edits need provenance.feature.");
  const model = optionalString(raw.model, "provenance.model", 200);
  if (model) provenance.model = model;
  const runId = optionalString(raw.runId, "provenance.runId", 200);
  if (runId) provenance.runId = runId;
  return provenance;
}

export function stringList(value: unknown, name: string, maxItems = 100): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 200)) {
    throw bad(`${name} must be a list of ids.`);
  }
  return value as string[];
}
