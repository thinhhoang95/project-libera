// Content rules the role matrix alone cannot express (collaboration map §4,
// §10). Updates are applied to a probe copy of the sub-document first; these
// checks compare the probe with the live document key by key.

import * as Y from "yjs";

import {
  AI_FEATURES,
  AlbumSettingKeys,
  albumImageType,
  albumPathError,
  AnnotationKeys,
  bindActor,
  isPlainJsonRecord,
  ManifestKeys,
  manifestPathError,
  MAX_ALBUM_CAPTION_LENGTH,
  PDF_IMMUTABLE_FIELDS,
  PDF_LIVE_SETTING,
  PDF_REQUIRED_FIELDS,
  PdfKeys,
  PdfLimits,
  PdfMarkFields,
  pdfMarkFieldViolation, pdfAnchorViolation as anchorValueViolation, pdfMarkValuesViolation,
  type Actor,
  type AiFeature,
  type ProjectKind,
  type Provenance,
  type ProvenanceSource,
  type Role,
} from "../protocol.js";
import { isClientId } from "../ids.js";

/**
 * Keys each changed Y type reported in the probe transaction (null: an
 * array-like change), using the event types Yjs actually reports.
 */
export type ChangedTypes = Y.Transaction["changed"];
type SharedType = Parameters<ChangedTypes["get"]>[0];

const ANNOTATION_MAPS: readonly string[] = [AnnotationKeys.anchors, AnnotationKeys.suggestions, AnnotationKeys.reviewScopes];

