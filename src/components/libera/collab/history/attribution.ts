// Who wrote what between two revisions (plan M2.4).
//
// The server keeps every update with the actor it bound and the provenance
// the client gave (UpdateRecord). Replaying the content updates in serverSeq
// order through a Y.Doc and watching the Y.Text deltas tells, for each
// character of the newer text, which update inserted it, so changed ranges
// can be coloured by author. AI edits are shown as the feature on behalf of
// its user ("AI rewrite · Minh"), restores as the restore they were.

import * as Y from "yjs";
import type { Actor, AiFeature, Provenance } from "@/lib/collab/protocol/actor";
import type { UpdateRecord, UpdatesPage, UserSummary } from "@/lib/collab/protocol/api";
import { ContentKeys } from "@/lib/collab/protocol/schema";
import { aiFeatureLabel } from "@/lib/collab/review-store/authors";

export interface AttributionAuthor {
  key: string;
  label: string;
  color: string;
  kind: "user" | "ai" | "system";
  userId: string | null;
}

export interface AttributedRange {
  /** UTF-16 offsets in the newer text. */
  start: number;
  end: number;
  author: AttributionAuthor;
}

export interface Attribution {
  /** Text at the older revision, as the replay rebuilt it. */
  before: string;
  /** Text at the newer revision. */
  after: string;
  ranges: AttributedRange[];
  /** Authors that inserted text in the range, in order of first appearance. */
  authors: AttributionAuthor[];
}

const UNKNOWN_COLOR = "#64748b";

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function person(users: ReadonlyMap<string, UserSummary>, userId: string | null | undefined): { name: string; color: string } {
  const user = userId ? users.get(userId) : undefined;
  return { name: user?.displayName ?? "Someone", color: user?.color ?? UNKNOWN_COLOR };
}

/** The author an update is shown as. */
export function updateAuthor(update: Pick<UpdateRecord, "actor" | "provenance" | "userId">, users: ReadonlyMap<string, UserSummary>): AttributionAuthor {
  const actor = update.actor as Actor | null;
  const provenance = (update.provenance ?? null) as Provenance | null;
  if (actor?.kind === "ai" || provenance?.source === "ai") {
    const userId = actor?.kind === "ai" ? actor.onBehalfOf : update.userId;
    const feature = (actor?.kind === "ai" ? actor.feature : provenance?.feature) as AiFeature | undefined;
    const { name, color } = person(users, userId);
    return { key: `ai:${feature ?? "ai"}:${userId ?? ""}`, label: `${aiFeatureLabel(feature)} · ${name}`, color, kind: "ai", userId: userId ?? null };
  }
  if (actor?.kind === "system") {
    const userId = actor.onBehalfOf ?? update.userId;
    const { name, color } = person(users, userId);
    const what = actor.reason === "restore" ? "Restore" : actor.reason === "decision" ? "Accepted suggestion" : actor.reason === "import" ? "Imported" : "Libera";
    return { key: `system:${actor.reason}:${userId ?? ""}`, label: userId ? `${what} · ${name}` : what, color, kind: "system", userId: userId ?? null };
  }
  const userId = actor?.kind === "user" ? actor.userId : update.userId;
  const { name, color } = person(users, userId);
  return { key: `user:${userId ?? ""}`, label: name, color, kind: "user", userId: userId ?? null };
}

/**
 * Replays `updates` (content sub-document, any order) on top of the optional
 * base snapshot: everything up to `fromSeq` builds the older text, each later
 * update up to `toSeq` (all when null) is attributed to its author.
 */
export function attributeUpdates(
  page: { updates: UpdateRecord[]; baseSnapshot?: UpdatesPage["baseSnapshot"] },
  fromSeq: number,
  toSeq: number | null,
  users: ReadonlyMap<string, UserSummary>,
): Attribution {
  const doc = new Y.Doc();
  try {
    const ytext = doc.getText(ContentKeys.source);
    const snapshot = page.baseSnapshot;
    if (snapshot && snapshot.subdoc === "content") Y.applyUpdate(doc, decode(snapshot.state));
    const sorted = page.updates.filter((update) => update.subdoc === "content").sort((a, b) => a.serverSeq - b.serverSeq);
    for (const update of sorted) {
      if (update.serverSeq > fromSeq) break;
      Y.applyUpdate(doc, decode(update.update));
    }
    const before = ytext.toString();
    const owners: (AttributionAuthor | null)[] = new Array(before.length).fill(null);
    let current: AttributionAuthor | null = null;
    const observer = (event: Y.YTextEvent) => {
      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) index += op.retain;
        else if (op.insert !== undefined) {
          const length = typeof op.insert === "string" ? op.insert.length : 1;
          owners.splice(index, 0, ...new Array<AttributionAuthor | null>(length).fill(current));
          index += length;
        } else if (op.delete !== undefined) owners.splice(index, op.delete);
      }
    };
    ytext.observe(observer);
    const authors = new Map<string, AttributionAuthor>();
    for (const update of sorted) {
      if (update.serverSeq <= fromSeq) continue;
      if (toSeq !== null && update.serverSeq > toSeq) break;
      current = updateAuthor(update, users);
      Y.applyUpdate(doc, decode(update.update));
    }
    ytext.unobserve(observer);
    const after = ytext.toString();
    const ranges: AttributedRange[] = [];
    for (let index = 0; index < owners.length; ) {
      const author = owners[index];
      let end = index + 1;
      while (end < owners.length && owners[end]?.key === author?.key) end++;
      if (author) {
        ranges.push({ start: index, end, author });
        if (!authors.has(author.key)) authors.set(author.key, author);
      }
      index = end;
    }
    return { before, after, ranges, authors: [...authors.values()] };
  } finally {
    doc.destroy();
  }
}
