// Presence helpers on top of y-protocols awareness (source plan §6.5).
//
// Local state layout (shared with every collaborator):
//   user:    { name, color, colorLight, userId? }   read by y-codemirror.next's remote carets
//   cursor:  { anchor, head } as Y.RelativePosition JSON (written by y-codemirror.next)
//   section: { title, level, offset } | null        the heading the cursor is in (mini-map)
// Anything else in a remote state is ignored, and every field is validated,
// because awareness comes from collaborators and is untrusted.

import { Compartment, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

export interface CollabUser {
  name: string;
  /** A CSS colour (hex is best: `colorLight` derives a translucent variant). */
  color: string;
  colorLight?: string;
  userId?: string;
}

export interface CollabSection {
  title: string;
  /** 1 for `#` / \part / \chapter, increasing for deeper headings. */
  level: number;
  /** Source offset of the heading line. */
  offset: number;
}

export interface RemoteUser {
  clientId: number;
  name: string;
  color: string;
  colorLight: string;
  userId?: string;
  section: CollabSection | null;
  /** Absolute cursor positions in the Y.Text, when the cursor is in it. */
  cursor: { anchor: number; head: number } | null;
}

/** A translucent variant of `color` for selection backgrounds. */
export function colorLight(color: string, alpha = 0.2): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  const channel = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0");
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return `#${digits.toLowerCase()}${channel}`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Publishes the local user's name and colours. */
export function setLocalUser(awareness: Awareness, user: CollabUser) {
  const value = { name: user.name, color: user.color, colorLight: user.colorLight ?? colorLight(user.color), ...(user.userId ? { userId: user.userId } : {}) };
  const current = awareness.getLocalState()?.user as Record<string, unknown> | undefined;
  if (current && JSON.stringify(current) === JSON.stringify(value)) return;
  awareness.setLocalStateField("user", value);
}

/** Publishes the section the local cursor is in (null when above the first heading). */
export function setLocalSection(awareness: Awareness, section: CollabSection | null) {
  const current = (awareness.getLocalState()?.section ?? null) as CollabSection | null;
  if (current === section || (current && section && current.title === section.title && current.level === section.level && current.offset === section.offset)) return;
  awareness.setLocalStateField("section", section);
}

const LATEX_LEVELS: Record<string, number> = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const MARKDOWN_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const LATEX_HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;

/** Parses one line as a heading. */
export function headingOfLine(line: string, kind: "markdown" | "latex" | "text"): { title: string; level: number } | null {
  if (kind === "markdown") {
    const match = MARKDOWN_HEADING.exec(line);
    return match ? { title: match[2].trim().slice(0, 200), level: match[1].length } : null;
  }
  if (kind === "latex") {
    const match = LATEX_HEADING.exec(line);
    return match ? { title: match[2].trim().slice(0, 200), level: LATEX_LEVELS[match[1]] } : null;
  }
  return null;
}

const MAX_SECTION_SCAN_LINES = 5_000;

/**
 * The heading the position is in, scanning upwards from the cursor's line. The
 * scan is bounded, so a huge document without headings stays cheap. Markdown
 * code fences are not tracked; a `#` line inside a fence above the cursor can
 * be reported, which only affects the presence mini-map.
 */
export function sectionAt(state: EditorState, pos: number, kind: "markdown" | "latex" | "text"): CollabSection | null {
  if (kind === "text") return null;
  const doc = state.doc;
  let line = doc.lineAt(Math.min(Math.max(0, pos), doc.length));
  for (let scanned = 0; scanned < MAX_SECTION_SCAN_LINES; scanned++) {
    const heading = headingOfLine(line.text, kind);
    if (heading) return { ...heading, offset: line.from };
    if (line.number === 1) return null;
    line = doc.line(line.number - 1);
  }
  return null;
}

/** Keeps the local `section` awareness field in step with the cursor. */
export function sectionTracker(awareness: Awareness, kind: "markdown" | "latex" | "text"): Extension {
  return ViewPlugin.define((view) => {
    let lastLine = -1;
    const publish = (state: EditorState, force: boolean) => {
      const line = state.doc.lineAt(state.selection.main.head).number;
      if (!force && line === lastLine) return;
      lastLine = line;
      setLocalSection(awareness, sectionAt(state, state.selection.main.head, kind));
    };
    publish(view.state, true);
    return {
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) publish(update.state, update.docChanged);
      },
    };
  });
}

function validSection(value: unknown): CollabSection | null {
  if (!value || typeof value !== "object") return null;
  const section = value as Record<string, unknown>;
  if (typeof section.title !== "string" || typeof section.level !== "number" || typeof section.offset !== "number") return null;
  return { title: section.title.slice(0, 200), level: section.level, offset: section.offset };
}

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,20})$/i;

