/* Shared types of the find & replace engine (docs/find-replace-patterns-plan.md). */

export type FindMode = "plain" | "pattern" | "regex";

/** Which syntax the searched text is written in; decides what counts as math, comments and code. */
export type FindFlavor = "markdown" | "latex" | "text";

export type FindScope = "anywhere" | "outsideMath" | "insideMath" | "skipCommentsAndCode";

export type FindOptions = {
  mode: FindMode;
  matchCase: boolean;
  wholeWord: boolean;
  /** One space in the query matches any run of spaces/tabs, none included, and a single line break. */
  flexibleSpacing: boolean;
  scope: FindScope;
  flavor: FindFlavor;
};

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  mode: "plain",
  matchCase: false,
  wholeWord: false,
  flexibleSpacing: false,
  scope: "anywhere",
  flavor: "text",
};

export type TextRange = { start: number; end: number };

/** A captured piece of a match. `start` is -1 for a regex group that did not take part. */
export type FindCapture = { index: number; name?: string; start: number; end: number };

export type FindMatch = { start: number; end: number; captures: FindCapture[] };

export type FindResult = {
  matches: FindMatch[];
  /** The search stopped early (step budget or time limit); `matches` holds what was found before. */
  incomplete: boolean;
};

export type FindError = { message: FindMessage; from: number; to: number };

/** Message ids, translated by the find bar (`find.messages.*`). */
export type FindMessage =
  | { id: "invalidRegex"; detail: string }
  | { id: "unknownType"; type: string }
  | { id: "typeExpected" }
  | { id: "unterminatedRegex" }
  | { id: "numberedHoleName" }
  | { id: "needsLiteral" }
  | { id: "adjacentHoles" }
  | { id: "unknownCapture"; name: string }
  | { id: "unterminatedExpression" }
  | { id: "invalidExpression" }
  | { id: "dollarReference"; written: string; suggestion: string }
  | { id: "notANumber"; value: string };

export type HoleType = "any" | "block" | "line" | "word" | "int" | "num" | "space" | "cmd" | "arg" | "opt" | "math";

export const HOLE_TYPES: readonly HoleType[] = ["any", "block", "line", "word", "int", "num", "space", "cmd", "arg", "opt", "math"];

/** One piece of the query as typed, for drawing holes as chips. Pieces cover the query in order. */
export type QueryPart =
  | { kind: "text"; from: number; to: number }
  | { kind: "escape"; from: number; to: number }
  | { kind: "space"; from: number; to: number }
  | { kind: "hole"; from: number; to: number; group: number; name?: string; type?: HoleType; regex?: string; single?: boolean; backref?: boolean }
  | { kind: "error"; from: number; to: number };

/** One piece of a replacement as typed, for colouring references like the holes they point at. */
export type ReplacementPart =
  | { kind: "text"; from: number; to: number }
  | { kind: "escape"; from: number; to: number }
  | { kind: "ref"; from: number; to: number; group: number }
  | { kind: "counter"; from: number; to: number }
  | { kind: "expression"; from: number; to: number; groups: number[] }
  | { kind: "error"; from: number; to: number };

/** What a replacement produces for one match. TipTap copies `capture` pieces from the document to keep their marks. */
export type ReplacePiece =
  | { kind: "text"; text: string }
  | { kind: "capture"; start: number; end: number };
