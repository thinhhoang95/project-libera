// Who else is in a PDF, and what they are doing (plan §4). None of this is
// saved: it travels as awareness, so a lost update costs a frame of a ghost.
//
// Awareness sends a client's whole state each time, so a stroke in progress
// goes as its new points only, with the index they start at. Receivers
// assemble the ghost; the real mark replaces it when the pen lifts.

import type { Awareness } from "y-protocols/awareness";

/** Presence goes out at most this often, inside the server's per-socket allowance. */
export const PDF_PRESENCE_INTERVAL_MS = 50;
/** A finished stroke's ghost stays until the real mark has had time to arrive. */
export const PDF_GHOST_LINGER_MS = 400;
const MAX_DRAFT_POINTS = 400;
export const MAX_GHOST_POINTS = 5000;
export const MAX_GHOST_LIFETIME_MS = 30_000;
const MAX_SELECTION = 20;
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#30bced";

export type PdfPoint = { x: number; y: number };

export interface PdfDraftFrame {
  id: string;
  /** Index of `points[0]` in the whole stroke. */
  start: number;
  page: number;
  kind: "ink" | "shape";
  shape?: string;
  color: string;
  strokeWidth: number;
  points: PdfPoint[];
}

export interface PdfPresence {
  page: number;
  /** The visible span, in heights of `page` from its top; may run past 0 and 1. */
  top: number;
  bottom: number;
  pointer?: { page: number } & PdfPoint;
  selection?: string[];
  draft?: PdfDraftFrame;
  /** The start of the PDF's hash, so two people can tell they see different versions. */
  version?: string;
}

export interface PdfGhost {
  id: string;
  clientId: number;
  page: number;
  kind: "ink" | "shape";
  shape?: string;
  color: string;
  strokeWidth: number;
  points: PdfPoint[];
}

export interface PdfRemoteUser {
  clientId: number;
  userId?: string;
  name: string;
  color: string;
  presence: PdfPresence | null;
}

export interface PdfPresenceSnapshot {
  users: PdfRemoteUser[];
  ghosts: PdfGhost[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validPage(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10_000;
}

function readPoint(value: unknown): PdfPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  return finite(x) && finite(y) ? { x: clamp(x, -1, 2), y: clamp(y, -1, 3) } : null;
}

function readDraft(value: unknown): PdfDraftFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const draft = value as Record<string, unknown>;
  if (typeof draft.id !== "string" || !draft.id || draft.id.length > 80) return undefined;
  if (!Number.isInteger(draft.start) || (draft.start as number) < 0 || !validPage(draft.page)) return undefined;
  if (draft.kind !== "ink" && draft.kind !== "shape") return undefined;
  if (typeof draft.color !== "string" || !SAFE_COLOR.test(draft.color)) return undefined;
  if (!finite(draft.strokeWidth) || !Array.isArray(draft.points)) return undefined;
  const points = draft.points.slice(0, MAX_DRAFT_POINTS).map(readPoint).filter((point): point is PdfPoint => point !== null);
  return {
    id: draft.id,
    start: draft.start as number,
    page: draft.page,
    kind: draft.kind,
    ...(typeof draft.shape === "string" ? { shape: draft.shape.slice(0, 20) } : {}),
    color: draft.color,
    strokeWidth: clamp(draft.strokeWidth, 0.5, 24),
    points,
  };
}

/** A collaborator's presence, every field checked: awareness is untrusted. */
export function readPdfPresence(value: unknown): PdfPresence | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Record<string, unknown>;
  if (!validPage(state.page) || !finite(state.top) || !finite(state.bottom)) return null;
  const presence: PdfPresence = { page: state.page, top: clamp(state.top, -5, 5), bottom: clamp(state.bottom, -5, 5) };
  const pointer = state.pointer as { page?: unknown } | undefined;
  const point = readPoint(pointer);
  if (pointer && point && validPage(pointer.page)) presence.pointer = { page: pointer.page, ...point };
  if (Array.isArray(state.selection)) presence.selection = state.selection.filter((id): id is string => typeof id === "string" && id.length <= 200).slice(0, MAX_SELECTION);
  const draft = readDraft(state.draft);
  if (draft) presence.draft = draft;
  if (typeof state.version === "string" && /^[0-9a-f]{1,64}$/.test(state.version)) presence.version = state.version;
  return presence;
}