function resolveCursor(cursor: unknown, ytext: Y.Text | undefined): RemoteUser["cursor"] {
  if (!ytext?.doc || !cursor || typeof cursor !== "object") return null;
  const { anchor, head } = cursor as { anchor?: unknown; head?: unknown };
  if (!anchor || !head) return null;
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor), ytext.doc);
    const h = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), ytext.doc);
    if (!a || !h || a.type !== ytext || h.type !== ytext) return null;
    return { anchor: a.index, head: h.index };
  } catch {
    return null;
  }
}

/**
 * Collaborators other than this client, sorted by name. With `ytext`, their
 * cursors are resolved to offsets in it (null when they are in another file).
 * One account open in two windows shows as two entries, as in the editor.
 */
export function remoteUsers(awareness: Awareness, ytext?: Y.Text): RemoteUser[] {
  const users: RemoteUser[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID || !state) return;
    const user = (state.user ?? {}) as Record<string, unknown>;
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim().slice(0, 80) : "Anonymous";
    const color = typeof user.color === "string" && SAFE_COLOR.test(user.color) ? user.color : "#30bced";
    const light = typeof user.colorLight === "string" && SAFE_COLOR.test(user.colorLight) ? user.colorLight : colorLight(color);
    users.push({
      clientId,
      name,
      color,
      colorLight: light,
      userId: typeof user.userId === "string" ? user.userId : undefined,
      section: validSection(state.section),
      cursor: resolveCursor(state.cursor, ytext),
    });
  });
  return users.sort((a, b) => a.name.localeCompare(b.name) || a.clientId - b.clientId);
}

/* ---- Quiet mode -------------------------------------------------------------- */

// Quiet mode only hides what y-codemirror.next draws. Its plugin keeps
// publishing the local cursor and receiving remote states, so presence lists,
// follow mode and the mini-map keep working.
const quietCompartment = new Compartment();
const quietTheme = [
  EditorView.editorAttributes.of({ class: "cm-collab-quiet" }),
  EditorView.baseTheme({
    "&.cm-collab-quiet .cm-ySelection, &.cm-collab-quiet .cm-yLineSelection": { backgroundColor: "transparent !important" },
    "&.cm-collab-quiet .cm-ySelectionCaret": { display: "none !important" },
  }),
];

/** Include once in the editor; `initial` true starts in quiet mode. */
export function quietMode(initial = false): Extension {
  return quietCompartment.of(initial ? quietTheme : []);
}

export function setQuietMode(view: EditorView, quiet: boolean) {
  if (isQuietMode(view.state) === quiet) return;
  view.dispatch({ effects: quietCompartment.reconfigure(quiet ? quietTheme : []) });
}

export function isQuietMode(state: EditorState): boolean {
  return quietCompartment.get(state) === quietTheme;
}

/* ---- Follow mode --------------------------------------------------------------- */

/** The followed collaborator's head position, or null when unknown or elsewhere. */
export function followTarget(awareness: Awareness, ytext: Y.Text, clientId: number): number | null {
  const state = awareness.getStates().get(clientId);
  return state ? resolveCursor(state.cursor, ytext)?.head ?? null : null;
}

export interface FollowOptions {
  view: EditorView;
  awareness: Awareness;
  ytext: Y.Text;
  clientId: number;
  /** Called once when following stops (the user acted, the target left, or `stop()`). */
  onStop?: (reason: "stopped" | "user-action" | "target-left") => void;
}

/**
 * Scrolls the view to another user's cursor whenever it moves, without moving
 * the local selection. Following ends when the local user clicks, types or
 * scrolls with the keyboard, or when the followed user leaves.
 */
export function startFollowing({ view, awareness, ytext, clientId, onStop }: FollowOptions): { stop: () => void } {
  let active = true;
  let last: number | null = null;
  const stop = (reason: "stopped" | "user-action" | "target-left") => {
    if (!active) return;
    active = false;
    awareness.off("change", onChange);
    view.dom.removeEventListener("mousedown", onUser, true);
    view.dom.removeEventListener("keydown", onUser, true);
    onStop?.(reason);
  };
  const reveal = () => {
    if (!awareness.getStates().has(clientId)) { stop("target-left"); return; }
    const head = followTarget(awareness, ytext, clientId);
    if (head === null || head === last || head > view.state.doc.length) return;
    last = head;
    // Deferred: awareness changes can arrive while the view is updating.
    queueMicrotask(() => { if (active) view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }); });
  };
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if (removed.includes(clientId)) stop("target-left");
    else if (added.includes(clientId) || updated.includes(clientId)) reveal();
  };
  const onUser = () => stop("user-action");
  awareness.on("change", onChange);
  view.dom.addEventListener("mousedown", onUser, true);
  view.dom.addEventListener("keydown", onUser, true);
  reveal();
  return { stop: () => stop("stopped") };
}
