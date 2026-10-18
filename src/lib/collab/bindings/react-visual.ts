// The Visual (Tiptap) editor on a shared tab (map §7.2, decision D1).
//
// The editor is created empty and the block bridge builds its document from
// the Y.Text, then keeps both in step; nothing on a shared tab calls
// `setContent` on the whole note. The editor calls `attach(editor)` once its
// Tiptap instance exists and `destroy()` when it goes, as the CodeMirror
// editors do with their bindings.

import type { Editor } from "@tiptap/core";
import type { Provenance } from "../protocol/actor";
import { registerUndoScope, type SharedDocSession } from "../client/registry";
import { bindTiptapToYText, type TiptapYTextBridge } from "./tiptap-ytext";

export interface SharedVisualHandle {
  readonly bridge: TiptapYTextBridge;
  /** The shared text right now (the Visual draft of a shared tab). */
  text(): string;
  /** Provenance for the next local change (Libera's own paste and image handlers). */
  setNextProvenance(provenance: Provenance): void;
  destroy(): void;
}

export interface SharedVisualSource {
  readonly docId: string;
  /** Bumps when the content sub-document is rebuilt; key the editor on it. */
  readonly generation: number;
  attach(editor: Editor): SharedVisualHandle;
}

const READ_ONLY_REASON = "This shared note is read-only for you.";

export function sharedVisualSource(session: SharedDocSession, options: { onError?: (error: unknown) => void } = {}): SharedVisualSource {
  const { replica } = session;
  return {
    docId: session.docId,
    generation: replica.getSnapshot().generation,
    attach(editor) {
      const ytext = replica.ytext;
      const readOnlyReason = () => (replica.canEditContent() ? null : READ_ONLY_REASON);
      const bridge = bindTiptapToYText({
        editor,
        ytext,
        awareness: replica.awareness,
        readOnlyReason: readOnlyReason(),
        onError: options.onError,
      });
      // Role, schema and access changes arrive as replica snapshots.
      let last = readOnlyReason();
      const unsubscribe = replica.subscribe(() => {
        const next = readOnlyReason();
        if (next === last) return;
        last = next;
        bridge.setReadOnly(next);
      });
      // AI results, review applies and image insertions undo through this
      // editor's Undo while it is mounted.
      const unregisterUndo = registerUndoScope(replica, bridge.undoManager, () => bridge.flush());
      return {
        bridge,
        text: () => ytext.toString(),
        setNextProvenance: (provenance) => bridge.setNextProvenance(provenance),
        destroy() {
          unregisterUndo();
          unsubscribe();
          bridge.destroy();
        },
      };
    },
  };
}
