// A shared PDF's marks in Yjs (docs/collaboration/pdf-realtime-plan.md §2).
//
// The viewer keeps working with plain PdfAnnotation lists. This module turns
// a list into CRDT fields and back, and turns "this list became that list"
// into the smallest set of field changes, so one person moving a note and
// another recolouring it both win.
//
// Marks are never removed from the map. Deleting sets `deleted`, which keeps
// text someone was typing into the mark, and stops a sidecar import or a late
// delivery from bringing it back.

import * as Y from "yjs";
import { diffText } from "../../../../electron/collab/notebooks/text-diff";
import { PDF_MARK_TYPES, PDF_STYLE_KEYS, PdfKeys, PdfMarkFields, pdfMarkFieldViolation, type PdfDeletion } from "../protocol/pdf";
import { PDF_SPACE_MAX_HEIGHT, reconcilePdfSpaces } from "../../pdf-space";
import type { PdfAnnotation, PdfAnnotationPoint, PdfAnnotationRect, PdfSpaceAnnotation } from "../../types";

type JsonRecord = Record<string, unknown>;
type MarkMap = Y.Map<unknown>;

/** Who is writing, and which PDF version they see. */
export interface MarkContext {
  accountId: string;
  sourceHash?: string;
}

/** A mark as the CRDT holds it, whatever the viewer shows of it. */
export interface MarkRecord {
  annotation: PdfAnnotation;
  createdBy: string;
  updatedBy: string;
  sourceHash?: string;
  deleted?: PdfDeletion;
}

const ANNOTATION_META_KEYS = new Set(["id", "type", "createdAt", "updatedAt", "space", "text"]);
const KNOWN_TYPES: ReadonlySet<string> = new Set(PDF_MARK_TYPES);

