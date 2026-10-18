// Content rules the role matrix alone cannot express (collaboration map §4,
// §10). Updates are applied to a probe copy of the sub-document first; these
// checks compare the probe with the live document key by key.

import * as Y from "yjs";

import {
  AI_FEATURES,
  AnnotationKeys,
  bindActor,
  ManifestKeys,
  manifestPathError,
  type Actor,
  type AiFeature,
  type Provenance,
  type ProvenanceSource,
  type Role,
} from "../protocol.js";

/**
 * Keys each changed Y type reported in the probe transaction (null: an
 * array-like change). `any` because that is how yjs types Transaction.changed.
 */
export type ChangedTypes = Map<Y.AbstractType<any>, Set<string | null>>;

const ANNOTATION_MAPS: readonly string[] = [AnnotationKeys.anchors, AnnotationKeys.suggestions, AnnotationKeys.reviewScopes];

/** Root types that must exist before an update is applied, so `changed` refers to them. */
export const PREDEFINED_MAPS: Record<string, readonly string[]> = {
  annotations: ANNOTATION_MAPS,
  manifest: [ManifestKeys.files, ManifestKeys.settings],
};

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => sameJson((a as JsonRecord)[key], (b as JsonRecord)[key]));
}

/** Name of the top-level type `type` belongs to, or null when it is not integrated. */
function rootName(doc: Y.Doc, type: Y.AbstractType<any>): string | null {
  let current = type;
  while (current._item !== null) {
    const parent = current._item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    current = parent;
  }
  for (const [name, candidate] of doc.share) if (candidate === current) return name;
  return null;
}

/**
 * Returns a violation message, or null when the annotations update is allowed.
 * `before` is the live document, `after` the probe with the update applied.
 */
export function annotationViolation(
  before: Y.Doc,
  after: Y.Doc,
  changed: ChangedTypes,
  role: Role,
  accountId: string,
): string | null {
  const commenter = role === "commenter";
  for (const [type, keys] of changed) {
    const root = rootName(after, type);
    const tracked = root !== null && ANNOTATION_MAPS.includes(root);
    if (!tracked) {
      // Editors may keep other data in annotations; commenters only touch
      // records whose ownership the server can check.
      if (commenter) return `Commenters may only change ${ANNOTATION_MAPS.join(", ")}.`;
      continue;
    }
    // Records are atomic JSON values. A nested Y type would let a change
    // bypass the per-key checks below.
    if (type._item !== null) return `Entries in ${root} must be plain JSON values.`;
    const beforeMap = before.getMap<unknown>(root);
    const afterMap = type as Y.Map<unknown>;
    for (const key of keys) {
      if (key === null) return `${root} must be a map.`;
      const previous = beforeMap.get(key);
      const next = afterMap.get(key);
      if (next !== undefined && !isPlainRecord(next)) return `Entries in ${root} must be plain JSON objects.`;
      if (previous !== undefined && !isPlainRecord(previous)) {
        if (commenter) return `${root}/${key} belongs to another member.`;
        continue;
      }
      if (sameJson(previous, next)) continue;
      if (commenter) {
        if (previous !== undefined && previous.createdBy !== accountId) {
          return `${root}/${key} belongs to another member.`;
        }
        if (next !== undefined && next.createdBy !== accountId) {
          return `${root}/${key} must be created by you.`;
        }
      }
      if (root === AnnotationKeys.suggestions) {
        const problem = suggestionTransitionViolation(previous, next, accountId);
        if (problem) return `${root}/${key}: ${problem}`;
      }
    }
  }
  return null;
}

/**
 * accepted, rejected and stale are decisions the server makes through
 * RoomService.transact; clients may only create suggestions and withdraw
 * their own. A new suggestion may be created stale: agentic review turns
 * edits computed on an old snapshot whose text has since changed into stale
 * suggestions (hard case 7), so the panel shows what the AI saw.
 */
function suggestionTransitionViolation(
  previous: JsonRecord | undefined,
  next: JsonRecord | undefined,
  accountId: string,
): string | null {
  if (next === undefined) return null;
  if (previous === undefined) {
    return next.status === "pending" || next.status === "stale" ? null : "New suggestions must be pending or stale.";
  }
  if (previous.status === next.status) return null;
  if (
    previous.status === "pending" &&
    next.status === "withdrawn" &&
    previous.createdBy === accountId &&
    next.createdBy === previous.createdBy
  ) {
    return null;
  }
  return `Status cannot change from ${String(previous.status)} to ${String(next.status)}.`;
}

/** Returns a violation message, or null when every changed manifest entry has a safe path. */
export function manifestViolation(after: Y.Doc, changed: ChangedTypes): string | null {
  for (const [type, keys] of changed) {
    if (rootName(after, type) !== ManifestKeys.files) continue;
    if (type._item !== null) return "Manifest entries must be plain JSON values.";
    const files = type as Y.Map<unknown>;
    for (const key of keys) {
      if (key === null) return "files must be a map.";
      const entry = files.get(key);
      if (entry === undefined) continue;
      if (!isPlainRecord(entry)) return `files/${key} must be a plain JSON object.`;
      const problem = manifestPathError(entry.path as string);
      if (problem) return `files/${key}: ${problem}`;
    }
  }
  return null;
}

const PROVENANCE_SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>([
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

function shortString(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}

/**
 * Keeps only the descriptive fields of a client's provenance. suggestionId
 * and suggestedBy are dropped: only the server applies accepted suggestions.
 */
export function sanitizeProvenance(value: unknown): Provenance | undefined {
  if (!isPlainRecord(value)) return undefined;
  const source = value.source;
  if (typeof source !== "string" || !PROVENANCE_SOURCES.has(source as ProvenanceSource)) return undefined;
  const provenance: Provenance = { source: source as ProvenanceSource };
  if (typeof value.feature === "string" && AI_FEATURES.includes(value.feature as AiFeature)) {
    provenance.feature = value.feature as AiFeature;
  }
  const model = shortString(value.model);
  if (model !== undefined) provenance.model = model;
  const runId = shortString(value.runId);
  if (runId !== undefined) provenance.runId = runId;
  return provenance;
}

/** The actor for a client update. Ids come from the session, never from the frame. */
export function actorForUpdate(accountId: string, clientId: string, provenance: Provenance | undefined): Actor {
  if (provenance?.source === "ai" && provenance.feature) {
    return bindActor(accountId, clientId, { feature: provenance.feature, model: provenance.model, runId: provenance.runId });
  }
  return bindActor(accountId, clientId);
}
