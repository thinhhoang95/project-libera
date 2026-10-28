import { formatClock as clock } from "@/lib/transcription/format";
import type { TimedWord } from "@/lib/transcription/plan";
import type { RecapBullet } from "@/lib/recording/types";

/**
 * The live recap is amended, never rewritten: each update shows the model the
 * bullets so far (with their ids) and only the transcript it has not read yet,
 * and the model answers with a few operations, adding a bullet or changing
 * one by id. Bullets are never removed, so what the reader has already seen
 * stays where it was.
 *
 * The reader can write in the recap too (RecapEdit): change a bullet, break
 * it in two, join two, add or remove one. A bullet the reader touched is
 * theirs: it is marked for the model, and the model's changes to it are
 * dropped.
 */

/** Transcript a recap update waits for, unless the recording ends. */
export const RECAP_MIN_NEW_WORDS = 90;
export const RECAP_MIN_INTERVAL_MS = 40_000;
/** The most transcript sent at once; a longer backlog is read over several updates. */
export const RECAP_MAX_NEW_WORDS = 1_800;
const CONTEXT_WORDS = 250;
const MAX_OPERATIONS = 4;
const MAX_BULLET_LENGTH = 280;

export type RecapOperation = { op: "add"; text: string } | { op: "update"; id: number; text: string };

export const RECAP_SYSTEM_PROMPT = `You keep a live recap of a meeting or talk while it is being recorded. The recap is a list of short bullet points that people read during the meeting, so it must stay stable: you amend it one bullet at a time and never rewrite it.

Each time, you get the bullets so far, each with its id, and the newest part of the transcript. Reply with JSON only, no code fences:
{"operations": [{"op": "add", "text": "..."}, {"op": "update", "id": 3, "text": "..."}]}

Rules:
- "add" appends a new bullet for a new topic, decision, number, question or action item.
- "update" replaces the text of an existing bullet, only when the new transcript adds to it or corrects it. Keep what the bullet already said unless it was wrong.
- Never delete bullets, never reorder them, never repeat a point that is already there.
- Bullets marked * after their id were written or corrected by a person: never update them.
- At most ${MAX_OPERATIONS} operations. When the new transcript adds nothing worth noting (small talk, filler, a repeat), reply {"operations": []}.
- Each bullet is one plain sentence of at most 25 words, in the language of the transcript. Name who decided or owns something when the transcript says so. No Markdown, no leading dash.
- The transcript comes from speech recognition: fix obvious misheard words from context, and do not invent anything that was not said.`;

/** Words as lines of about twenty, each with its time, so the model can tell where it is. */
function transcriptLines(words: TimedWord[]) {
  const lines: string[] = [];
  for (let index = 0; index < words.length; index += 20) {
    const slice = words.slice(index, index + 20);
    lines.push(`[${clock(slice[0].start)}] ${slice.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1")}`);
  }
  return lines.join("\n");
}

export function recapUserMessage(bullets: RecapBullet[], earlier: TimedWord[], fresh: TimedWord[]) {
  const list = bullets.length ? bullets.map((bullet) => `[${bullet.id}${bullet.edited ? "*" : ""}] ${bullet.text}`).join("\n") : "(none yet)";
  const context = earlier.slice(-CONTEXT_WORDS);
  return `Bullets so far:
${list}
${context.length ? `
Transcript just before (already in the recap, for context only):
${transcriptLines(context)}
` : ""}
New transcript:
${transcriptLines(fresh)}`;
}

/** The operations in a model reply; anything malformed is dropped. */
export function parseRecapOperations(reply: string, knownIds: Set<number>): RecapOperation[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const operations = (parsed as { operations?: unknown })?.operations;
  if (!Array.isArray(operations)) return [];
  const result: RecapOperation[] = [];
  for (const entry of operations) {
    if (!entry || typeof entry !== "object") continue;
    const { op, id, text } = entry as { op?: unknown; id?: unknown; text?: unknown };
    const clean = typeof text === "string" ? text.replace(/^\s*[-*•]\s*/, "").replace(/\s+/g, " ").trim().slice(0, MAX_BULLET_LENGTH) : "";
    if (!clean) continue;
    if (op === "add") result.push({ op: "add", text: clean });
    else if (op === "update" && typeof id === "number" && knownIds.has(id)) result.push({ op: "update", id, text: clean });
    if (result.length >= MAX_OPERATIONS) break;
  }
  return result;
}