export function marksOf(doc: Y.Doc): Y.Map<MarkMap> {
  return doc.getMap<MarkMap>(PdfKeys.marks);
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Splits an annotation into the groups that merge independently. */
export function markGroups(annotation: PdfAnnotation): { geometry: JsonRecord; style: JsonRecord; space: string | undefined; text: string | undefined } {
  const geometry: JsonRecord = {};
  const style: JsonRecord = {};
  for (const [key, value] of Object.entries(annotation)) {
    if (value === undefined || ANNOTATION_META_KEYS.has(key)) continue;
    (PDF_STYLE_KEYS.includes(key) ? style : geometry)[key] = value;
  }
  return { geometry, style, space: "space" in annotation ? annotation.space : undefined, text: annotation.type === "text" ? annotation.text : undefined };
}

function textOf(mark: MarkMap): Y.Text | null {
  const text = mark.get(PdfMarkFields.text);
  return text instanceof Y.Text ? text : null;
}

/** Reads one mark, or null when it is of a type this version does not know or fails validation. */
export function readMark(mark: MarkMap): MarkRecord | null {
  const type = mark.get(PdfMarkFields.type);
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;
  const fields = { geometry: mark.get(PdfMarkFields.geometry), style: mark.get(PdfMarkFields.style) ?? {}, createdAt: mark.get(PdfMarkFields.createdAt) };
  for (const [field, value] of Object.entries(fields)) if (pdfMarkFieldViolation(type, field, value)) return null;
  const annotation = {
    ...(fields.geometry as JsonRecord),
    ...(fields.style as JsonRecord),
    id: String(mark.get(PdfMarkFields.id)),
    type,
    createdAt: fields.createdAt as string,
    updatedAt: String(mark.get(PdfMarkFields.updatedAt) ?? fields.createdAt),
  } as JsonRecord;
  const space = mark.get(PdfMarkFields.space);
  if (typeof space === "string") annotation.space = space;
  if (type === "text") annotation.text = textOf(mark)?.toString() ?? "";
  const deleted = mark.get(PdfMarkFields.deleted) as PdfDeletion | undefined;
  const sourceHash = mark.get(PdfMarkFields.sourceHash);
  return {
    annotation: annotation as unknown as PdfAnnotation,
    createdBy: String(mark.get(PdfMarkFields.createdBy) ?? ""),
    updatedBy: String(mark.get(PdfMarkFields.updatedBy) ?? mark.get(PdfMarkFields.createdBy) ?? ""),
    ...(typeof sourceHash === "string" ? { sourceHash } : {}),
    ...(deleted ? { deleted } : {}),
  };
}

function shiftPoint(point: PdfAnnotationPoint, dy: number): PdfAnnotationPoint {
  return { ...point, y: point.y + dy };
}

function shiftRect(rect: PdfAnnotationRect, dy: number): PdfAnnotationRect {
  return { ...rect, y: rect.y + dy };
}

/**
 * A mark whose space was deleted while it was being drawn: it stays visible
 * at the cut, which every client works out from the same stored values. Its
 * own fields keep pointing at the space, so restoring the space restores it.
 */
function withoutDeletedSpace(annotation: PdfAnnotation, space: PdfSpaceAnnotation): PdfAnnotation {
  const dy = space.y;
  const rest = { ...annotation } as PdfAnnotation & { space?: string };
  delete rest.space;
  if (rest.type === "ink") return { ...rest, points: rest.points.map((point) => shiftPoint(point, dy)) };
  if (rest.type === "shape") return { ...rest, from: shiftPoint(rest.from, dy), to: shiftPoint(rest.to, dy) };
  if (rest.type === "text") return { ...rest, rect: shiftRect(rest.rect, dy) };
  return rest;
}

/** Paint order: every computer draws the same stack. */
export function compareMarks(a: PdfAnnotation, b: PdfAnnotation): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * What the viewer shows: live marks in paint order, spaces made consistent.
 * This is a pure function of the document, so all clients agree; its result
 * is never written back, which would have clients correcting each other.
 */
export function visibleMarks(records: Iterable<MarkRecord>): PdfAnnotation[] {
  const all = [...records];
  const liveSpaces = all.flatMap((record) => !record.deleted && record.annotation.type === "space" ? [record.annotation] : []).sort(compareMarks);
  // Spaces beyond a page's limits are not shown, and neither may their marks
  // drop to the top of the page: they sit at the cut, like a deleted space's.
  const shown = new Set(reconcilePdfSpaces(liveSpaces).map((space) => space.id));
  const gone = new Map<string, PdfSpaceAnnotation>();
  for (const record of all) {
    const { annotation } = record;
    if (annotation.type === "space" && (record.deleted || !shown.has(annotation.id))) gone.set(annotation.id, annotation);
  }
  const live: PdfAnnotation[] = [];
  const contentBottom = new Map<string, number>();
  for (const record of all) {
    if (record.deleted) continue;
    const { annotation } = record;
    const spaceId = "space" in annotation ? annotation.space : undefined;
    const orphanedFrom = spaceId ? gone.get(spaceId) : undefined;
    if (annotation.type === "space" && gone.has(annotation.id)) continue;
    live.push(orphanedFrom ? withoutDeletedSpace(annotation, orphanedFrom) : annotation);
    if (spaceId && !orphanedFrom) contentBottom.set(spaceId, Math.max(contentBottom.get(spaceId) ?? 0, markBottom(annotation)));
  }
  // A space shrunk while someone drew lower in it still covers what is in it.
  const fitted = live.map((annotation) => {
    const bottom = annotation.type === "space" ? contentBottom.get(annotation.id) : undefined;
    return annotation.type === "space" && bottom !== undefined && bottom > annotation.height ? { ...annotation, height: Math.min(bottom, PDF_SPACE_MAX_HEIGHT) } : annotation;
  });
  return reconcilePdfSpaces(fitted.sort(compareMarks));
}

/** How far down a mark in a space reaches, from the top of the space. */
function markBottom(annotation: PdfAnnotation): number {
  if (annotation.type === "ink") return Math.max(...annotation.points.map((point) => point.y));
  if (annotation.type === "shape") return Math.max(annotation.from.y, annotation.to.y);
  if (annotation.type === "text") return annotation.rect.y + annotation.rect.height;
  return 0;
}

function setIfChanged(mark: MarkMap, key: string, value: unknown) {
  if (value === undefined) {
    if (mark.has(key)) mark.delete(key);
  } else if (!same(mark.get(key), value)) mark.set(key, value);
}

function applyText(text: Y.Text, next: string) {
  const edits = diffText(text.toString(), next);
  // Back to front, so earlier offsets stay valid.
  for (const edit of [...edits].reverse()) {
    if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start);
    if (edit.text) text.insert(edit.start, edit.text);
  }
}

