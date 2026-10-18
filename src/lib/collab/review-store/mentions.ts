// @mentions in comment bodies (plan M2.3). The text keeps a readable
// "@Display Name"; the ids go in the request's `mentions`, which is what the
// server notifies. A pick whose "@Name" was deleted from the text again is
// not sent.

export interface MentionCandidate {
  id: string;
  displayName: string;
  email?: string;
  color?: string;
}

/** The "@query" being typed just before the caret, or null. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{"'])@([^\s@]{0,40})$/.exec(before);
  if (!match) return null;
  const query = match[2];
  return { start: before.length - query.length - 1, query };
}

/** Members matching `query` by name or email, best first; the author is never offered. */
export function filterMentionCandidates<T extends MentionCandidate>(candidates: readonly T[], query: string, excludeId?: string | null, limit = 8): T[] {
  const needle = query.trim().toLowerCase();
  const scored: { candidate: T; score: number }[] = [];
  for (const candidate of candidates) {
    if (candidate.id === excludeId) continue;
    const name = candidate.displayName.toLowerCase();
    const email = (candidate.email ?? "").toLowerCase();
    let score = -1;
    if (!needle) score = 0;
    else if (name.startsWith(needle)) score = 3;
    else if (name.split(/\s+/).some((word) => word.startsWith(needle))) score = 2;
    else if (email.startsWith(needle) || name.includes(needle)) score = 1;
    if (score >= 0) scored.push({ candidate, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.candidate.displayName.localeCompare(b.candidate.displayName))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Replaces the "@query" at `start` with "@Display Name " and returns the new text and caret. */
export function insertMention(text: string, caret: number, start: number, candidate: MentionCandidate): { text: string; caret: number } {
  const inserted = `@${candidate.displayName} `;
  const next = text.slice(0, start) + inserted + text.slice(caret).replace(/^ /, "");
  return { text: next, caret: start + inserted.length };
}

/** Ids of picked members whose "@Name" is still in the text, in pick order, without duplicates. */
export function mentionIds(text: string, picked: readonly MentionCandidate[]): string[] {
  const ids: string[] = [];
  for (const candidate of picked) {
    if (ids.includes(candidate.id)) continue;
    if (text.includes(`@${candidate.displayName}`)) ids.push(candidate.id);
  }
  return ids;
}
