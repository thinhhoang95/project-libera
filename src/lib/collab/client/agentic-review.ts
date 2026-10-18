// Agentic review on shared documents (plan M3.4): proposals become overlay
// suggestions.
//
// The plan conversation and the proposals stay in the requester's private
// review session (the local review document), as on any document. What
// collaborators see is one overlay suggestion group per proposal, with an AI
// actor acting for the requester, the proposal's title and reason, and the
// comment threads it addresses. Accepting and rejecting are server decisions
// (plan M3.3), so the session's own snapshot-apply path is for local
// documents only.
//
// A proposal's group id is derived from the proposal id, which makes the
// mapping idempotent: a proposal whose group exists (pending, decided or
// withdrawn) is never created twice, and its status is read back from the
// overlay. "Request revision" supersedes a proposal; its group is withdrawn
// and the revised proposal gets a group of its own.

import type { ReviewDocument, ReviewMessage, ReviewSuggestion, ReviewThread } from "@/lib/markdown-review";
import type { TextEdit } from "../local-api";
import type { SuggestionGroupView, SuggestionsController } from "./suggestions";
import { isSharedMessage, isSharedThread } from "../review-store/types";

/** The overlay group of an agentic-review proposal. */
export function agenticGroupId(proposalId: string): string {
  return `ar-${proposalId}`;
}

/** A proposal's edits as host edits on the text they were made against. */
export function proposalEdits(proposal: Pick<ReviewSuggestion, "edits">): TextEdit[] {
  return [...proposal.edits].sort((a, b) => a.start - b.start).map((edit) => ({ start: edit.start, end: edit.end, text: edit.after, before: edit.before }));
}

/** What a proposal's card shows, from its overlay group; null while the group does not exist yet. */
export function proposalStatus(group: SuggestionGroupView | undefined): ReviewSuggestion["status"] | null {
  if (!group) return null;
  if (group.state === "stale") return "conflicted";
  if (group.state === "pending") return "pending";
  if (group.items.some((item) => item.status === "accepted")) return "accepted";
  if (group.items.some((item) => item.status === "rejected")) return "rejected";
  return "superseded";
}

/**
 * The review document with each proposal's status taken from its overlay
 * group: decisions are made on the server, by anyone allowed to, so the
 * private session alone cannot know them. The phase follows.
 */
export function withOverlayStatuses(doc: ReviewDocument, groups: readonly SuggestionGroupView[]): ReviewDocument {
  const session = doc.session;
  if (!session?.suggestions.length) return doc;
  const byId = new Map(groups.map((group) => [group.id, group]));
  let changed = false;
  const suggestions = session.suggestions.map((proposal) => {
    if (proposal.status === "superseded") return proposal;
    const status = proposalStatus(byId.get(agenticGroupId(proposal.id)));
    if (!status || status === proposal.status) return proposal;
    changed = true;
    return { ...proposal, status };
  });
  if (!changed) return doc;
  const open = suggestions.some((proposal) => proposal.status === "pending" || proposal.status === "conflicted");
  const phase = session.phase === "awaiting_confirmation" || session.phase === "stale" ? session.phase : open ? "reviewing_changes" : "completed";
  return { ...doc, session: { ...session, suggestions, phase } };
}

export interface SyncResult {
  created: string[];
  withdrawn: string[];
  /** Proposals whose group could not be created now (host unreachable); retried on the next sync. */
  failed: { proposalId: string; message: string }[];
}

/**
 * Brings the overlay in line with the session: every open proposal without
 * a group gets one (edits on `snapshot`, the text the session's offsets
 * refer to, so a passage changed meanwhile comes out stale), and every
 * superseded proposal's live group is withdrawn.
 */
export async function syncAgenticReviewSuggestions(input: {
  doc: ReviewDocument;
  controller: SuggestionsController;
  /** The text the proposals' offsets refer to: the review document's snapshot. */
  snapshot: string;
}): Promise<SyncResult> {
  const result: SyncResult = { created: [], withdrawn: [], failed: [] };
  const session = input.doc.session;
  if (!session) return result;
  const groups = new Map(input.controller.getSnapshot().groups.map((group) => [group.id, group]));
  for (const proposal of session.suggestions) {
    const groupId = agenticGroupId(proposal.id);
    const group = groups.get(groupId);
    if (proposal.status === "superseded") {
      if (group && group.state !== "decided") {
        input.controller.withdraw(groupId);
        result.withdrawn.push(groupId);
      }
      continue;
    }
    if (group || (proposal.status !== "pending" && proposal.status !== "conflicted")) continue;
    try {
      await input.controller.createViaHost({
        edits: proposalEdits(proposal),
        snapshot: input.snapshot,
        ai: { feature: "agentic-review", runId: session.id },
        groupId,
        title: proposal.title,
        reason: proposal.reason,
        threadIds: proposal.commentIds,
      });
      result.created.push(groupId);
    } catch (error) {
      result.failed.push({ proposalId: proposal.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Who wrote a shared message, as the planning model reads it: a name, "(the user)" for the requester, "AI for …" for AI actors. */
function messageAuthor(message: ReviewMessage): string | undefined {
  if (!isSharedMessage(message)) return undefined;
  const person = `${message.shared.author.displayName}${message.shared.mine ? " (the user)" : ""}`;
  return message.shared.actor?.kind === "ai" ? `AI for ${person}` : person;
}

/**
 * Comment threads of a shared document in the shape the review route
 * expects (the plan addresses them by id), with who wrote each message so
 * the model can weigh replies. Pending chips stay behind.
 */
export function reviewThreadsForPlanning(threads: readonly ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !isSharedThread(thread) || !thread.shared.pending).map((thread) => ({
    id: thread.id,
    anchor: thread.anchor,
    status: thread.status,
    messages: thread.messages.map((message) => {
      const by = messageAuthor(message);
      return { id: message.id, text: message.text, createdAt: message.createdAt, ...(by ? { by } : {}) };
    }),
  }));
}
