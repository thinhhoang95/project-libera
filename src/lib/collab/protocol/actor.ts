// Who an action is attributed to (collaboration map §4).
//
// The server always fills `userId` / `onBehalfOf` from the authenticated
// connection. Values a client sends are only used to choose between the kinds.

export type AiFeature =
  | "rewrite"
  | "write"
  | "format"
  | "image-to-markdown"
  | "agentic-review"
  | "agent"
  | "review-comments";

export const AI_FEATURES: readonly AiFeature[] = [
  "rewrite",
  "write",
  "format",
  "image-to-markdown",
  "agentic-review",
  "agent",
  "review-comments",
];

export type SystemReason = "restore" | "import" | "compaction" | "migration" | "decision";

export type Actor =
  | { kind: "user"; userId: string; clientId?: string }
  | {
      kind: "ai";
      onBehalfOf: string;
      clientId?: string;
      feature: AiFeature;
      model?: string;
      runId?: string;
    }
  | { kind: "system"; reason: SystemReason; onBehalfOf?: string };

/** The account an actor's rights come from, or null for pure system actions. */
export function actorAccountId(actor: Actor): string | null {
  if (actor.kind === "user") return actor.userId;
  return actor.onBehalfOf ?? null;
}

export function isAiActor(actor: Actor): actor is Extract<Actor, { kind: "ai" }> {
  return actor.kind === "ai";
}

/**
 * How a local edit was produced. Stored with each update for history and
 * attribution. It never grants rights; it only describes.
 */
export type ProvenanceSource =
  | "typing"
  | "paste"
  | "ai"
  | "external-file"
  | "restore"
  | "import"
  | "suggestion"
  | "undo"
  | "reconcile"
  | "system";

export interface Provenance {
  source: ProvenanceSource;
  feature?: AiFeature;
  model?: string;
  runId?: string;
  /** Set when the update applies an accepted suggestion. */
  suggestionId?: string;
  suggestedBy?: Actor;
}

/** Client hint for an AI actor; the server replaces onBehalfOf with the caller. */
export interface AiActorHint {
  feature: AiFeature;
  model?: string;
  runId?: string;
}

/** Normalizes an actor for a request made by `accountId`, ignoring spoofed ids. */
export function bindActor(accountId: string, clientId: string | undefined, hint?: AiActorHint | null): Actor {
  if (hint && AI_FEATURES.includes(hint.feature)) {
    return {
      kind: "ai",
      onBehalfOf: accountId,
      clientId,
      feature: hint.feature,
      model: typeof hint.model === "string" ? hint.model.slice(0, 200) : undefined,
      runId: typeof hint.runId === "string" ? hint.runId.slice(0, 200) : undefined,
    };
  }
  return { kind: "user", userId: accountId, clientId };
}
