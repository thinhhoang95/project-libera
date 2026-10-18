// CodeMirror editors (LaTeX, code, Markdown Source) on a shared tab.
//
// An editor receives a `SharedCodeMirrorSource` and calls `create()` in the
// same layout effect that creates its EditorView, and `destroy()` in that
// effect's cleanup. Creating the binding there, not in render, keeps it
// one-to-one with the view under Strict Mode's double effects and across tab
// switches, while the replica and its undo history live on in the registry.
//
// One controller per replica tracks the views bound to it in this window: it
// applies read-only states (role, newer schema, access changed) to every view,
// and drives quiet mode and follow mode for the presence avatars.

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import { minimalTextChange } from "@/lib/markdown-codemirror/value-sync";
import { quietMode, sectionTracker, setQuietMode, startFollowing } from "../awareness";
import type { DocKind } from "../protocol/schema";
import type { CollabReplica } from "../client/replica";
import type { SharedDocRegistry, SharedDocSession } from "../client/registry";
import { getSharedDocRegistry } from "../client/registry";
import { collabExtension, type CollabBinding } from "./codemirror";

export interface SharedCodeMirrorBinding {
  /** The text the view must start from (the Y.Text right now). */
  readonly initialText: string;
  readonly extension: Extension;
  /** Call with the created view; it reconciles the document and applies read-only and quiet mode. */
  attach(view: EditorView): void;
  destroy(): void;
}

export interface SharedCodeMirrorSource {
  readonly docId: string;
  readonly kind: DocKind;
  /** Bumps when the content sub-document is rebuilt; key the editor on it. */
  readonly generation: number;
  create(): SharedCodeMirrorBinding;
}

type FollowState = { clientId: number; stop: () => void } | null;

/** Views, quiet mode and follow mode of one replica in this window. */
export class SharedEditorController {
  private readonly views = new Map<EditorView, CollabBinding>();
  private lastFocused: EditorView | null = null;
  private quiet = false;
  private following: FollowState = null;
  private readonly listeners = new Set<() => void>();
  private snapshot = { quiet: false, followingClientId: null as number | null, views: 0 };
  private readonly unsubscribe: () => void;

  constructor(private readonly replica: CollabReplica) {
    this.unsubscribe = replica.subscribe(() => this.applyReadOnly());
  }

  /** Whether local content edits are refused (viewer or commenter, schema newer, access changed, closed). */
  get readOnly(): boolean {
    return !this.replica.canEditContent();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = { quiet: this.quiet, followingClientId: this.following?.clientId ?? null, views: this.views.size };
    for (const listener of [...this.listeners]) listener();
  }

  get isQuiet(): boolean { return this.quiet; }

  addView(view: EditorView, binding: CollabBinding) {
    this.views.set(view, binding);
    this.lastFocused ??= view;
    view.dom.addEventListener("focusin", () => { this.lastFocused = view; });
    binding.setReadOnly(view, this.readOnly);
    setQuietMode(view, this.quiet);
    this.emit();
  }

  removeView(view: EditorView) {
    this.views.delete(view);
    if (this.lastFocused === view) this.lastFocused = this.views.keys().next().value ?? null;
    this.emit();
  }

  private applyReadOnly() {
    const readOnly = this.readOnly;
    for (const [view, binding] of this.views) {
      // Deferred when an update is running (a hub message can arrive during a
      // dispatch in tests and in synchronous Electron ports).
      try { binding.setReadOnly(view, readOnly); }
      catch { queueMicrotask(() => { if (this.views.has(view)) binding.setReadOnly(view, this.readOnly); }); }
    }
  }

  setQuiet(quiet: boolean) {
    this.quiet = quiet;
    for (const view of this.views.keys()) setQuietMode(view, quiet);
    this.emit();
  }

  /** Scrolls this window's editor to a collaborator's cursor until the user acts. */
  follow(clientId: number) {
    this.stopFollowing();
    const view = this.lastFocused ?? this.views.keys().next().value;
    if (!view) return;
    const handle = startFollowing({
      view,
      awareness: this.replica.awareness,
      ytext: this.replica.ytext,
      clientId,
      onStop: () => {
        if (this.following?.clientId === clientId) {
          this.following = null;
          this.emit();
        }
      },
    });
    this.following = { clientId, stop: handle.stop };
    this.emit();
  }

  stopFollowing() {
    const current = this.following;
    this.following = null;
    current?.stop();
    if (current) this.emit();
  }

  destroy() {
    this.stopFollowing();
    this.unsubscribe();
    this.listeners.clear();
  }
}

const controllers = new WeakMap<CollabReplica, SharedEditorController>();

export function editorControllerFor(replica: CollabReplica): SharedEditorController {
  let controller = controllers.get(replica);
  if (!controller) {
    controller = new SharedEditorController(replica);
    controllers.set(replica, controller);
  }
  return controller;
}

/**
 * The binding source for a session. Each `create()` makes one
 * y-codemirror.next binding on the session's Y.Text, sharing the session's
 * undo manager (so the history survives remounts) and the window's presence.
 */
export function sharedCodeMirrorSource(session: SharedDocSession, registry: SharedDocRegistry = getSharedDocRegistry()): SharedCodeMirrorSource {
  const { replica } = session;
  const kind = session.resolved.kind;
  return {
    docId: session.docId,
    kind,
    generation: replica.getSnapshot().generation,
    create() {
      const controller = editorControllerFor(replica);
      const ytext = replica.ytext;
      const binding = collabExtension({
        ytext,
        awareness: replica.awareness,
        undoManager: session.undoManager,
        user: registry.localUser,
        readOnly: false,
      });
      let attached: EditorView | null = null;
      return {
        initialText: ytext.toString(),
        extension: [binding.extension, sectionTracker(replica.awareness, kind), quietMode(controller.isQuiet)],
        attach(view) {
          attached = view;
          // y-codemirror.next assumes the view starts equal to the Y.Text. A
          // lazily loaded editor can be created after remote updates arrived,
          // so bring it level without sending anything back.
          const change = minimalTextChange(view.state.doc.toString(), ytext.toString());
          if (change) view.dispatch({ changes: change, annotations: ySyncAnnotation.of(binding.origin) });
          controller.addView(view, binding);
        },
        destroy() {
          if (attached) controller.removeView(attached);
          attached = null;
          binding.destroy();
        },
      };
    },
  };
}