function createMark(marks: Y.Map<MarkMap>, annotation: PdfAnnotation, context: MarkContext): MarkMap {
  const groups = markGroups(annotation);
  const mark = new Y.Map<unknown>();
  mark.set(PdfMarkFields.id, annotation.id);
  mark.set(PdfMarkFields.type, annotation.type);
  mark.set(PdfMarkFields.createdAt, annotation.createdAt);
  mark.set(PdfMarkFields.createdBy, context.accountId);
  mark.set(PdfMarkFields.updatedAt, annotation.updatedAt);
  mark.set(PdfMarkFields.updatedBy, context.accountId);
  mark.set(PdfMarkFields.geometry, groups.geometry);
  mark.set(PdfMarkFields.style, groups.style);
  if (groups.space) mark.set(PdfMarkFields.space, groups.space);
  if (groups.text !== undefined) mark.set(PdfMarkFields.text, new Y.Text(groups.text));
  if (context.sourceHash) mark.set(PdfMarkFields.sourceHash, context.sourceHash);
  marks.set(annotation.id, mark);
  return mark;
}

/** What a commit changed in one mark: enough to undo or redo just that. */
export interface MarkChange {
  id: string;
  before: MarkFieldValues;
  after: MarkFieldValues;
}

/** The fields a change touched. A field that is present and undefined was unset. */
export type MarkFieldValues = Partial<Record<"geometry" | "style" | "space" | "text" | "deleted" | "sourceHash", unknown>>;

function patchMark(mark: MarkMap, next: PdfAnnotation, previous: PdfAnnotation, context: MarkContext): MarkChange | null {
  const before: MarkFieldValues = {};
  const after: MarkFieldValues = {};
  const nextGroups = markGroups(next);
  const previousGroups = markGroups(previous);
  for (const field of ["geometry", "style", "space"] as const) {
    if (same(previousGroups[field], nextGroups[field])) continue;
    before[field] = mark.get(field);
    after[field] = nextGroups[field];
    setIfChanged(mark, field, nextGroups[field]);
  }
  if (nextGroups.text !== undefined && previousGroups.text !== nextGroups.text) {
    let text = textOf(mark);
    if (!text) {
      text = new Y.Text();
      mark.set(PdfMarkFields.text, text);
    }
    before.text = text.toString();
    applyText(text, nextGroups.text);
    after.text = text.toString();
  }
  if (Object.keys(after).length === 0) return null;
  mark.set(PdfMarkFields.updatedAt, next.updatedAt);
  mark.set(PdfMarkFields.updatedBy, context.accountId);
  return { id: next.id, before, after };
}

function deletion(context: MarkContext): PdfDeletion {
  return { by: context.accountId, at: new Date().toISOString() };
}

/**
 * Makes the document match `next`, given that the list was `previous`.
 * Marks in `previous` and not `next` are deleted. Comparing against
 * `previous`, not the document, means a field nobody touched in this gesture
 * keeps whatever a collaborator set meanwhile.
 */
export function applyMarksDiff(doc: Y.Doc, previous: readonly PdfAnnotation[], next: readonly PdfAnnotation[], context: MarkContext, origin: unknown): MarkChange[] {
  const before = new Map(previous.map((annotation) => [annotation.id, annotation]));
  const after = new Set(next.map((annotation) => annotation.id));
  const changes: MarkChange[] = [];
  doc.transact(() => {
    const marks = marksOf(doc);
    for (const annotation of next) {
      const earlier = before.get(annotation.id);
      if (earlier === annotation) continue;
      const mark = marks.get(annotation.id);
      if (!earlier || !mark) {
        if (mark) {
          // Back from the dead: an undo in the viewer's terms, or a paste of the same id.
          const wasDeleted = mark.get(PdfMarkFields.deleted);
          mark.delete(PdfMarkFields.deleted);
          changes.push({ id: annotation.id, before: { deleted: wasDeleted }, after: { deleted: undefined } });
          continue;
        }
        createMark(marks, annotation, context);
        changes.push({ id: annotation.id, before: { deleted: deletion(context) }, after: { deleted: undefined } });
        continue;
      }
      const change = patchMark(mark, annotation, earlier, context);
      if (change) changes.push(change);
    }
    for (const annotation of previous) {
      if (after.has(annotation.id)) continue;
      const mark = marks.get(annotation.id);
      if (!mark || mark.has(PdfMarkFields.deleted)) continue;
      const deleted = deletion(context);
      mark.set(PdfMarkFields.deleted, deleted);
      changes.push({ id: annotation.id, before: { deleted: undefined }, after: { deleted } });
    }
  }, origin);
  return changes;
}

/**
 * Applies one side of a recorded change, skipping any field someone else has
 * changed since: `expected` is what this client left there. Undo reverts only
 * your own work, and a mark never disappears because of undo: creating is
 * undone by deleting, which stays recoverable.
 */