/** The bullets after the operations, and the ids that changed. */
export function applyRecapOperations(bullets: RecapBullet[], operations: RecapOperation[], at: number) {
  const next = bullets.map((bullet) => ({ ...bullet }));
  const changed = new Set<number>();
  let nextId = next.reduce((highest, bullet) => Math.max(highest, bullet.id), 0) + 1;
  const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const operation of operations) {
    if (operation.op === "update") {
      const bullet = next.find((candidate) => candidate.id === operation.id);
      if (!bullet || bullet.text === operation.text) continue;
      bullet.text = operation.text;
      bullet.changedAt = at;
      changed.add(bullet.id);
    } else if (!next.some((bullet) => normalized(bullet.text) === normalized(operation.text))) {
      next.push({ id: nextId, text: operation.text, addedAt: at, changedAt: at });
      changed.add(nextId);
      nextId += 1;
    }
  }
  return { bullets: next, changed: [...changed] };
}

/** The reader's changes to the recap. New bullets carry a negative id until the server numbers them. */
export type RecapEdit =
  | { op: "update"; id: number; text: string }
  | { op: "add"; id: number; after: number | null; text: string; at: number }
  | { op: "remove"; id: number };

const MAX_EDITS = 400;

/** Edits sent by the recorder, kept only when well formed. */
export function cleanRecapEdits(value: unknown): RecapEdit[] | null {
  if (!Array.isArray(value) || value.length > MAX_EDITS) return null;
  const edits: RecapEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { op, id, after, text, at } = entry as Record<string, unknown>;
    if (!Number.isInteger(id)) return null;
    const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAX_BULLET_LENGTH * 2) : null;
    if (op === "update" && clean !== null) edits.push({ op, id: id as number, text: clean });
    else if (op === "add" && clean !== null && (after === null || Number.isInteger(after))) {
      edits.push({ op, id: id as number, after: after as number | null, text: clean, at: typeof at === "number" && Number.isFinite(at) ? Math.max(0, at) : 0 });
    } else if (op === "remove") edits.push({ op, id: id as number });
    else return null;
  }
  return edits;
}

/**
 * The bullets after the reader's edits, in order. The recorder shows its
 * edits this way while they are being made, with the new bullets' own
 * (negative) ids; the server applies them for good with `number` set, giving
 * new bullets the next ids. Bullets left empty are dropped when numbering.
 */
export function applyRecapEdits(bullets: RecapBullet[], edits: RecapEdit[], { number = false } = {}): RecapBullet[] {
  const next = bullets.map((bullet) => ({ ...bullet }));
  const ids = new Map<number, number>();
  let nextId = next.reduce((highest, bullet) => Math.max(highest, bullet.id), 0) + 1;
  const resolve = (id: number) => ids.get(id) ?? id;
  for (const edit of edits) {
    if (edit.op === "add") {
      const id = number ? nextId++ : edit.id;
      ids.set(edit.id, id);
      const bullet: RecapBullet = { id, text: edit.text, addedAt: edit.at, changedAt: edit.at, edited: true };
      const position = edit.after === null ? 0 : next.findIndex((candidate) => candidate.id === resolve(edit.after!)) + 1;
      // After a bullet that is gone (the model never removes one, so another reader's edit): at the end.
      next.splice(edit.after !== null && position === 0 ? next.length : position, 0, bullet);
    } else if (edit.op === "update") {
      const bullet = next.find((candidate) => candidate.id === resolve(edit.id));
      if (bullet && bullet.text !== edit.text) Object.assign(bullet, { text: edit.text, edited: true });
    } else {
      const index = next.findIndex((candidate) => candidate.id === resolve(edit.id));
      if (index >= 0) next.splice(index, 1);
    }
  }
  return number ? next.filter((bullet) => bullet.text.trim()) : next;
}

/**
 * The recap as a Markdown note, saved beside the recording; each bullet links
 * to the moment it was first heard. `href` is the recording's link from the
 * note, with `seconds` as a media fragment.
 */
export function recapMarkdown(title: string, recordingName: string, href: (seconds?: number) => string, bullets: RecapBullet[]) {
  const escape = (text: string) => text.replace(/([[\]\\])/g, "\\$1");
  return `# ${escape(title)}

Recap of [${escape(recordingName)}](${href()}), written live while it was recorded.

${bullets.map((bullet) => `- ${bullet.text} ([${clock(bullet.addedAt)}](${href(bullet.addedAt)}))`).join("\n")}
`;
}
