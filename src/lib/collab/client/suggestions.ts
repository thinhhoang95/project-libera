// Suggestions on one shared document, for this window (plan M3.1–M3.4).
//
// One controller per replica. It is what the editors, the Suggestions panel
// and the AI features share:
//
// - who may do what (role from the hub's meta, the local account from the
//   registry's presence user), and who wrote a suggestion (names and colours
//   from presence, project members and the server's mirror);
// - the overlay, resolved against the live text and grouped, with what this
//   window is doing to each suggestion ("Accepting…") and how its last
//   decision ended (applied, stale, already decided by someone, …);
// - decisions through the host (server commands, queued while offline),
//   revert ("Undo acceptance"), and the author-only withdraw and edit;
// - creating suggestions: "Suggest edit" in Visual, and AI results on shared
//   tabs, which become AI-actor suggestions mapped from the text the AI saw
//   onto the live text (hard case 7).
//
// The accepted text itself arrives through sync like any remote edit (the
// server applies it), so nothing here ever writes to `content`.

import type * as Y from "yjs";
import type { Actor, AiFeature, Provenance } from "../protocol/actor";
import type { DecisionKind, DecisionOutcome, DecideSuggestionsResponse, Member, SuggestionInfo, UserSummary } from "../protocol/api";
import { can, canWriteSubdoc, type Role } from "../protocol/roles";
import type { SuggestionRecord, SuggestionStatus } from "../protocol/schema";
import type { HostEvent, SuggestionCommandStatus } from "../local-api";
import { PROVENANCE_META_KEY } from "../bindings/codemirror";
import {
  createSuggestion,
  editSuggestionReplacement,
  groupKey,
  listSuggestions,
  newSuggestionId,
  resolveSuggestions,
  suggestionsFromSnapshotEdits,
  suggestionsMap,
  withdrawSuggestion,
  type OwnershipResult,
  type ResolvedSuggestion,
  type SnapshotEdit,
} from "../suggestions/model";
import { collabClient, describeError } from "../ui/client";
import { subscribeHostEvents } from "../ui/bridge";
import type { CollabReplica } from "./replica";
import { getSharedDocRegistry, type SharedDocRegistry, type SharedDocSession } from "./registry";
import { createSuggestionsApi, type SuggestionsApi } from "./suggestions-api";

/* ---- Types ------------------------------------------------------------------------ */

export interface SuggestionAuthorInfo {
  name: string;
  color: string;
}

export interface PendingDecision {
  decision: DecisionKind;
  /** "queued": the host holds it until the server can be reached. */
  phase: "sending" | "queued";
  commandId: string;
}

export type SuggestionOutcomeKind = DecisionOutcome | "reverted" | "conflict" | "failed";

export interface SuggestionOutcome {
  kind: SuggestionOutcomeKind;
  message: string;
  decidedBy?: UserSummary;
  at: number;
}

export interface SuggestionItem {
  id: string;
  record: SuggestionRecord;
  resolved: ResolvedSuggestion;
  status: SuggestionStatus;
  pending?: PendingDecision;
  outcome?: SuggestionOutcome;
}

export type SuggestionGroupState = "pending" | "stale" | "decided";

export interface SuggestionGroupView {
  /** groupId, or the suggestion id of an ungrouped suggestion. */
  id: string;
  items: SuggestionItem[];
  state: SuggestionGroupState;
  /** Overlay status of the group (its first member's). */
  status: SuggestionStatus;
  start: number;
  end: number;
  actor: Actor;
  createdBy: string;
  author: SuggestionAuthorInfo;
  /** "Ada" or "AI · on behalf of Ada". */
  label: string;
  isAi: boolean;
  /** Created by the local account (directly or through an AI feature). */
  mine: boolean;
  createdAt: number;
  pending?: PendingDecision;
  outcome?: SuggestionOutcome;
  /** Who decided it, for decided groups. */
  decidedBy?: SuggestionAuthorInfo;
  canAccept: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  canEdit: boolean;
  /** "Undo acceptance": accepted in this window, by the local account. */
  canRevert: boolean;
}

export interface SuggestionsSnapshot {
  docId: string;
  role: Role | null;
  localUserId: string | null;
  canDecide: boolean;
  canSuggest: boolean;
  /** Pending first in document order, then stale, then decided (newest first). */
  groups: SuggestionGroupView[];
  /** The server mirror (decided history), or null until loaded. */
  history: SuggestionInfo[] | null;
  historyError: string | null;
}

