// Helpers the admin commands share: which seqs a sub-document can still be
// rebuilt at, a plain view of each sub-document's state, a forward edit that
// turns one state into another, and a printable line diff.

import type { Kysely } from "kysely";
import * as Y from "yjs";

import type { DB } from "../db/types.js";
import { AnnotationKeys, canonicalJson, ContentKeys, ManifestKeys, MetaKeys, type Subdoc } from "../protocol.js";
import { rewriteText } from "../text/ytext.js";

/** The root types of each sub-document (schema.ts). Text roots first. */
export const SUBDOC_ROOTS: Record<Subdoc, { texts: string[]; maps: string[] }> = {
  content: { texts: [ContentKeys.source], maps: [] },
  annotations: { texts: [], maps: [AnnotationKeys.anchors, AnnotationKeys.suggestions, AnnotationKeys.reviewScopes] },
  meta: { texts: [], maps: [MetaKeys.meta] },
  manifest: { texts: [], maps: [ManifestKeys.files, ManifestKeys.settings] },
};

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface LogBounds {
  /**
   * Seqs at or below this were pruned by retention (or compacted away), for
   * the whole document; null when nothing was. serverSeq is dense per
   * document across sub-documents and retention removes a prefix of it, so
   * this is the lowest seq still in doc_updates or quarantined_updates,
   * minus one.
   */
  pruned: number | null;
  /** Seqs that have a snapshot of this sub-document. */
  snapshotSeqs: number[];
  /** The newest snapshot of this sub-document at or below `pruned`: where the retained log starts. */
  base: number | null;
}

export async function logBounds(db: Kysely<DB>, docId: string, subdoc: Subdoc): Promise<LogBounds> {
  const document = await db.selectFrom("documents").select("last_server_seq").where("id", "=", docId).executeTakeFirst();
  const retained = await db
    .selectFrom("doc_updates")
    .select((eb) => eb.fn.min("server_seq").as("seq"))
    .where("doc_id", "=", docId)
    .executeTakeFirst();
  const quarantined = await db
    .selectFrom("quarantined_updates")
    .select((eb) => eb.fn.min("server_seq").as("seq"))
    .where("doc_id", "=", docId)
    .executeTakeFirst();
  const lows = [retained?.seq, quarantined?.seq].filter((seq) => seq !== null && seq !== undefined).map(Number);
  const lastSeq = Number(document?.last_server_seq ?? 0);
  const prunedUpTo = lows.length > 0 ? Math.min(...lows) - 1 : lastSeq;
  const pruned = prunedUpTo > 0 ? prunedUpTo : null;
  const snapshots = await db
    .selectFrom("doc_snapshots")
    .select("upto_server_seq")
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .orderBy("upto_server_seq")
    .execute();
  const snapshotSeqs = snapshots.map((row) => Number(row.upto_server_seq));
  const below = pruned === null ? [] : snapshotSeqs.filter((seq) => seq <= pruned);
  return { pruned, snapshotSeqs, base: below.length > 0 ? below[below.length - 1] : null };
}

/**
 * Whether loadSubdocState(seq) gives the true state at `seq`. Retention
 * leaves a snapshot at its boundary for every sub-document it pruned, so any
 * seq at or above the pruned prefix is complete; inside it only snapshots
 * at exactly that seq (kept for revisions) are.
 */
export function reconstructible(bounds: LogBounds, seq: number): boolean {
  if (bounds.pruned === null || seq >= bounds.pruned) return true;
  return bounds.snapshotSeqs.includes(seq);
}

export async function requireReconstructible(db: Kysely<DB>, docId: string, subdocs: Subdoc[], seq: number): Promise<void> {
  for (const subdoc of subdocs) {
    const bounds = await logBounds(db, docId, subdoc);
    if (!reconstructible(bounds, seq)) {
      throw new CliError(
        `${subdoc} cannot be rebuilt at serverSeq ${seq}: the log up to ${bounds.pruned} was pruned by retention ` +
          `and there is no snapshot at ${seq}. Snapshots exist at: ${bounds.snapshotSeqs.join(", ") || "none"}.`,
      );
    }
  }
}

/** A plain view of a sub-document: each text root as a string, each map as JSON. */
export interface PlainState {
  texts: Record<string, string>;
  maps: Record<string, Record<string, unknown>>;
}

export function plainState(doc: Y.Doc, subdoc: Subdoc): PlainState {
  const roots = SUBDOC_ROOTS[subdoc];
  const state: PlainState = { texts: {}, maps: {} };
  for (const name of roots.texts) state.texts[name] = doc.getText(name).toString();
  for (const name of roots.maps) state.maps[name] = doc.getMap(name).toJSON();
  return state;
}

export interface MapChange {
  map: string;
  key: string;
  change: "added" | "changed" | "removed";
}

export interface StateChange {
  subdoc: Subdoc;
  texts: Array<{ name: string; before: string; after: string }>;
  maps: MapChange[];
  /** Map values that are nested Yjs types and cannot be copied as JSON. */
  skipped: string[];
}

