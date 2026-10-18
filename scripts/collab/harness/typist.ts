// Random typists for the harness: realistic edits applied through
// DocHub.applyLocalChange, the same path the control API, materializer and
// agent use. Seeded, so a failing fuzz or soak run can be replayed.
//
// Edits mix typing (short inserts), deletes, replaces (select and type),
// pastes of multi-line blocks, and unicode that breaks naive index math:
// emoji outside the BMP (surrogate pairs, ZWJ sequences), Vietnamese in
// decomposed form (base letter plus combining marks, as some IMEs produce),
// CJK and RTL text. Positions never split a surrogate pair or detach a
// combining mark from its base, as a real editor never does; Yjs counts
// UTF-16 code units, so a split pair would be a test bug, not a product bug.

import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import { ContentKeys } from "../../../src/lib/collab/protocol/schema";
import type { DocHub } from "../../../electron/collab/core/doc-hub";
import type * as Y from "yjs";

/** mulberry32: tiny, fast, good enough for test schedules. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "the",
  "notes",
  "review",
  "draft",
  "Libera",
  "sync",
  "offline",
  "# Heading",
  "- item",
  "`code`",
  "**bold**",
  // Vietnamese, decomposed: "Tiếng Việt", "đường", "người".
  "Tiếng Việt",
  "đường",
  "người",
  // Precomposed Vietnamese too.
  "cảm ơn",
  // Surrogate pairs and a ZWJ sequence.
  "😀",
  "🚀🎉",
  "👩‍💻",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
  // CJK and RTL.
  "日本語",
  "中文",
  "مرحبا",
];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isJoiner(code: number): boolean {
  // Combining diacritics, ZWJ and variation selectors attach to what precedes them.
  return (code >= 0x0300 && code <= 0x036f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f);
}

/** Moves `index` left until it does not split a surrogate pair or a combining sequence. */
export function safeBoundary(text: string, index: number): number {
  let position = Math.max(0, Math.min(text.length, index));
  while (position > 0 && position < text.length) {
    const code = text.charCodeAt(position);
    if (isLowSurrogate(code) && isHighSurrogate(text.charCodeAt(position - 1))) {
      position -= 1;
      continue;
    }
    if (isJoiner(code)) {
      position -= 1;
      continue;
    }
    // The character after a ZWJ belongs to the same emoji.
    if (text.charCodeAt(position - 1) === 0x200d) {
      position -= 1;
      continue;
    }
    break;
  }
  return position;
}

export type EditKind = "insert" | "delete" | "replace" | "paste" | "newline";

export interface TypistOptions {
  seed: number;
  /** Tag added to inserted text, so tests can see whose edits survived. */
  tag?: string;
  /** Relative weights of edit kinds. */
  weights?: Partial<Record<EditKind, number>>;
  /** Upper bound for a paste, in characters. */
  maxPaste?: number;
}

const DEFAULT_WEIGHTS: Record<EditKind, number> = { insert: 60, delete: 15, replace: 10, paste: 5, newline: 10 };

export class RandomTypist {
  readonly random: () => number;
  private readonly weights: Record<EditKind, number>;
  private readonly tag: string;
  private readonly maxPaste: number;
  edits = 0;

  constructor(options: TypistOptions) {
    this.random = seededRandom(options.seed);
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.tag = options.tag ?? "";
    this.maxPaste = options.maxPaste ?? 2000;
  }

  private int(maxExclusive: number): number {
    return Math.floor(this.random() * maxExclusive);
  }

  private pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  private kind(): EditKind {
    const entries = Object.entries(this.weights) as Array<[EditKind, number]>;
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.random() * total;
    for (const [kind, weight] of entries) {
      roll -= weight;
      if (roll < 0) return kind;
    }
    return "insert";
  }