export interface AiSuggestionHint {
  feature: AiFeature;
  model?: string;
  runId?: string;
  title?: string;
}

export type CreateSuggestionsResult =
  | { ok: true; ids: string[]; matched: number; conflicted: number }
  | { ok: false; reason: "read-only" | "signed-out" | "not-ready" | "empty"; message: string };

export interface DecisionResult {
  commandId: string;
  /** Resolves once the host answered: decided now, or queued for the replay. */
  sent: Promise<{ queued: boolean }>;
  /** Resolves with every outcome (with the response online, after the replay when queued). */
  settled: Promise<Map<string, SuggestionOutcome>>;
}

/** What a reply gesture asks the shell to open: a comment thread on the suggestion's range. */
export interface SuggestionReplyRequest {
  docId: string;
  groupId: string;
  suggestionIds: string[];
  start: number;
  end: number;
  quote: string;
  threadIds: string[];
}

/** Dispatched on window when no reply handler is set (the shared comment store wires it later). */
export const SUGGESTION_REPLY_EVENT = "libera:collab-suggestion-reply";

let replyHandler: ((request: SuggestionReplyRequest) => void) | null = null;

/** Lets the shell open a comment thread for a suggestion; null restores the window event. */
export function setSuggestionReplyHandler(handler: ((request: SuggestionReplyRequest) => void) | null): void {
  replyHandler = handler;
}

export interface SuggestionsControllerOptions {
  api?: SuggestionsApi;
  registry?: SharedDocRegistry;
  subscribeEvents?: (listener: (event: HostEvent) => void) => () => void;
  /** Project members, for authors not in presence. */
  loadMembers?: (projectId: string) => Promise<Member[]>;
  /** How often a queued decision's status is asked for when no event arrived. */
  pollMs?: number;
  now?: () => number;
}

/** Origin of the annotations transactions this controller writes. */
export class SuggestionsOrigin {
  constructor(readonly docId: string) {}
}

/* ---- Wording ------------------------------------------------------------------------ */

const AI_TITLES: Record<AiFeature, string> = {
  rewrite: "AI Rewrite",
  write: "Write with AI",
  format: "AI Format",
  "image-to-markdown": "AI Image to Markdown",
  "agentic-review": "Agentic review",
  agent: "AI Agent",
  "review-comments": "Review comments",
};

const PALETTE = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"];

/** A stable colour for an account nobody has described yet. */
export function fallbackColor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index++) hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function suggestionLabel(actor: Actor, author: SuggestionAuthorInfo): string {
  return actor.kind === "ai" ? `AI · on behalf of ${author.name}` : author.name;
}

function outcomeMessage(kind: SuggestionOutcomeKind, decision: DecisionKind | null, by?: UserSummary): string {
  switch (kind) {
    case "applied": return "Accepted";
    case "rejected": return "Rejected";
    case "stale": return "Not applied: the text changed since it was suggested.";
    case "already-decided": return by ? `Already decided by ${by.displayName}.` : "Someone already decided this suggestion.";
    case "not-found": return "This suggestion no longer exists.";
    case "reverted": return "Acceptance undone.";
    case "conflict": return "Could not undo: the text changed after it was accepted.";
    case "failed": return decision === "accept" ? "Could not accept." : decision === "reject" ? "Could not reject." : "The request failed.";
  }
}

const DEFAULT_POLL_MS = 3_000;
const TEXT_REFRESH_MS = 150;

/* ---- Controller ------------------------------------------------------------------------- */

export class SuggestionsController {
  readonly docId: string;
  readonly origin: SuggestionsOrigin;
  private readonly replica: CollabReplica;
  private readonly session: SharedDocSession;
  private readonly api: SuggestionsApi;
  private readonly registry: SharedDocRegistry;
  private readonly subscribeEvents: (listener: (event: HostEvent) => void) => () => void;
  private readonly loadMembers: (projectId: string) => Promise<Member[]>;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingDecision>();
  private readonly outcomes = new Map<string, SuggestionOutcome>();
  /** Accepted here, by the local account: "Undo acceptance" is offered for these. */
  private readonly acceptedHere = new Set<string>();
  private readonly commands = new Map<string, { ids: string[]; decision: DecisionKind; resolve: (outcomes: Map<string, SuggestionOutcome>) => void }>();
  private readonly people = new Map<string, SuggestionAuthorInfo>();
  private readonly revealers: Array<(start: number, end: number) => boolean> = [];
  private history: SuggestionInfo[] | null = null;
  private historyError: string | null = null;
  private membersRequested = false;
  private snapshot: SuggestionsSnapshot | null = null;
  private emitScheduled = false;
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopEvents: (() => void) | null = null;
  private peopleKey = "";
  private unbind: Array<() => void> = [];
  private destroyed = false;