export function applyMarkValues(doc: Y.Doc, id: string, values: MarkFieldValues, expected: MarkFieldValues, context: MarkContext, origin: unknown): Array<keyof MarkFieldValues> {
  const applied: Array<keyof MarkFieldValues> = [];
  doc.transact(() => {
    const mark = marksOf(doc).get(id);
    if (!mark) return;
    for (const [field, value] of Object.entries(values) as Array<[keyof MarkFieldValues, unknown]>) {
      if (field === "text") {
        const text = textOf(mark);
        if (!text || text.toString() !== expected.text) continue;
        applyText(text, String(value ?? ""));
        applied.push(field);
        continue;
      }
      if (!same(mark.get(field), expected[field])) continue;
      setIfChanged(mark, field, value);
      applied.push(field);
    }
    if (applied.length) {
      mark.set(PdfMarkFields.updatedAt, new Date().toISOString());
      mark.set(PdfMarkFields.updatedBy, context.accountId);
    }
  }, origin);
  return applied;
}

/**
 * Moves marks onto the current PDF. Relocated highlights take their new
 * place; the rest stay put, and only stop being flagged as out of date.
 */
export function markVersion(doc: Y.Doc, moves: ReadonlyArray<{ id: string; geometry?: Record<string, unknown> }>, sourceHash: string, context: MarkContext, origin: unknown): void {
  doc.transact(() => {
    const marks = marksOf(doc);
    for (const { id, geometry } of moves) {
      const mark = marks.get(id);
      if (!mark) continue;
      if (geometry) mark.set(PdfMarkFields.geometry, { ...(mark.get(PdfMarkFields.geometry) as JsonRecord), ...geometry });
      mark.set(PdfMarkFields.sourceHash, sourceHash);
      mark.set(PdfMarkFields.updatedAt, new Date().toISOString());
      mark.set(PdfMarkFields.updatedBy, context.accountId);
    }
  }, origin);
}

/** Brings a deleted mark back. */
export function restoreMark(doc: Y.Doc, id: string, context: MarkContext, origin: unknown): boolean {
  let restored = false;
  doc.transact(() => {
    const mark = marksOf(doc).get(id);
    if (!mark || !mark.has(PdfMarkFields.deleted)) return;
    mark.delete(PdfMarkFields.deleted);
    mark.set(PdfMarkFields.updatedAt, new Date().toISOString());
    mark.set(PdfMarkFields.updatedBy, context.accountId);
    restored = true;
  }, origin);
  return restored;
}

/** Adds text typed into a mark that was deleted meanwhile, so it survives in the tombstone. */
export function writeDeletedText(doc: Y.Doc, id: string, value: string, origin: unknown): void {
  doc.transact(() => {
    const text = marksOf(doc).get(id) ? textOf(marksOf(doc).get(id) as MarkMap) : null;
    if (text) applyText(text, value);
  }, origin);
}

/**
 * The marks of a local sidecar still to add, in batches small enough for the
 * server's update limit. A mark that exists, deleted or not, is left alone,
 * so an import never brings a deletion back and repeating one changes nothing.
 */
export function importBatches(doc: Y.Doc, annotations: readonly PdfAnnotation[], batchBytes = 1024 * 1024): PdfAnnotation[][] {
  const marks = marksOf(doc);
  const seen = new Set<string>();
  const batches: PdfAnnotation[][] = [];
  let batch: PdfAnnotation[] = [];
  let bytes = 0;
  for (const annotation of annotations) {
    if (marks.has(annotation.id) || seen.has(annotation.id)) continue;
    seen.add(annotation.id);
    const size = JSON.stringify(annotation).length;
    if (batch.length && bytes + size > batchBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(annotation);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Adds marks to a document inside the caller's transaction. */
export function createMarks(doc: Y.Doc, annotations: readonly PdfAnnotation[], context: MarkContext): void {
  const marks = marksOf(doc);
  for (const annotation of annotations) createMark(marks, annotation, context);
}

/** {@link importBatches} applied directly: one transaction per batch. Returns how many were added. */
export function importMarks(doc: Y.Doc, annotations: readonly PdfAnnotation[], context: MarkContext, origin: unknown, batchBytes?: number): number {
  let added = 0;
  for (const batch of importBatches(doc, annotations, batchBytes)) {
    doc.transact(() => createMarks(doc, batch, context), origin);
    added += batch.length;
  }
  return added;
}

/** Every mark, deleted ones included, for the sidecar copy and for tests. */
export function readAllMarks(doc: Y.Doc): MarkRecord[] {
  const records: MarkRecord[] = [];
  for (const mark of marksOf(doc).values()) {
    if (!(mark instanceof Y.Map)) continue;
    const record = readMark(mark);
    if (record) records.push(record);
  }
  return records;
}