/** Assembles strokes in progress from the frames that reach this client. */
export class PdfGhosts {
  private readonly ghosts = new Map<number, PdfGhost>();
  private readonly sequences = new Map<number, { id: string; started: number; next: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Applies a client's latest frame. Returns whether anything changed. */
  apply(clientId: number, draft: PdfDraftFrame): boolean {
    const current = this.ghosts.get(clientId);
    const sequence = this.sequences.get(clientId);
    const sameDraft = sequence?.id === draft.id;
    if (sameDraft && this.now() - sequence.started >= MAX_GHOST_LIFETIME_MS) {
      return this.ghosts.delete(clientId);
    }
    if (!Number.isSafeInteger(draft.start) || draft.start < 0 || draft.start + draft.points.length > MAX_GHOST_POINTS
      || draft.points.length > MAX_DRAFT_POINTS) return false;
    // Duplicates/backwards frames and large gaps never grow or rebuild a ghost.
    if (sameDraft && (draft.kind === "ink" && (draft.start < sequence.next || draft.start > sequence.next + MAX_DRAFT_POINTS))) return false;
    if (!sameDraft && draft.start > MAX_DRAFT_POINTS) return false;
    const base = current && current.id === draft.id ? current : null;
    if (base && (base.kind !== draft.kind || base.page !== draft.page)) return false;
    if (draft.kind === "shape" && draft.start !== 0) return false;
    this.sequences.set(clientId, { id: draft.id, started: sameDraft ? sequence.started : this.now(), next: draft.start + draft.points.length });
    if (base && draft.points.length === 0) return false;
    const points = !base
      ? draft.points
      : draft.kind === "shape"
        ? draft.points
        // A dropped frame leaves a gap; the line just joins across it until the real mark lands.
        : [...base.points.slice(0, Math.min(draft.start, base.points.length)), ...draft.points];
    this.ghosts.set(clientId, { id: draft.id, clientId, page: draft.page, kind: draft.kind, ...(draft.shape ? { shape: draft.shape } : {}), color: draft.color, strokeWidth: draft.strokeWidth, points });
    return true;
  }

  get(clientId: number): PdfGhost | undefined {
    const sequence = this.sequences.get(clientId);
    if (sequence && this.now() - sequence.started >= MAX_GHOST_LIFETIME_MS) this.ghosts.delete(clientId);
    return this.ghosts.get(clientId);
  }

  remove(clientId: number): boolean {
    this.sequences.delete(clientId);
    return this.ghosts.delete(clientId);
  }

  removeAbsent(clients: ReadonlySet<number>) {
    for (const clientId of this.sequences.keys()) if (!clients.has(clientId)) this.remove(clientId);
  }

  list(): PdfGhost[] {
    for (const clientId of this.ghosts.keys()) this.get(clientId);
    return [...this.ghosts.values()];
  }
}

const stores = new WeakMap<Awareness, PdfPresenceStore>();

/** The presence store of a replica's awareness; windows keep it across remounts. */
export function pdfPresenceFor(awareness: Awareness): PdfPresenceStore {
  let store = stores.get(awareness);
  if (!store) {
    store = new PdfPresenceStore(awareness);
    stores.set(awareness, store);
  }
  return store;
}

type Schedule = (work: () => void, delayMs: number) => { cancel(): void };

const defaultSchedule: Schedule = (work, delayMs) => {
  const timer = setTimeout(work, delayMs);
  return { cancel: () => clearTimeout(timer) };
};

/** One window's view of a PDF's presence: what it publishes and what it sees. */
export class PdfPresenceStore {
  private snapshot: PdfPresenceSnapshot = { users: [], ghosts: [] };
  private readonly ghosts = new PdfGhosts();
  private readonly lingering = new Map<number, { cancel(): void }>();
  private readonly listeners = new Set<() => void>();
  private local: Omit<PdfPresence, "draft"> | null = null;
  private draft: Omit<PdfDraftFrame, "start" | "points"> | null = null;
  private draftPoints: PdfPoint[] = [];
  private sent = 0;
  private flushing: { cancel(): void } | null = null;
  private lastFlush = 0;

  constructor(private readonly awareness: Awareness, private readonly schedule: Schedule = defaultSchedule) {
    awareness.on("change", this.refresh);
    this.refresh();
  }