  constructor(session: SharedDocSession, options: SuggestionsControllerOptions = {}) {
    this.session = session;
    this.replica = session.replica;
    this.docId = session.docId;
    this.origin = new SuggestionsOrigin(session.docId);
    this.api = options.api ?? createSuggestionsApi();
    this.registry = options.registry ?? getSharedDocRegistry();
    this.subscribeEvents = options.subscribeEvents ?? subscribeHostEvents;
    this.loadMembers = options.loadMembers ?? ((projectId) => collabClient.members(projectId));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.bind();
    this.unbind.push(
      this.replica.onRebuild(() => { this.rebind(); }),
      this.replica.subscribe(() => this.changed()),
    );
    const onAwareness = () => this.readPresence();
    this.replica.awareness.on("change", onAwareness);
    this.unbind.push(() => this.replica.awareness.off("change", onAwareness));
    this.readPresence();
  }

  /* ---- Subscriptions ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): SuggestionsSnapshot => {
    this.snapshot ??= this.build();
    return this.snapshot;
  };

  /** Coalesces change notifications into one per microtask. */
  private changed() {
    this.snapshot = null;
    if (this.emitScheduled || this.destroyed) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      if (this.destroyed) return;
      for (const listener of [...this.listeners]) listener();
    });
  }

  private bindings: Array<() => void> = [];

  private bind() {
    const map = suggestionsMap(this.replica.annotations);
    const onMap = () => this.changed();
    map.observe(onMap);
    // Positions and staleness follow the text; the panel need not redraw on
    // every keystroke.
    const ytext = this.replica.ytext;
    const onText = () => {
      if (this.textTimer) return;
      this.textTimer = setTimeout(() => {
        this.textTimer = null;
        this.changed();
      }, TEXT_REFRESH_MS);
    };
    ytext.observe(onText);
    this.bindings = [() => map.unobserve(onMap), () => ytext.unobserve(onText)];
  }

  private rebind() {
    for (const unbind of this.bindings) unbind();
    this.bind();
    this.changed();
  }

  /* ---- Identity and rights ---------------------------------------------------------------- */

  get localUserId(): string | null {
    return this.registry.localUser.userId ?? null;
  }

  get role(): Role | null {
    return this.replica.getSnapshot().meta?.role ?? this.session.resolved.role ?? null;
  }

  /** Editors and owners decide; AI never does (the server refuses it too). */
  canDecide(): boolean {
    const role = this.role;
    return !!role && can(role, "decide", { kind: "user", userId: this.localUserId ?? "" }) && this.writable();
  }

  canSuggest(): boolean {
    const role = this.role;
    return !!role && !!this.localUserId && can(role, "suggest") && canWriteSubdoc(role, "annotations") && this.writable();
  }

  /** Commenters always suggest: their content is read-only, their suggestions are not. */
  isCommenter(): boolean {
    return this.role === "commenter";
  }

  /**
   * Changes when what editors draw changes without the overlay changing:
   * the right to decide or suggest, or what is known about authors.
   */
  presentationKey(): string {
    return `${this.canDecide()}|${this.canSuggest()}|${this.isCommenter()}|${this.peopleKey}`;
  }

  /** The local account as a suggestion actor, or null while it is unknown. */
  userActor(): Extract<Actor, { kind: "user" }> | null {
    const userId = this.localUserId;
    return userId ? { kind: "user", userId } : null;
  }

  private writable(): boolean {
    const { meta, status, closed } = this.replica.getSnapshot();
    if (closed || this.replica.isDestroyed) return false;
    if (meta?.readOnlyReason === "access-revoked" || meta?.readOnlyReason === "schema-newer") return false;
    return status?.state !== "read-only" && status?.state !== "access-changed";
  }

  /* ---- Authors ------------------------------------------------------------------------------- */

  /** Name and colour of an account: presence, members, the server mirror, then a stable fallback. */
  authorOf(userId: string): SuggestionAuthorInfo {
    const local = this.registry.localUser;
    if (userId === local.userId) return { name: local.name, color: local.color };
    const known = this.people.get(userId);
    if (known) return known;
    this.requestMembers();
    return { name: "Collaborator", color: fallbackColor(userId) };
  }

  /** For AI suggestions, the user it acted for. */
  author = (record: SuggestionRecord): SuggestionAuthorInfo => this.authorOf(record.createdBy);

  private learn(userId: string, info: SuggestionAuthorInfo) {
    const current = this.people.get(userId);
    if (current && current.name === info.name && current.color === info.color) return false;
    this.people.set(userId, info);
    return true;
  }

  private readPresence() {
    let learned = false;
    for (const state of this.replica.awareness.getStates().values()) {
      const user = (state as { user?: { userId?: unknown; name?: unknown; color?: unknown } }).user;
      if (user && typeof user.userId === "string" && typeof user.name === "string" && typeof user.color === "string") {
        learned = this.learn(user.userId, { name: user.name, color: user.color }) || learned;
      }
    }
    if (learned) this.peopleChanged();
  }

  private requestMembers() {
    if (this.membersRequested) return;
    this.membersRequested = true;
    void this.loadMembers(this.session.resolved.projectId).then((members) => {
      let learned = false;
      for (const member of members) learned = this.learn(member.id, { name: member.displayName, color: member.color }) || learned;
      if (learned) this.peopleChanged();
    }, () => {
      // Offline or not allowed: presence and the fallback colours still work.
    });
  }

  private peopleChanged() {
    const key = JSON.stringify([...this.people.entries()]);
    if (key === this.peopleKey) return;
    this.peopleKey = key;
    this.changed();
  }

  /* ---- The overlay, resolved ---------------------------------------------------------------------- */

  private build(): SuggestionsSnapshot {
    const ytext = this.replica.ytext;
    const records = listSuggestions(this.replica.annotations);
    const resolved = resolveSuggestions(ytext, records);
    const me = this.localUserId;
    const canDecide = this.canDecide();
    const canSuggest = this.canSuggest();
    const groups = new Map<string, SuggestionItem[]>();
    for (const item of resolved) {
      const key = groupKey(item.record);
      const view: SuggestionItem = {
        id: item.record.id,
        record: item.record,
        resolved: item,
        status: item.record.status,
        ...(this.pending.has(item.record.id) ? { pending: this.pending.get(item.record.id)! } : {}),
        ...(this.outcomes.has(item.record.id) ? { outcome: this.outcomes.get(item.record.id)! } : {}),
      };
      const list = groups.get(key);
      if (list) list.push(view); else groups.set(key, [view]);
    }
    const views: SuggestionGroupView[] = [];
    for (const [id, items] of groups) {
      const first = items[0].record;
      const live = items.every((item) => item.status === "pending" || item.status === "stale");
      const stale = live && items.some((item) => item.resolved.isStale);
      const state: SuggestionGroupState = !live ? "decided" : stale ? "stale" : "pending";
      const author = this.author(first);
      const pending = items.find((item) => item.pending)?.pending;
      const outcome = items.map((item) => item.outcome).filter((value): value is SuggestionOutcome => !!value).sort((a, b) => b.at - a.at)[0];
      const decidedById = items.find((item) => item.record.decidedBy)?.record.decidedBy;
      const mine = !!me && first.createdBy === me;
      views.push({
        id,
        items,
        state,
        status: first.status,
        start: Math.min(...items.map((item) => item.resolved.start)),
        end: Math.max(...items.map((item) => item.resolved.end)),
        actor: first.actor,
        createdBy: first.createdBy,
        author,
        label: suggestionLabel(first.actor, author),
        isAi: first.actor.kind === "ai",
        mine,
        createdAt: Math.min(...items.map((item) => item.record.createdAt)),
        ...(pending ? { pending } : {}),
        ...(outcome ? { outcome } : {}),
        ...(decidedById ? { decidedBy: this.authorOf(decidedById) } : {}),
        canAccept: canDecide && live && !stale && !pending,
        canReject: canDecide && live && !pending,
        // The server lets an author withdraw only what is still stored as pending.
        canWithdraw: mine && canSuggest && items.every((item) => item.status === "pending") && !pending,
        canEdit: mine && canSuggest && first.actor.kind === "user" && items.length === 1 && first.status === "pending" && !stale && !pending,
        canRevert: canDecide && !pending && items.every((item) => item.status === "accepted" && this.acceptedHere.has(item.id)),
      });
    }
    const rank = (group: SuggestionGroupView) => (group.state === "pending" ? 0 : group.state === "stale" ? 1 : 2);
    views.sort((a, b) => rank(a) - rank(b) || (a.state === "decided"
      ? Math.max(...b.items.map((item) => item.record.decidedAt ?? item.record.updatedAt)) - Math.max(...a.items.map((item) => item.record.decidedAt ?? item.record.updatedAt))
      : a.start - b.start || a.createdAt - b.createdAt));
    return {
      docId: this.docId,
      role: this.role,
      localUserId: me,
      canDecide,
      canSuggest,
      groups: views,
      history: this.history,
      historyError: this.historyError,
    };
  }

  /** The group with this id (groupId or suggestion id), from the current snapshot. */
  group(groupId: string): SuggestionGroupView | null {
    return this.getSnapshot().groups.find((group) => group.id === groupId) ?? null;
  }

  /** Every live (pending or stale) suggestion id of the groups, so linked suggestions are decided together. */
  private expand(ids: readonly string[]): string[] {
    const records = listSuggestions(this.replica.annotations, { status: ["pending", "stale"] });
    const keys = new Set(records.filter((record) => ids.includes(record.id) || ids.includes(groupKey(record))).map(groupKey));
    const expanded = records.filter((record) => keys.has(groupKey(record))).map((record) => record.id);
    // Ids the overlay does not know (yet) still go to the server, which answers not-found.
    for (const id of ids) if (!expanded.includes(id) && !records.some((record) => groupKey(record) === id)) expanded.push(id);
    return expanded;
  }

  /* ---- Decisions ------------------------------------------------------------------------------------ */

  /**
   * Accepts or rejects suggestions (whole groups) through the host. The UI
   * shows "Accepting…" at once; online, the outcomes come back with the
   * response; offline, the host queues the decision and the outcome arrives
   * after the replay. A failure rolls the optimistic state back.
   */
  decide(ids: readonly string[], decision: DecisionKind, options: { checkpoint?: boolean } = {}): DecisionResult {
    const commandId = newSuggestionId("cmd");
    if (!this.canDecide()) {
      const outcomes = new Map<string, SuggestionOutcome>();
      for (const id of ids) outcomes.set(id, this.setOutcome(id, "failed", decision, undefined, "Only editors can accept or reject suggestions."));
      this.changed();
      return { commandId, sent: Promise.resolve({ queued: false }), settled: Promise.resolve(outcomes) };
    }
    const targets = this.expand(ids);
    for (const id of targets) {
      this.pending.set(id, { decision, phase: "sending", commandId });
      this.outcomes.delete(id);
    }
    this.changed();
    let resolveSettled: (outcomes: Map<string, SuggestionOutcome>) => void = () => {};
    const settled = new Promise<Map<string, SuggestionOutcome>>((resolve) => { resolveSettled = resolve; });
    this.commands.set(commandId, { ids: targets, decision, resolve: resolveSettled });
    const request = this.api.decide(this.docId, {
      decisions: targets.map((suggestionId) => ({ suggestionId, decision })),
      ...(options.checkpoint ? { checkpoint: true } : {}),
      commandId,
    });
    const sent = request.then((response) => {
      if (!response.queued) {
        this.settle(commandId, { state: "settled", ok: true, status: 200, response });
        return { queued: false };
      }
      for (const id of targets) if (this.pending.get(id)?.commandId === commandId) this.pending.set(id, { decision, phase: "queued", commandId });
      this.watchQueued();
      this.changed();
      return { queued: true };
    }, (error: unknown) => {
      this.settle(commandId, { state: "settled", ok: false, status: 0, error: { code: "failed", message: describeError(error) } });
      return { queued: false };
    });
    return { commandId, sent, settled };
  }

  /** Accept every pending group in document order, with a checkpoint first (stale ones are skipped by the server and reported). */
  acceptAll(): DecisionResult {
    const ids = listSuggestions(this.replica.annotations, { status: ["pending", "stale"] }).map((record) => record.id).filter((id) => !this.pending.has(id));
    return this.decide(ids, "accept", { checkpoint: true });
  }

  rejectAll(): DecisionResult {
    const ids = listSuggestions(this.replica.annotations, { status: ["pending", "stale"] }).map((record) => record.id).filter((id) => !this.pending.has(id));
    return this.decide(ids, "reject");
  }

  /** Decides tiptap preview groups (their group is the suggestion groupKey). */
  decideGroups(groupIds: readonly string[], decision: DecisionKind): DecisionResult {
    return this.decide(groupIds, decision, { checkpoint: groupIds.length > 1 });
  }

  private setOutcome(id: string, kind: SuggestionOutcomeKind, decision: DecisionKind | null, decidedBy?: UserSummary, message?: string): SuggestionOutcome {
    const outcome: SuggestionOutcome = { kind, message: message ?? outcomeMessage(kind, decision, decidedBy), ...(decidedBy ? { decidedBy } : {}), at: this.now() };
    this.outcomes.set(id, outcome);
    if (decidedBy) this.learn(decidedBy.id, { name: decidedBy.displayName, color: decidedBy.color });
    return outcome;
  }

  private settle(commandId: string, status: Extract<SuggestionCommandStatus, { state: "settled" }>) {
    const command = this.commands.get(commandId);
    if (!command) return;
    this.commands.delete(commandId);
    const outcomes = new Map<string, SuggestionOutcome>();
    const response: DecideSuggestionsResponse | undefined = status.ok ? status.response : undefined;
    const answered = new Map((response?.results ?? []).map((result) => [result.suggestionId, result]));
    const me = this.localUserId;
    for (const id of new Set([...command.ids, ...answered.keys()])) {
      if (this.pending.get(id)?.commandId === commandId) this.pending.delete(id);
      const result = answered.get(id);
      if (result) {
        outcomes.set(id, this.setOutcome(id, result.outcome, command.decision, result.decidedBy));
        if (result.outcome === "applied" && (!result.decidedBy || result.decidedBy.id === me)) this.acceptedHere.add(id);
      } else {
        // Refused (forbidden, offline replay refused, …): roll back.
        const message = status.error?.message;
        outcomes.set(id, this.setOutcome(id, "failed", command.decision, undefined, message ? `${outcomeMessage("failed", command.decision)} ${message}` : undefined));
      }
    }
    this.changed();
    if (!this.commands.size) this.stopWatching();
    command.resolve(outcomes);
  }

  /** Follows queued decisions: host events first, polling as the fallback (a missed event, a host restart). */
  private watchQueued() {
    this.stopEvents ??= this.subscribeEvents((event) => {
      if (event.t === "suggestions-settled" && event.docId === this.docId) this.settle(event.commandId, event.status);
    });
    if (this.pollTimer) return;
    const poll = () => {
      this.pollTimer = setTimeout(async () => {
        this.pollTimer = null;
        if (this.destroyed) return;
        for (const commandId of [...this.commands.keys()]) {
          const queued = [...this.pending.values()].some((pending) => pending.commandId === commandId && pending.phase === "queued");
          if (!queued) continue;
          try {
            const status = await this.api.command(this.docId, commandId);
            if (status.state === "settled") this.settle(commandId, status);
            else if (status.state === "unknown") this.settleFromOverlay(commandId);
          } catch {
            // The host is restarting; ask again next time.
          }
        }
        if (this.commands.size && !this.destroyed) poll();
      }, this.pollMs);
    };
    poll();
  }

  /** The host forgot the command's result: read the outcome from the overlay the server updated. */
  private settleFromOverlay(commandId: string) {
    const command = this.commands.get(commandId);
    if (!command) return;
    const outcomes = new Map<string, SuggestionOutcome>();
    for (const id of command.ids) {
      const record = listSuggestions(this.replica.annotations).find((candidate) => candidate.id === id);
      if (this.pending.get(id)?.commandId === commandId) this.pending.delete(id);
      if (!record) outcomes.set(id, this.setOutcome(id, "not-found", command.decision));
      else if (record.status === "accepted" || record.status === "rejected") {
        const ours = record.decidedBy === this.localUserId && (record.status === "accepted") === (command.decision === "accept");
        const decidedBy = record.decidedBy ? { id: record.decidedBy, ...this.nameOf(record.decidedBy) } : undefined;
        outcomes.set(id, this.setOutcome(id, ours ? (record.status === "accepted" ? "applied" : "rejected") : "already-decided", command.decision, decidedBy));
      } else if (record.status === "stale") outcomes.set(id, this.setOutcome(id, "stale", command.decision));
      else outcomes.set(id, this.setOutcome(id, "failed", command.decision, undefined, "The decision could not be confirmed. Try again."));
    }
    this.commands.delete(commandId);
    this.changed();
    if (!this.commands.size) this.stopWatching();
    command.resolve(outcomes);
  }

  private nameOf(userId: string): { displayName: string; color: string } {
    const author = this.authorOf(userId);
    return { displayName: author.name, color: author.color };
  }

  private stopWatching() {
    this.stopEvents?.();
    this.stopEvents = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** "Undo acceptance": a new server command that restores the text if it is unchanged. */
  async revert(groupId: string): Promise<SuggestionOutcome[]> {
    const group = this.group(groupId);
    const ids = group ? group.items.map((item) => item.id) : [groupId];
    const results: SuggestionOutcome[] = [];
    for (const id of ids) {
      try {
        const response = await this.api.revert(id);
        results.push(this.setOutcome(id, response.outcome, null));
        if (response.outcome === "reverted") this.acceptedHere.delete(id);
      } catch (error) {
        results.push(this.setOutcome(id, "failed", null, undefined, describeError(error)));
      }
    }
    this.changed();
    return results;
  }

  /* ---- The server mirror ------------------------------------------------------------------------------- */

  async loadHistory(): Promise<SuggestionInfo[] | null> {
    try {
      this.history = await this.api.history(this.docId);
      this.historyError = null;
      for (const info of this.history) {
        this.learn(info.createdBy.id, { name: info.createdBy.displayName, color: info.createdBy.color });
        if (info.decidedBy) this.learn(info.decidedBy.id, { name: info.decidedBy.displayName, color: info.decidedBy.color });
      }
    } catch (error) {
      this.historyError = describeError(error);
    }
    this.changed();
    return this.history;
  }

  /* ---- Author actions ----------------------------------------------------------------------------------------- */

  withdraw(groupId: string): OwnershipResult[] {
    const me = this.localUserId;
    const group = this.group(groupId);
    if (!me || !group) return [{ ok: false, reason: "not-found" }];
    const map = suggestionsMap(this.replica.annotations);
    const results: OwnershipResult[] = [];
    this.replica.annotations.transact(() => {
      for (const item of group.items) results.push(withdrawSuggestion(map, item.id, me, this.now()));
    }, this.origin);
    return results;
  }

  /** Changes the proposed text of your own pending suggestion. */
  edit(id: string, replacement: string): OwnershipResult {
    const me = this.localUserId;
    if (!me) return { ok: false, reason: "not-owner" };
    return editSuggestionReplacement(this.replica.annotations, id, me, replacement, this.now(), this.origin);
  }

  private refuseCreate(): CreateSuggestionsResult | null {
    if (!this.replica.getSnapshot().attached) return { ok: false, reason: "not-ready", message: "This shared document is still opening." };
    if (!this.localUserId) return { ok: false, reason: "signed-out", message: "Sign in to a collaboration account to suggest changes." };
    if (!this.canSuggest()) return { ok: false, reason: "read-only", message: "You cannot suggest changes in this shared document." };
    return null;
  }

  /** A suggestion from the local user over the live text ("Suggest edit"). */
  suggest(start: number, end: number, replacement: string): CreateSuggestionsResult {
    const refused = this.refuseCreate();
    if (refused) return refused;
    const ytext = this.replica.ytext;
    if (start < 0 || end < start || end > ytext.length) return { ok: false, reason: "empty", message: "The selection is no longer in the document." };
    if (ytext.toString().slice(start, end) === replacement) return { ok: false, reason: "empty", message: "The replacement is the same as the text." };
    const record = createSuggestion(this.replica.annotations, { ytext, start, end, replacement, actor: this.userActor()! }, this.origin);
    return { ok: true, ids: [record.id], matched: 1, conflicted: 0 };
  }

  /**
   * AI results on a shared tab (plan M3.4): `edits` were computed against
   * `snapshot`, the text the AI was given. They are mapped onto the live text,
   * so edits whose passage is unchanged become pending suggestions and the
   * others are created stale with what the AI saw (hard case 7). Several
   * edits from one run are linked and decided together.
   */
  suggestAi(snapshot: string, edits: readonly SnapshotEdit[], hint: AiSuggestionHint): CreateSuggestionsResult {
    const refused = this.refuseCreate();
    if (refused) return refused;
    const changes = edits.filter((edit) => edit.before !== edit.after);
    if (!changes.length) return { ok: false, reason: "empty", message: "AI proposed no change." };
    const me = this.localUserId!;
    const runId = hint.runId ?? newSuggestionId("run");
    const actor: Actor = { kind: "ai", onBehalfOf: me, feature: hint.feature, ...(hint.model ? { model: hint.model } : {}), runId };
    const provenance: Provenance = { source: "ai", feature: hint.feature, ...(hint.model ? { model: hint.model } : {}), runId };
    const ytext: Y.Text = this.replica.ytext;
    let created: ReturnType<typeof suggestionsFromSnapshotEdits> | null = null;
    this.replica.annotations.transact((transaction) => {
      transaction.meta.set(PROVENANCE_META_KEY, provenance);
      created = suggestionsFromSnapshotEdits(ytext.toString(), snapshot, changes, {
        ytext,
        target: this.replica.annotations,
        actor,
        createdBy: me,
        title: hint.title ?? AI_TITLES[hint.feature],
        ...(changes.length > 1 ? { groupId: runId } : {}),
        now: this.now(),
      });
    }, this.origin);
    const result = created as ReturnType<typeof suggestionsFromSnapshotEdits> | null;
    if (!result) return { ok: false, reason: "empty", message: "AI proposed no change." };
    return { ok: true, ids: result.suggestions.map((record) => record.id), matched: result.matched.length, conflicted: result.conflicted.length };
  }

  /* ---- Reply and reveal ------------------------------------------------------------------------------------------------------ */

  reply(groupId: string): SuggestionReplyRequest | null {
    const group = this.group(groupId);
    if (!group) return null;
    const request: SuggestionReplyRequest = {
      docId: this.docId,
      groupId,
      suggestionIds: group.items.map((item) => item.id),
      start: group.start,
      end: group.end,
      quote: this.replica.text().slice(group.start, group.end) || group.items[0].record.baseQuote,
      threadIds: [...new Set(group.items.flatMap((item) => item.record.threadIds ?? []))],
    };
    if (replyHandler) replyHandler(request);
    else if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SUGGESTION_REPLY_EVENT, { detail: request }));
    return request;
  }

  /** Editors register how to show a source range; the most recent one wins. */
  registerRevealer(reveal: (start: number, end: number) => boolean): () => void {
    this.revealers.push(reveal);
    return () => {
      const index = this.revealers.lastIndexOf(reveal);
      if (index >= 0) this.revealers.splice(index, 1);
    };
  }

  reveal(groupId: string): boolean {
    const group = this.group(groupId);
    if (!group) return false;
    for (let index = this.revealers.length - 1; index >= 0; index--) if (this.revealers[index](group.start, group.end)) return true;
    return false;
  }

  destroy() {
    this.destroyed = true;
    this.stopWatching();
    if (this.textTimer) clearTimeout(this.textTimer);
    for (const unbind of this.bindings) unbind();
    for (const unbind of this.unbind) unbind();
    this.listeners.clear();
    controllers.delete(this.replica);
  }
}

/* ---- One controller per replica -------------------------------------------------------------------------------------------------- */

const controllers = new WeakMap<CollabReplica, SuggestionsController>();
let defaultOptions: SuggestionsControllerOptions = {};

/** The controller of a session's document in this window. */
export function suggestionsFor(session: SharedDocSession, options?: SuggestionsControllerOptions): SuggestionsController {
  let controller = controllers.get(session.replica);
  if (!controller || session.replica.isDestroyed) {
    controller = new SuggestionsController(session, { ...defaultOptions, ...options });
    controllers.set(session.replica, controller);
  }
  return controller;
}

/** Options for controllers created from now on (tests: a direct control-API client, fast polling). */
export function setSuggestionsDefaults(options: SuggestionsControllerOptions): void {
  defaultOptions = options;
}