/** What turning `current` into `target` changes. */
export function compareStates(subdoc: Subdoc, current: Y.Doc, target: Y.Doc): StateChange {
  const before = plainState(current, subdoc);
  const after = plainState(target, subdoc);
  const change: StateChange = { subdoc, texts: [], maps: [], skipped: [] };
  for (const name of SUBDOC_ROOTS[subdoc].texts) {
    if (before.texts[name] !== after.texts[name]) change.texts.push({ name, before: before.texts[name], after: after.texts[name] });
  }
  for (const name of SUBDOC_ROOTS[subdoc].maps) {
    const from = before.maps[name];
    const to = after.maps[name];
    for (const key of Object.keys(to).sort()) {
      if (!(key in from)) change.maps.push({ map: name, key, change: "added" });
      else if (canonicalJson(from[key]) !== canonicalJson(to[key])) change.maps.push({ map: name, key, change: "changed" });
    }
    for (const key of Object.keys(from).sort()) if (!(key in to)) change.maps.push({ map: name, key, change: "removed" });
    target.getMap(name).forEach((value, key) => {
      if (value instanceof Y.AbstractType) change.skipped.push(`${name}.${key}`);
    });
  }
  return change;
}

export function isEmptyChange(change: StateChange): boolean {
  return change.texts.length === 0 && change.maps.length === 0;
}

/**
 * Applies the forward edit that makes `doc` equal `target` in content: the
 * smallest text edits for text roots, and set/delete for map keys. Runs inside
 * the caller's transaction; history is never rewritten.
 */
export function applyState(doc: Y.Doc, target: Y.Doc, subdoc: Subdoc): void {
  for (const name of SUBDOC_ROOTS[subdoc].texts) {
    const wanted = target.getText(name).toString();
    const text = doc.getText(name);
    if (text.toString() !== wanted) rewriteText(text, wanted);
  }
  for (const name of SUBDOC_ROOTS[subdoc].maps) {
    const map = doc.getMap(name);
    const wanted = target.getMap(name);
    const wantedJson = wanted.toJSON();
    for (const [key, value] of Object.entries(wantedJson)) {
      if (wanted.get(key) instanceof Y.AbstractType) continue;
      const existing = map.get(key);
      const existingJson = existing instanceof Y.AbstractType ? undefined : existing;
      if (!map.has(key) || canonicalJson(existingJson) !== canonicalJson(value)) map.set(key, structuredClone(value));
    }
    for (const key of [...map.keys()]) if (!wanted.has(key)) map.delete(key);
  }
}

/** Parses "from..to", "from.." (to the end) or a single seq. */
export function parseRange(text: string | undefined, name: string): { from: number; to: number | null } {
  if (!text) throw new CliError(`${name} needs a range like 120..180.`);
  const match = /^(\d+)(?:\.\.(\d*))?$/.exec(text.trim());
  if (!match) throw new CliError(`${name} must look like 120..180, 120.. or 120.`);
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : match[2] === "" ? null : Number(match[2]);
  if (to !== null && to < from) throw new CliError(`${name}: ${to} is before ${from}.`);
  return { from, to };
}

export function parseSeq(text: string | undefined, name: string): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new CliError(`${name} must be a serverSeq (a whole number).`);
  return Number(text);
}

// ------------------------------------------------------------------ diff

const CONTEXT_LINES = 2;
const MAX_LCS_CELLS = 4_000_000;

/**
 * A unified-style line diff of `before` and `after`: "-" removed, "+" added,
 * " " context. Long unchanged stretches are elided.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Array<[" " | "-" | "+", string]> = [];
  for (const line of a.slice(0, start)) ops.push([" ", line]);
  if (midA.length * midB.length <= MAX_LCS_CELLS) {
    // Longest common subsequence on the changed middle.
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] =
          midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        ops.push([" ", midA[i]]);
        i += 1;
        j += 1;
      } else if (j < midB.length && (i === midA.length || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) {
        ops.push(["+", midB[j]]);
        j += 1;
      } else {
        ops.push(["-", midA[i]]);
        i += 1;
      }
    }
  } else {
    for (const line of midA) ops.push(["-", line]);
    for (const line of midB) ops.push(["+", line]);
  }
  for (const line of a.slice(endA)) ops.push([" ", line]);

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach(([kind], index) => {
    if (kind === " ") return;
    for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(ops.length - 1, index + CONTEXT_LINES); k += 1) keep[k] = true;
  });
  const lines: string[] = [];
  let elided = false;
  ops.forEach(([kind, line], index) => {
    if (keep[index]) {
      lines.push(`${kind} ${line}`);
      elided = false;
    } else if (!elided) {
      lines.push("  …");
      elided = true;
    }
  });
  return lines.length === 1 && lines[0] === "  …" ? [] : lines;
}

/** Human summary of a StateChange. */
export function describeChange(change: StateChange): string[] {
  const lines: string[] = [];
  for (const text of change.texts) {
    lines.push(`${change.subdoc}.${text.name}: ${text.before.length} -> ${text.after.length} characters`);
    lines.push(...lineDiff(text.before, text.after).map((line) => `  ${line}`));
  }
  for (const entry of change.maps) lines.push(`${change.subdoc}.${entry.map}[${entry.key}] ${entry.change}`);
  for (const skipped of change.skipped) lines.push(`${change.subdoc}.${skipped}: nested Yjs type, not restored`);
  return lines;
}