  /** A short typed phrase. */
  phrase(): string {
    const count = 1 + this.int(3);
    const words: string[] = [];
    for (let index = 0; index < count; index += 1) words.push(this.pick(WORDS));
    return `${words.join(" ")}${this.tag} `;
  }

  /** A multi-line block, as from the clipboard. */
  block(): string {
    const lines: string[] = [];
    const target = 40 + this.int(this.maxPaste);
    let size = 0;
    while (size < target) {
      const line = `${this.pick(["", "- ", "## ", "> ", "1. "])}${this.phrase()}${this.phrase()}`;
      lines.push(line);
      size += line.length + 1;
    }
    return `${lines.join("\n")}\n`;
  }

  /** Applies one random edit to `text` inside the caller's transaction. Returns its kind. */
  editText(text: Y.Text): EditKind {
    const current = text.toString();
    let kind = this.kind();
    if (current.length === 0 && (kind === "delete" || kind === "replace")) kind = "insert";
    const at = safeBoundary(current, this.int(current.length + 1));
    switch (kind) {
      case "insert":
        text.insert(at, this.phrase());
        break;
      case "newline":
        text.insert(at, `\n${this.phrase()}`);
        break;
      case "paste":
        text.insert(at, this.block());
        break;
      case "delete":
      case "replace": {
        const end = safeBoundary(current, at + 1 + this.int(Math.min(40, current.length - at + 1)));
        const start = Math.min(at, end);
        const length = Math.max(0, end - start);
        if (length > 0) text.delete(start, length);
        if (kind === "replace" || length === 0) text.insert(start, this.phrase());
        break;
      }
    }
    return kind;
  }

  /** One edit through the hub (persisted, queued, broadcast). */
  step(hub: DocHub): EditKind {
    let kind: EditKind = "insert";
    const provenance: Provenance = { source: "typing" };
    hub.applyLocalChange(
      "content",
      (doc) => {
        kind = this.editText(doc.getText(ContentKeys.source));
      },
      provenance,
    );
    this.edits += 1;
    return kind;
  }
}

/**
 * Appends a unique marker at the end of the text. Insert-only typing with
 * markers is how durability tests tell exactly which edits survived.
 */
export function appendMarker(hub: DocHub, marker: string, provenance: Provenance = { source: "typing" }): void {
  hub.applyLocalChange(
    "content",
    (doc) => {
      const text = doc.getText(ContentKeys.source);
      text.insert(text.length, marker);
    },
    provenance,
  );
}

/** Inserts a marker at a random safe position (concurrent typists interleave). */
export function insertMarker(hub: DocHub, marker: string, random: () => number): void {
  hub.applyLocalChange(
    "content",
    (doc) => {
      const text = doc.getText(ContentKeys.source);
      const current = text.toString();
      // Only between markers, so markers never split each other.
      const boundaries = [0];
      for (let index = 0; index < current.length; index += 1) if (current[index] === "\n") boundaries.push(index + 1);
      text.insert(boundaries[Math.floor(random() * boundaries.length)], marker);
    },
    { source: "typing" },
  );
}

/**
 * Types "<tag:index>\n" markers on a timer until stopped, the way a person
 * keeps typing while the network misbehaves. `markers` lists every marker
 * whose applyLocalChange returned, i.e. committed to SQLite.
 */
export class MarkerTypist {
  readonly markers: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private index = 0;

  constructor(
    private readonly hub: () => DocHub,
    readonly tag: string,
    private readonly mode: "append" | "random" = "append",
    private readonly random: () => number = Math.random,
  ) {}

  /** Types one marker now. */
  type(): string {
    const marker = `<${this.tag}:${this.index}>`;
    this.index += 1;
    if (this.mode === "append") appendMarker(this.hub(), `${marker}\n`);
    else insertMarker(this.hub(), `${marker}\n`, this.random);
    this.markers.push(marker);
    return marker;
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.type();
      } catch {
        // The hub closed under us (host restart); the test decides what that means.
        this.stop();
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