/** Root types that must exist before an update is applied, so `changed` refers to them. */
export const PREDEFINED_MAPS: Record<string, readonly string[]> = {
  annotations: [...ANNOTATION_MAPS, PdfKeys.marks, PdfKeys.imports, PdfKeys.anchors],
  manifest: [ManifestKeys.files, ManifestKeys.settings, ManifestKeys.photos],
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
function rootName(doc: Y.Doc, type: SharedType): string | null {
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
  kind?: string,
): string | null {
  const commenter = role === "commenter";
  for (const [type, keys] of changed) {
    const root = rootName(after, type);
    // A shared PDF's marks belong to everyone who can annotate, unlike
    // comments and suggestions, so the ownership rules below do not apply.
    if (kind === "pdf" && root === PdfKeys.marks) {
      const problem = pdfMarkViolation(before, after, type, keys, accountId, changed);
      if (problem) return problem;
      continue;
    }
    if (kind === "pdf" && root === PdfKeys.imports) {
      const problem = pdfImportViolation(type, keys, accountId);
      if (problem) return problem;
      continue;
    }
    if (kind === "pdf" && root === PdfKeys.anchors) {
      const problem = pdfAnchorViolation(before, type, keys, accountId);
      if (problem) return problem;
      continue;
    }
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
    if (!(type instanceof Y.Map)) return `${root} must be a map.`;
    const afterMap = type;
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
      // Authorship holds for every role: a new record is created by the
      // sender, nobody re-attributes an existing one, and a suggestion's actor
      // is the sender (or an AI acting for the sender). Otherwise an editor
      // could plant comments or suggestions in someone else's name.
      const authorship = authorshipViolation(root, previous, next, accountId);
      if (authorship) return `${root}/${key}: ${authorship}`;
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

function pdfImportViolation(type: SharedType, keys: Set<string | null>, accountId: string): string | null {
  if (type._item !== null) return `${PdfKeys.imports} records must be plain JSON values.`;
  if (!(type instanceof Y.Map)) return `${PdfKeys.imports} must be a map.`;
  for (const key of keys) {
    if (key === null) return `${PdfKeys.imports} must be a map.`;
    const record = type.get(key);
    if (record === undefined) return "Import records are never removed.";
    if (!isPlainJsonRecord(record) || record.by !== accountId || typeof record.at !== "string") return `${PdfKeys.imports}/${key} must say that you imported it.`;
  }
  return null;
}

/** A comment's place on the page: written once, by the person commenting. */
function pdfAnchorViolation(before: Y.Doc, type: SharedType, keys: Set<string | null>, accountId: string): string | null {
  if (type._item !== null) return `${PdfKeys.anchors} records must be plain JSON values.`;
  if (!(type instanceof Y.Map)) return `${PdfKeys.anchors} must be a map.`;
  const previous = before.getMap<unknown>(PdfKeys.anchors);
  for (const key of keys) {
    if (key === null) return `${PdfKeys.anchors} must be a map.`;
    const record = type.get(key);
    if (!isPlainRecord(record)) return `${PdfKeys.anchors}/${key} must be a plain JSON object.`;
    if (previous.has(key) && !sameJson(previous.get(key), record)) return `${PdfKeys.anchors}/${key} cannot change.`;
    if (record.createdBy !== accountId) return `${PdfKeys.anchors}/${key} must be created by you.`;
    const problem = anchorValueViolation(record);
    if (problem) return `${PdfKeys.anchors}/${key}: ${problem}`;
    if (JSON.stringify(record).length > 64 * 1024) return `${PdfKeys.anchors}/${key} is too large.`;
  }
  return null;
}

/** The mark a nested type belongs to, as [the mark's Y.Map, the field holding this type], or null. */
function markOwner(type: Pick<Y.Text, "_item">): Y.Map<unknown> | null {
  const parent = type._item?.parent;
  return parent instanceof Y.Map && parent._item !== null ? parent : null;
}

/**
 * Rules for a change to a PDF's marks. Anyone who can write annotations may
 * change any mark, so this checks shape only: a mark is deleted by setting
 * its `deleted` field and never removed, nobody rewrites who made it, and
 * every value fits its field. Imports use the server's serialized operation,
 * because independently created nested maps cannot merge their children.
 */
function pdfMarkViolation(before: Y.Doc, after: Y.Doc, type: SharedType, keys: Set<string | null>, accountId: string, changed: ChangedTypes): string | null {
  const beforeMarks = before.getMap<unknown>(PdfKeys.marks);
  const afterMarks = after.getMap<unknown>(PdfKeys.marks);

  // The map of marks itself: marks added or replaced.
  if (type._item === null) {
    for (const key of keys) {
      if (key === null) return `${PdfKeys.marks} must be a map.`;
      if (beforeMarks.has(key)) return `${PdfKeys.marks}/${key} cannot be replaced.`;
      const mark = afterMarks.get(key);
      if (mark === undefined) return "Marks are deleted by marking them deleted, not removed.";
      if (!(mark instanceof Y.Map)) return `${PdfKeys.marks}/${key} must be a Y.Map.`;
      if (mark.get(PdfMarkFields.id) !== key) return `${PdfKeys.marks}/${key} must carry its own id.`;
      for (const field of PDF_REQUIRED_FIELDS) if (mark.get(field) === undefined) return `${PdfKeys.marks}/${key} has no ${field}.`;
      if (mark.get(PdfMarkFields.createdBy) !== accountId) return `${PdfKeys.marks}/${key} must be created by you.`;
      // Yjs reports only types that existed before the transaction, so a new
      // mark's fields never reach the per-field branch below.
      const complete = Object.fromEntries([...mark.entries()].map(([field, value]) => [field, value instanceof Y.Text ? value.toString() : value]));
      const invalid = pdfMarkValuesViolation(complete);
      if (invalid) return invalid;
      const markType = String(mark.get(PdfMarkFields.type) ?? "");
      for (const [field, value] of mark.entries()) {
        const problem = pdfFieldValueViolation(key, markType, field, value);
        if (problem) return problem;
      }
      if (mark.has(PdfMarkFields.updatedBy) && mark.get(PdfMarkFields.updatedBy) !== accountId) return "updatedBy must be you.";
      const deleted = mark.get(PdfMarkFields.deleted) as { by?: unknown } | undefined;
      if (deleted && deleted.by !== accountId) return "deleted.by must be you.";
    }
    if (afterMarks.size > PdfLimits.maxMarks) return "This PDF holds too many marks.";
    return null;
  }

  // A note's text.
  if (type instanceof Y.Text) {
    const mark = markOwner(type);
    if (!mark || type._item?.parentSub !== PdfMarkFields.text) return "Only a note's text field may hold text.";
    const previousMark = beforeMarks.get(String(mark._item?.parentSub ?? ""));
    if (!namesAuthor(changed.get(mark as unknown as SharedType), previousMark, accountId)) return "updatedBy must be you.";
    if (type.length > PdfLimits.maxTextLength) return "This note is too long.";
    return null;
  }

  // One mark's fields.
  if (!(type instanceof Y.Map) || type._item?.parent !== afterMarks) return "Marks hold plain values and a note's text.";
  const id = type._item?.parentSub ?? "";
  const previous = beforeMarks.get(id);
  const markType = String(type.get(PdfMarkFields.type) ?? "");
  if (!namesAuthor(keys, previous, accountId)) return "updatedBy must be you.";
  for (const field of keys) {
    if (field === null) return `${PdfKeys.marks}/${id} must be a map.`;
    const value = type.get(field);
    // A write that lost to a concurrent one leaves the earlier value showing,
    // and Yjs picks the winner by client id, so an honest offline edit can
    // lose here. Only a value this update put in place can be forged.
    const standing = previous instanceof Y.Map && sameJson(previous.get(field), value);
    if (field === PdfMarkFields.updatedBy && value !== accountId && !standing) return "updatedBy must be you.";
    if (field === PdfMarkFields.deleted && value !== undefined && (value as { by?: unknown })?.by !== accountId && !standing) return "deleted.by must be you.";
    if (previous instanceof Y.Map && PDF_IMMUTABLE_FIELDS.includes(field) && !sameJson(previous.get(field), value)) return `${field} cannot change.`;
    const problem = pdfFieldValueViolation(id, markType, field, value);
    if (problem) return problem;
  }
  return null;
}

/**
 * A change to a mark says who made it, by writing updatedBy or because that was
 * already this account. The value showing after the merge cannot answer this:
 * a concurrent writer's updatedBy may have won, and refusing would roll back
 * an honest edit. Clients always write the field, so they never rely on the
 * second case for a mark someone else may be changing.
 */
function namesAuthor(keys: Set<string | null> | undefined, previous: unknown, accountId: string): boolean {
  return Boolean(keys?.has(PdfMarkFields.updatedBy)) || (previous instanceof Y.Map && previous.get(PdfMarkFields.updatedBy) === accountId);
}

function pdfFieldValueViolation(id: string, markType: string, field: string, value: unknown): string | null {
  if (field === PdfMarkFields.text) {
    if (markType !== "text" || !(value instanceof Y.Text)) return `${PdfKeys.marks}/${id}/text must be a note's Y.Text.`;
    return value.length > PdfLimits.maxTextLength ? "This note is too long." : null;
  }
  if (value instanceof Y.AbstractType) return `${PdfKeys.marks}/${id}/${field} must be a plain value.`;
  const problem = pdfMarkFieldViolation(markType, field, value);
  return problem ? `${PdfKeys.marks}/${id}: ${problem}` : null;
}

function authorshipViolation(
  root: string,
  previous: JsonRecord | undefined,
  next: JsonRecord | undefined,
  accountId: string,
): string | null {
  if (next === undefined) return null;
  if (previous === undefined && next.createdBy !== accountId) return "New entries must be created by you.";
  if (previous !== undefined && next.createdBy !== previous.createdBy) return "createdBy cannot change.";
  if (root === AnnotationKeys.suggestions) {
    const actor = next.actor as JsonRecord | undefined;
    const actorAccount = actor?.kind === "user" ? actor.userId : actor?.kind === "ai" ? actor.onBehalfOf : undefined;
    if (actorAccount !== next.createdBy) return "The suggestion's actor must be its creator.";
    if (previous !== undefined && !sameJson(previous.actor, next.actor)) return "The suggestion's actor cannot change.";
  }
  return null;
}

/**
 * accepted, rejected and stale are decisions the server makes through
 * RoomService.transact; clients may only create suggestions and withdraw
 * their own (pending or stale). A new suggestion may be created stale: agentic review turns
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
  // An author may withdraw a stale suggestion too: one created stale (an AI
  // edit on an old snapshot) or made stale by the server is exactly what its
  // author replaces with a revised one.
  if (
    (previous.status === "pending" || previous.status === "stale") &&
    next.status === "withdrawn" &&
    previous.createdBy === accountId &&
    next.createdBy === previous.createdBy
  ) {
    return null;
  }
  return `Status cannot change from ${String(previous.status)} to ${String(next.status)}.`;
}

/**
 * Returns a violation message, or null when every changed manifest entry has
 * a safe path. A shared album's manifest holds photos only: flat blob entries
 * with a photo extension, and plain photo records keyed by their fileId.
 */
export function manifestViolation(after: Y.Doc, changed: ChangedTypes, projectKind: ProjectKind = "notebook", accountId = "", role: Role = "viewer", before?: Y.Doc): string | null {
  const album = projectKind === "album";
  for (const [type, keys] of changed) {
    const root = rootName(after, type);
    if (album && root === ManifestKeys.settings) {
      if (!(type instanceof Y.Map)) return "settings must be a map.";
      if (type._item !== null) return "Album settings must be plain values.";
      for (const key of keys) {
        if (key === null) return "settings must be a map.";
        if (key !== AlbumSettingKeys.keepLocation && key !== AlbumSettingKeys.sharePrompts) continue;
        if (role !== "owner") return "Only the album's owner can change what it shares.";
        const value = type.get(key);
        if (value !== undefined && typeof value !== "boolean") return `settings/${key} must be a boolean.`;
      }
      continue;
    }
    if (!album && root === ManifestKeys.settings) {
      if (!(type instanceof Y.Map)) return "settings must be a map.";
      // Marks go to everyone, so the owner decides; and it is one way, because
      // turning it off would strand marks in their documents.
      for (const key of keys) {
        if (key !== PDF_LIVE_SETTING) continue;
        if (role !== "owner") return "Only the notebook's owner can turn on live PDFs.";
        if (type.get(key) !== true) return "Live PDFs cannot be turned off.";
      }
      continue;
    }
    if (root === ManifestKeys.photos) {
      if (!album) return "Only shared albums have photo details.";
      const problem = albumPhotosViolation(after, type, keys, accountId, before);
      if (problem) return problem;
      continue;
    }
    if (root !== ManifestKeys.files) continue;
    if (type._item !== null) return "Manifest entries must be plain JSON values.";
    if (!(type instanceof Y.Map)) return "files must be a map.";
    const files = type;
    for (const key of keys) {
      if (key === null) return "files must be a map.";
      const entry = files.get(key);
      if (entry === undefined) continue;
      if (!isPlainRecord(entry)) return `files/${key} must be a plain JSON object.`;
      const problem = album ? albumEntryViolation(entry) : manifestPathError(entry.path as string);
      if (problem) return `files/${key}: ${problem}`;
      const identity = album ? null : notebookEntryIdentityViolation(entry);
      if (identity) return `files/${key}: ${identity}`;
    }
  }
  return null;
}

/** A document id becomes a file name on every client, so it must be a plain id (the syntax the documents API enforces). */
function notebookEntryIdentityViolation(entry: JsonRecord): string | null {
  if (entry.docId !== undefined && !isClientId(entry.docId)) return "The document id is not a valid id.";
  return null;
}

function albumEntryViolation(entry: JsonRecord): string | null {
  if (entry.kind !== "blob") return "Albums hold photos only.";
  const problem = albumPathError(entry.path as string);
  if (problem) return problem;
  if (typeof entry.mime === "string" && entry.mime !== albumImageType(entry.path as string)) return "The photo's type does not match its name.";
  return null;
}

function albumPhotosViolation(after: Y.Doc, type: SharedType, keys: Set<string | null>, accountId: string, before?: Y.Doc): string | null {
  if (type._item !== null) return "Photo details must be plain JSON values.";
  if (!(type instanceof Y.Map)) return "photos must be a map.";
  const photos = type;
  for (const key of keys) {
    if (key === null) return "photos must be a map.";
    const record = photos.get(key);
    if (record === undefined) continue;
    if (!isPlainRecord(record)) return `photos/${key} must be a plain JSON object.`;
    if (record.fileId !== key) return `photos/${key}: fileId must match its key.`;
    if (typeof record.addedBy !== "string" || !record.addedBy) return `photos/${key}: addedBy is required.`;
    if (before) {
      // Attribution drives what is kept when a contributor leaves: it is set once and never rewritten.
      const previous = before.getMap<unknown>(ManifestKeys.photos).get(key);
      if (isPlainRecord(previous)) {
        if (record.addedBy !== previous.addedBy) return `photos/${key}: addedBy cannot change.`;
      } else {
        const entry = before.getMap<unknown>(ManifestKeys.files).get(key);
        const uploader = isPlainRecord(entry) && typeof entry.createdBy === "string" ? entry.createdBy : undefined;
        if (record.addedBy !== accountId && record.addedBy !== uploader) return `photos/${key}: addedBy must be you.`;
      }
    }
    if (typeof record.caption === "string" && record.caption.length > MAX_ALBUM_CAPTION_LENGTH) return `photos/${key}: the caption is too long.`;
    if (record.originalHash !== undefined && (typeof record.originalHash !== "string" || !/^[0-9a-f]{64}$/.test(record.originalHash))) {
      return `photos/${key}: originalHash must be a sha256.`;
    }
    if (record.updatedBy !== undefined && record.updatedBy !== accountId) return `photos/${key}: updatedBy must be you.`;
  }
  // Details only describe photos the album has.
  const files = after.getMap<unknown>(ManifestKeys.files);
  for (const key of keys) if (key !== null && photos.get(key) !== undefined && !files.has(key)) return `photos/${key} has no photo.`;
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