  getSnapshot = (): PdfPresenceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private readonly refresh = () => {
    const users: PdfRemoteUser[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID || !state) return;
      const user = (state.user ?? {}) as Record<string, unknown>;
      const presence = readPdfPresence(state.pdf);
      users.push({
        clientId,
        ...(typeof user.userId === "string" ? { userId: user.userId } : {}),
        name: typeof user.name === "string" && user.name.trim() ? user.name.trim().slice(0, 80) : "Anonymous",
        color: typeof user.color === "string" && SAFE_COLOR.test(user.color) ? user.color : DEFAULT_COLOR,
        presence,
      });
      if (presence?.draft) {
        this.lingering.get(clientId)?.cancel();
        this.lingering.delete(clientId);
        this.ghosts.apply(clientId, presence.draft);
      } else if (this.ghosts.get(clientId) && !this.lingering.has(clientId)) {
        this.lingering.set(clientId, this.schedule(() => {
          this.lingering.delete(clientId);
          this.ghosts.remove(clientId);
          this.publish(this.snapshot.users);
        }, PDF_GHOST_LINGER_MS));
      }
    });
    // Someone who left mid-stroke leaves no ghost behind.
    for (const ghost of this.ghosts.list()) {
      if (users.some((user) => user.clientId === ghost.clientId)) continue;
      this.lingering.get(ghost.clientId)?.cancel();
      this.lingering.delete(ghost.clientId);
      this.ghosts.remove(ghost.clientId);
    }
    this.ghosts.removeAbsent(new Set(users.map((user) => user.clientId)));
    this.publish(users.sort((a, b) => a.name.localeCompare(b.name) || a.clientId - b.clientId));
  };

  private publish(users: PdfRemoteUser[]) {
    this.snapshot = { users, ghosts: this.ghosts.list() };
    for (const listener of [...this.listeners]) listener();
  }

  /** This window's reading position. */
  setView(view: Pick<PdfPresence, "page" | "top" | "bottom" | "version">) {
    this.local = { ...this.local, ...view };
    this.requestFlush();
  }

  setPointer(pointer: PdfPresence["pointer"] | null) {
    if (!this.local) return;
    const next = { ...this.local };
    if (pointer) next.pointer = pointer;
    else delete next.pointer;
    this.local = next;
    this.requestFlush();
  }

  setSelection(ids: string[]) {
    if (!this.local) return;
    const next = { ...this.local };
    if (ids.length) next.selection = ids.slice(0, MAX_SELECTION);
    else delete next.selection;
    this.local = next;
    this.requestFlush();
  }

  /** A stroke or shape in progress, as a whole; null when it ended. */
  setDraft(draft: (Omit<PdfDraftFrame, "start" | "points"> & { points: PdfPoint[] }) | null) {
    if (!draft) {
      this.draft = null;
      this.draftPoints = [];
      this.sent = 0;
      this.requestFlush(true);
      return;
    }
    if (this.draft?.id !== draft.id) this.sent = 0;
    const { points, ...rest } = draft;
    this.draft = rest;
    this.draftPoints = points;
    this.requestFlush();
  }

  private requestFlush(now = false) {
    if (now) {
      this.flushing?.cancel();
      this.flushing = null;
      this.flush();
      return;
    }
    if (this.flushing) return;
    const wait = Math.max(0, PDF_PRESENCE_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.flushing = this.schedule(() => {
      this.flushing = null;
      this.flush();
    }, wait);
  }

  private flush() {
    if (!this.local) return;
    this.lastFlush = Date.now();
    const state: PdfPresence = { ...this.local };
    if (this.draft) {
      const shape = this.draft.kind === "shape";
      const start = shape ? 0 : this.sent;
      const points = this.draftPoints.slice(start, start + MAX_DRAFT_POINTS);
      this.sent = shape ? 0 : start + points.length;
      state.draft = { ...this.draft, start, points };
      // A long burst goes out over several frames.
      if (!shape && this.sent < this.draftPoints.length) this.requestFlush();
    }
    this.awareness.setLocalStateField("pdf", state);
  }

  /** This window stopped showing the PDF. */
  leave() {
    this.flushing?.cancel();
    this.flushing = null;
    this.local = null;
    this.draft = null;
    if (this.awareness.getLocalState()) this.awareness.setLocalStateField("pdf", null);
  }

  destroy() {
    this.leave();
    for (const timer of this.lingering.values()) timer.cancel();
    this.lingering.clear();
    this.awareness.off("change", this.refresh);
    this.listeners.clear();
  }
}
